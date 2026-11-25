/** 역할: 관리자 브랜드·쿠폰·캠페인 레코드의 목록·생성·조회·수정·삭제를 DynamoDB 조건식으로 처리함. */
import { randomUUID } from "node:crypto";
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { documentClient } from "./dynamodb-client.js";
import { jsonResponse } from "./http-response.js";
import { isRecord, parseJsonBody } from "./request-helpers.js";
import { type StoredResource, type OperationRecord } from "./admin-operations-types.js";
import {
  getRecordIdField,
  getRecordIdPrefix,
  readRequestedRecordId,
  readVersion,
  readListLimit,
  encodeCursor,
  decodeCursor,
  isConditionalWriteError,
} from "./admin-operations-values.js";
import {
  parseStoredRecord,
  parseOperationInput,
  createStoredRecord,
  replaceStoredRecord,
  mergeOperationPatch,
  toAdminOperationRecord,
} from "./admin-operations-input.js";

/** 제한된 scan 페이지에서 예상 record type만 반환합니다. 잘못된 item은 노출하지 않습니다. */
export async function listRecords(
  tableName: string,
  resource: StoredResource,
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
) {
  const limit = readListLimit(event.queryStringParameters?.limit);

  if (!limit) {
    return jsonResponse(400, { code: "ADMIN_OPERATION_LIMIT_INVALID" });
  }

  const exclusiveStartKey = decodeCursor(resource, event.queryStringParameters?.cursor);

  if (event.queryStringParameters?.cursor && !exclusiveStartKey) {
    return jsonResponse(400, { code: "ADMIN_OPERATION_CURSOR_INVALID" });
  }

  try {
    const response = await documentClient.send(
      new ScanCommand({
        TableName: tableName,
        Limit: limit,
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    const records = (response.Items ?? [])
      .map((item) => parseStoredRecord(resource, item))
      .filter((record): record is OperationRecord => record !== null)
      .map(toAdminOperationRecord);
    const nextCursor = encodeCursor(resource, response.LastEvaluatedKey);

    return jsonResponse(200, {
      [resource]: records,
      ...(nextCursor ? { nextCursor } : {}),
    });
  } catch {
    return jsonResponse(503, { code: "ADMIN_OPERATION_STORAGE_UNAVAILABLE" });
  }
}

/** 새 record는 임의 ID와 version 1을 생성하며 table primary key 충돌을 조건식으로 차단합니다. */
export async function createRecord(
  tableName: string,
  resource: StoredResource,
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
  userSub: string,
) {
  const body = parseJsonBody(event);
  const input = parseOperationInput(resource, body);

  if (!input || !isRecord(body)) {
    return jsonResponse(400, { code: "ADMIN_OPERATION_BODY_INVALID" });
  }

  const requestedId = readRequestedRecordId(resource, body);

  if (requestedId === null) {
    return jsonResponse(400, { code: "ADMIN_OPERATION_ID_INVALID" });
  }

  const timestamp = new Date().toISOString();
  const record = createStoredRecord(
    resource,
    input,
    requestedId ?? `${getRecordIdPrefix(resource)}_${randomUUID()}`,
    userSub,
    timestamp,
  );

  try {
    await documentClient.send(
      new PutCommand({
        TableName: tableName,
        Item: record,
        ConditionExpression: `attribute_not_exists(${getRecordIdField(resource)})`,
      }),
    );
  } catch (error) {
    if (isConditionalWriteError(error)) {
      return jsonResponse(409, { code: "ADMIN_OPERATION_ID_CONFLICT" });
    }

    return jsonResponse(503, { code: "ADMIN_OPERATION_STORAGE_UNAVAILABLE" });
  }

  return jsonResponse(201, { record: toAdminOperationRecord(record) });
}

/** 한 record의 raw Dynamo item도 parser를 통과해야만 관리자에게 반환합니다. */
export async function getRecord(
  tableName: string,
  resource: StoredResource,
  resourceId: string,
) {
  const record = await readStoredRecord(tableName, resource, resourceId);

  if (record === undefined) {
    return jsonResponse(503, { code: "ADMIN_OPERATION_STORAGE_UNAVAILABLE" });
  }

  if (!record) {
    return jsonResponse(404, { code: "ADMIN_OPERATION_NOT_FOUND" });
  }

  return jsonResponse(200, { record: toAdminOperationRecord(record) });
}

/** PATCH는 현재 record의 allowlist 값을 합친 뒤 version 조건부 Put으로 한 번에 교체합니다. */
export async function updateRecord(
  tableName: string,
  resource: StoredResource,
  resourceId: string,
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
  userSub: string,
) {
  const body = parseJsonBody(event);

  if (!isRecord(body)) {
    return jsonResponse(400, { code: "ADMIN_OPERATION_BODY_INVALID" });
  }

  const expectedVersion = readVersion(body.version);

  if (!expectedVersion) {
    return jsonResponse(400, { code: "ADMIN_OPERATION_VERSION_REQUIRED" });
  }

  const existingRecord = await readStoredRecord(tableName, resource, resourceId);

  if (existingRecord === undefined) {
    return jsonResponse(503, { code: "ADMIN_OPERATION_STORAGE_UNAVAILABLE" });
  }

  if (!existingRecord) {
    return jsonResponse(404, { code: "ADMIN_OPERATION_NOT_FOUND" });
  }

  if (existingRecord.version !== expectedVersion) {
    return jsonResponse(409, {
      code: "ADMIN_OPERATION_VERSION_CONFLICT",
      record: toAdminOperationRecord(existingRecord),
    });
  }

  const input = parseOperationInput(
    resource,
    mergeOperationPatch(existingRecord, body),
  );

  if (!input) {
    return jsonResponse(400, { code: "ADMIN_OPERATION_BODY_INVALID" });
  }

  const updatedRecord = replaceStoredRecord(
    existingRecord,
    input,
    userSub,
    new Date().toISOString(),
  );

  try {
    await documentClient.send(
      new PutCommand({
        TableName: tableName,
        Item: updatedRecord,
        ConditionExpression: "#version = :expectedVersion",
        ExpressionAttributeNames: { "#version": "version" },
        ExpressionAttributeValues: { ":expectedVersion": expectedVersion },
      }),
    );
  } catch (error) {
    if (isConditionalWriteError(error)) {
      return jsonResponse(409, { code: "ADMIN_OPERATION_VERSION_CONFLICT" });
    }

    return jsonResponse(503, { code: "ADMIN_OPERATION_STORAGE_UNAVAILABLE" });
  }

  return jsonResponse(200, { record: toAdminOperationRecord(updatedRecord) });
}

/** 삭제 역시 version 조건식을 요구해 stale 화면의 제거 요청을 안전하게 거절합니다. */
export async function deleteRecord(
  tableName: string,
  resource: StoredResource,
  resourceId: string,
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
) {
  const body = parseJsonBody(event);
  const fromBody = isRecord(body) ? readVersion(body.version) : undefined;
  const fromQuery = readVersion(event.queryStringParameters?.version);
  const expectedVersion = fromBody ?? fromQuery;

  if (!expectedVersion) {
    return jsonResponse(400, { code: "ADMIN_OPERATION_VERSION_REQUIRED" });
  }

  try {
    await documentClient.send(
      new DeleteCommand({
        TableName: tableName,
        Key: { [getRecordIdField(resource)]: resourceId },
        ConditionExpression: "#version = :expectedVersion",
        ExpressionAttributeNames: { "#version": "version" },
        ExpressionAttributeValues: { ":expectedVersion": expectedVersion },
      }),
    );
  } catch (error) {
    if (isConditionalWriteError(error)) {
      return jsonResponse(409, { code: "ADMIN_OPERATION_VERSION_CONFLICT" });
    }

    return jsonResponse(503, { code: "ADMIN_OPERATION_STORAGE_UNAVAILABLE" });
  }

  return jsonResponse(200, { deletedRecordId: resourceId });
}

/** primary key strong read 후 해당 table의 recordType까지 검증합니다. */
async function readStoredRecord(
  tableName: string,
  resource: StoredResource,
  resourceId: string,
) {
  try {
    const response = await documentClient.send(
      new GetCommand({
        TableName: tableName,
        Key: { [getRecordIdField(resource)]: resourceId },
        ConsistentRead: true,
      }),
    );

    return parseStoredRecord(resource, response.Item);
  } catch {
    return undefined;
  }
}
