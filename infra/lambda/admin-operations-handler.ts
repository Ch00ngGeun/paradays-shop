/**
 * 역할: 관리자 전용 브랜드·쿠폰·마케팅 캠페인 운영 데이터를 관리함.
 * 기능: 각 도메인의 고정 enum·입력 제한·낙관적 버전을 적용하고 원본 Dynamo 속성은 응답에서 제외함.
 */

import { randomUUID } from "node:crypto";
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from "aws-lambda";

import { authorizeAdmin } from "./admin-auth.js";
import { documentClient, getRequiredEnvironment } from "./dynamodb-client.js";
import { jsonResponse } from "./http-response.js";
import { isRecord, parseJsonBody, readBoundedString } from "./request-helpers.js";

type OperationResource = "brands" | "coupons" | "campaigns" | "members";
type StoredResource = Exclude<OperationResource, "members">;
type BrandStatus = "ACTIVE" | "ARCHIVED";
type CouponStatus = "DRAFT" | "ACTIVE" | "PAUSED";
type CouponDiscountType = "PERCENT" | "AMOUNT";
type CampaignStatus = "DRAFT" | "SCHEDULED" | "PAUSED";
type CampaignChannel = "EMAIL" | "SMS" | "PUSH";

type BaseOperationRecord = Readonly<{
  version: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
}>;

type BrandRecord = BaseOperationRecord &
  Readonly<{
    recordType: "BRAND";
    brandId: string;
    name: string;
    slug: string;
    memo?: string;
    description?: string;
    logoUrl?: string;
    status: BrandStatus;
  }>;

type CouponRecord = BaseOperationRecord &
  Readonly<{
    recordType: "COUPON";
    couponId: string;
    name: string;
    code: string;
    discountType: CouponDiscountType;
    discountValue: number;
    minimumOrderAmount: number;
    maximumDiscountAmount?: number;
    startsAt?: string;
    expiresAt?: string;
    status: CouponStatus;
    usageLimit?: number;
    perMemberLimit?: number;
  }>;

type CampaignRecord = BaseOperationRecord &
  Readonly<{
    recordType: "CAMPAIGN";
    campaignId: string;
    title: string;
    channels: readonly CampaignChannel[];
    audience: "MARKETING_CONSENTED";
    subject?: string;
    body: string;
    status: CampaignStatus;
    scheduledAt?: string;
  }>;

type OperationRecord = BrandRecord | CouponRecord | CampaignRecord;

type BrandInput = Omit<
  BrandRecord,
  "brandId" | "recordType" | keyof BaseOperationRecord
>;
type CouponInput = Omit<
  CouponRecord,
  "couponId" | "recordType" | keyof BaseOperationRecord
>;
type CampaignInput = Omit<
  CampaignRecord,
  "campaignId" | "recordType" | keyof BaseOperationRecord
>;
type OperationInput = BrandInput | CouponInput | CampaignInput;

type OperationRoute = Readonly<{
  resource: OperationResource;
  resourceId?: string;
}>;

const RECORD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,96}$/;
const MAX_KRW_AMOUNT = 100_000_000;
const MAX_USAGE_LIMIT = 1_000_000;
const MAX_CAMPAIGN_MESSAGE_LENGTH = 8_000;

/** /admin/{brands,coupons,campaigns,members} route를 admin group 검증 뒤 처리합니다. */
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> {
  const authorization = await authorizeAdmin(event);

  if (!authorization.ok) {
    return jsonResponse(authorization.statusCode, { code: authorization.code });
  }

  const route = resolveOperationRoute(event);

  if (!route) {
    return jsonResponse(404, { code: "ADMIN_OPERATION_ROUTE_NOT_FOUND" });
  }

  if (route.resource === "members") {
    return memberDirectoryUnavailable(event.requestContext.http.method);
  }

  let tableName: string;

  try {
    tableName = getRequiredEnvironment(getTableEnvironmentName(route.resource));
  } catch {
    return jsonResponse(503, {
      code: `${route.resource.slice(0, -1).toUpperCase()}_CONFIGURATION_UNAVAILABLE`,
    });
  }

  const method = event.requestContext.http.method;

  if (!route.resourceId) {
    if (method === "GET") {
      return listRecords(tableName, route.resource, event);
    }

    if (method === "POST") {
      return createRecord(tableName, route.resource, event, authorization.userSub);
    }

    return jsonResponse(405, { code: "METHOD_NOT_ALLOWED" });
  }

  if (method === "GET") {
    return getRecord(tableName, route.resource, route.resourceId);
  }

  if (method === "PATCH") {
    return updateRecord(
      tableName,
      route.resource,
      route.resourceId,
      event,
      authorization.userSub,
    );
  }

  if (method === "DELETE") {
    return deleteRecord(tableName, route.resource, route.resourceId, event);
  }

  return jsonResponse(405, { code: "METHOD_NOT_ALLOWED" });
}

/** Cognito Identity Provider SDK/권한이 아직 연결되지 않았으므로 회원 PII나 가짜 회원을 절대 반환하지 않습니다. */
function memberDirectoryUnavailable(method: string) {
  if (method !== "GET" && method !== "PATCH") {
    return jsonResponse(405, { code: "METHOD_NOT_ALLOWED" });
  }

  return jsonResponse(503, {
    code: "MEMBER_DIRECTORY_CONFIGURATION_UNAVAILABLE",
    message: "Cognito member-directory integration is not configured.",
  });
}

/** 제한된 scan 페이지에서 예상 record type만 반환합니다. 잘못된 item은 노출하지 않습니다. */
async function listRecords(
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
async function createRecord(
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
async function getRecord(
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
async function updateRecord(
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
async function deleteRecord(
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

function parseStoredRecord(
  resource: StoredResource,
  value: unknown,
): OperationRecord | null {
  if (resource === "brands") {
    return isBrandRecord(value) ? value : null;
  }

  if (resource === "coupons") {
    return isCouponRecord(value) ? value : null;
  }

  return isCampaignRecord(value) ? value : null;
}

/** body에서 resource별 고정 도메인 값을 읽습니다. unknown 속성은 저장하지 않습니다. */
function parseOperationInput(
  resource: StoredResource,
  body: unknown,
): OperationInput | null {
  if (resource === "brands") {
    return parseBrandInput(body);
  }

  if (resource === "coupons") {
    return parseCouponInput(body);
  }

  return parseCampaignInput(body);
}

function parseBrandInput(body: unknown): BrandInput | null {
  if (!isRecord(body)) {
    return null;
  }

  const name = readBoundedString(body.name, 100);
  const suppliedSlug = hasOwn(body, "slug")
    ? readBoundedString(body.slug, 120)
    : undefined;
  const slug = normalizeSlug(suppliedSlug ?? name ?? "");
  const memo = readOptionalText(body, "memo", 1_000);
  const description = readOptionalText(body, "description", 1_000);
  const logoUrl = readOptionalUrl(body, "logoUrl");
  const status = hasOwn(body, "status") ? readBrandStatus(body.status) : "ACTIVE";

  if (
    !name ||
    !slug ||
    memo === null ||
    description === null ||
    logoUrl === null ||
    !status
  ) {
    return null;
  }

  return {
    name,
    slug,
    ...(memo ? { memo } : {}),
    ...(description ? { description } : {}),
    ...(logoUrl ? { logoUrl } : {}),
    status,
  };
}

function parseCouponInput(body: unknown): CouponInput | null {
  if (!isRecord(body)) {
    return null;
  }

  const name = readBoundedString(body.name, 120);
  const code = normalizeCouponCode(body.code);
  const discountType = readCouponDiscountType(
    hasOwn(body, "discountType") ? body.discountType : body.type,
  );
  const discountValue = readKrwOrPercentAmount(body.discountValue ?? body.value);
  const minimumOrderAmount = hasOwn(body, "minimumOrderAmount")
    ? readKrwOrPercentAmount(body.minimumOrderAmount)
    : 0;
  const maximumDiscountAmount = readOptionalAmount(body, "maximumDiscountAmount");
  const startsAt = readOptionalDate(body, "startsAt");
  const expiresAt = hasOwn(body, "expiresAt")
    ? readOptionalDate(body, "expiresAt")
    : readOptionalDate(body, "endsAt");
  const status = hasOwn(body, "status") ? readCouponStatus(body.status) : "DRAFT";
  const usageLimit = readOptionalPositiveInteger(body, "usageLimit", MAX_USAGE_LIMIT);
  const perMemberLimit = readOptionalPositiveInteger(body, "perMemberLimit", 100);

  if (
    !name ||
    !code ||
    !discountType ||
    discountValue === undefined ||
    minimumOrderAmount === undefined ||
    maximumDiscountAmount === null ||
    startsAt === null ||
    expiresAt === null ||
    !status ||
    usageLimit === null ||
    perMemberLimit === null
  ) {
    return null;
  }

  if (
    (discountType === "PERCENT" && (discountValue < 1 || discountValue > 100)) ||
    (discountType === "AMOUNT" && discountValue < 1) ||
    (startsAt && expiresAt && startsAt >= expiresAt)
  ) {
    return null;
  }

  return {
    name,
    code,
    discountType,
    discountValue,
    minimumOrderAmount,
    ...(maximumDiscountAmount ? { maximumDiscountAmount } : {}),
    ...(startsAt ? { startsAt } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    status,
    ...(usageLimit ? { usageLimit } : {}),
    ...(perMemberLimit ? { perMemberLimit } : {}),
  };
}

function parseCampaignInput(body: unknown): CampaignInput | null {
  if (!isRecord(body)) {
    return null;
  }

  const title = readBoundedString(hasOwn(body, "title") ? body.title : body.name, 160);
  const channels = readCampaignChannels(body.channels);
  const audience = hasOwn(body, "audience") ? body.audience : "MARKETING_CONSENTED";
  const subject = readOptionalText(body, "subject", 200);
  const bodyText = readBoundedString(
    hasOwn(body, "body")
      ? body.body
      : hasOwn(body, "message")
        ? body.message
        : body.content,
    MAX_CAMPAIGN_MESSAGE_LENGTH,
  );
  const status = hasOwn(body, "status") ? readCampaignStatus(body.status) : "DRAFT";
  const scheduledAt = readOptionalDate(body, "scheduledAt");

  if (
    !title ||
    !channels ||
    audience !== "MARKETING_CONSENTED" ||
    subject === null ||
    !bodyText ||
    !status ||
    scheduledAt === null
  ) {
    return null;
  }

  if (status === "SCHEDULED" && !scheduledAt) {
    return null;
  }

  return {
    title,
    channels,
    audience,
    ...(subject ? { subject } : {}),
    body: bodyText,
    status,
    ...(scheduledAt ? { scheduledAt } : {}),
  };
}

function createStoredRecord(
  resource: StoredResource,
  input: OperationInput,
  resourceId: string,
  userSub: string,
  timestamp: string,
): OperationRecord {
  const auditFields: BaseOperationRecord = {
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    createdBy: userSub,
    updatedBy: userSub,
  };

  if (resource === "brands" && isBrandInput(input)) {
    return { recordType: "BRAND", brandId: resourceId, ...input, ...auditFields };
  }

  if (resource === "coupons" && isCouponInput(input)) {
    return { recordType: "COUPON", couponId: resourceId, ...input, ...auditFields };
  }

  if (resource === "campaigns" && isCampaignInput(input)) {
    return {
      recordType: "CAMPAIGN",
      campaignId: resourceId,
      ...input,
      ...auditFields,
    };
  }

  throw new Error("OPERATION_RESOURCE_INPUT_MISMATCH");
}

function replaceStoredRecord(
  existingRecord: OperationRecord,
  input: OperationInput,
  userSub: string,
  timestamp: string,
): OperationRecord {
  const auditFields: BaseOperationRecord = {
    version: existingRecord.version + 1,
    createdAt: existingRecord.createdAt,
    updatedAt: timestamp,
    createdBy: existingRecord.createdBy,
    updatedBy: userSub,
  };

  if (existingRecord.recordType === "BRAND" && isBrandInput(input)) {
    return {
      recordType: "BRAND",
      brandId: existingRecord.brandId,
      ...input,
      ...auditFields,
    };
  }

  if (existingRecord.recordType === "COUPON" && isCouponInput(input)) {
    return {
      recordType: "COUPON",
      couponId: existingRecord.couponId,
      ...input,
      ...auditFields,
    };
  }

  if (existingRecord.recordType === "CAMPAIGN" && isCampaignInput(input)) {
    return {
      recordType: "CAMPAIGN",
      campaignId: existingRecord.campaignId,
      ...input,
      ...auditFields,
    };
  }

  throw new Error("OPERATION_RECORD_INPUT_MISMATCH");
}

/** 기존 record를 request aliases가 통하는 완전한 input 객체로 바꾼 뒤 patch allowlist만 반영합니다. */
function mergeOperationPatch(
  record: OperationRecord,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  if (record.recordType === "BRAND") {
    return mergeAllowlistedPatch(
      {
        name: record.name,
        slug: record.slug,
        memo: record.memo ?? null,
        description: record.description ?? null,
        logoUrl: record.logoUrl ?? null,
        status: record.status,
      },
      patch,
      ["name", "slug", "memo", "description", "logoUrl", "status"],
    );
  }

  if (record.recordType === "COUPON") {
    return mergeAllowlistedPatch(
      {
        name: record.name,
        code: record.code,
        discountType: record.discountType,
        discountValue: record.discountValue,
        minimumOrderAmount: record.minimumOrderAmount,
        maximumDiscountAmount: record.maximumDiscountAmount ?? null,
        startsAt: record.startsAt ?? null,
        expiresAt: record.expiresAt ?? null,
        status: record.status,
        usageLimit: record.usageLimit ?? null,
        perMemberLimit: record.perMemberLimit ?? null,
      },
      patch,
      [
        "name",
        "code",
        "discountType",
        "discountValue",
        "minimumOrderAmount",
        "maximumDiscountAmount",
        "startsAt",
        "expiresAt",
        "status",
        "usageLimit",
        "perMemberLimit",
      ],
      {
        type: "discountType",
        value: "discountValue",
        endsAt: "expiresAt",
      },
    );
  }

  return mergeAllowlistedPatch(
    {
      title: record.title,
      channels: record.channels,
      audience: record.audience,
      subject: record.subject ?? null,
      body: record.body,
      status: record.status,
      scheduledAt: record.scheduledAt ?? null,
    },
    patch,
    ["title", "channels", "audience", "subject", "body", "status", "scheduledAt"],
    { name: "title", message: "body", content: "body" },
  );
}

function mergeAllowlistedPatch(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
  fields: readonly string[],
  aliases: Record<string, string> = {},
) {
  const merged = { ...base };

  for (const field of fields) {
    if (hasOwn(patch, field)) {
      merged[field] = patch[field];
    }
  }

  for (const [alias, field] of Object.entries(aliases)) {
    if (hasOwn(patch, alias) && !hasOwn(patch, field)) {
      merged[field] = patch[alias];
    }
  }

  return merged;
}

/** 저장 record에는 recordType별 safe response를 만들며 작성자 subject 등은 항상 빼고 반환합니다. */
function toAdminOperationRecord(record: OperationRecord): Record<string, unknown> {
  if (record.recordType === "BRAND") {
    return {
      brandId: record.brandId,
      name: record.name,
      slug: record.slug,
      ...(record.memo ? { memo: record.memo } : {}),
      ...(record.description ? { description: record.description } : {}),
      ...(record.logoUrl ? { logoUrl: record.logoUrl } : {}),
      status: record.status,
      version: record.version,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  if (record.recordType === "COUPON") {
    return {
      couponId: record.couponId,
      name: record.name,
      code: record.code,
      discountType: record.discountType,
      discountValue: record.discountValue,
      minimumOrderAmount: record.minimumOrderAmount,
      ...(record.maximumDiscountAmount
        ? { maximumDiscountAmount: record.maximumDiscountAmount }
        : {}),
      ...(record.startsAt ? { startsAt: record.startsAt } : {}),
      ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}),
      status: record.status,
      ...(record.usageLimit ? { usageLimit: record.usageLimit } : {}),
      ...(record.perMemberLimit ? { perMemberLimit: record.perMemberLimit } : {}),
      version: record.version,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  return {
    campaignId: record.campaignId,
    title: record.title,
    channels: [...record.channels],
    audience: record.audience,
    ...(record.subject ? { subject: record.subject } : {}),
    body: record.body,
    status: record.status,
    ...(record.scheduledAt ? { scheduledAt: record.scheduledAt } : {}),
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function isBrandRecord(value: unknown): value is BrandRecord {
  return (
    isBaseOperationRecord(value) &&
    value.recordType === "BRAND" &&
    isRecordId(value.brandId) &&
    typeof value.name === "string" &&
    typeof value.slug === "string" &&
    (value.memo === undefined || typeof value.memo === "string") &&
    (value.description === undefined || typeof value.description === "string") &&
    (value.logoUrl === undefined || typeof value.logoUrl === "string") &&
    isBrandStatus(value.status)
  );
}

function isCouponRecord(value: unknown): value is CouponRecord {
  return (
    isBaseOperationRecord(value) &&
    value.recordType === "COUPON" &&
    isRecordId(value.couponId) &&
    typeof value.name === "string" &&
    typeof value.code === "string" &&
    isCouponDiscountType(value.discountType) &&
    isKrwOrPercentAmount(value.discountValue) &&
    isKrwOrPercentAmount(value.minimumOrderAmount) &&
    (value.maximumDiscountAmount === undefined ||
      isKrwOrPercentAmount(value.maximumDiscountAmount)) &&
    (value.startsAt === undefined || typeof value.startsAt === "string") &&
    (value.expiresAt === undefined || typeof value.expiresAt === "string") &&
    isCouponStatus(value.status) &&
    (value.usageLimit === undefined ||
      isPositiveInteger(value.usageLimit, MAX_USAGE_LIMIT)) &&
    (value.perMemberLimit === undefined || isPositiveInteger(value.perMemberLimit, 100))
  );
}

function isCampaignRecord(value: unknown): value is CampaignRecord {
  return (
    isBaseOperationRecord(value) &&
    value.recordType === "CAMPAIGN" &&
    isRecordId(value.campaignId) &&
    typeof value.title === "string" &&
    isCampaignChannelArray(value.channels) &&
    value.audience === "MARKETING_CONSENTED" &&
    (value.subject === undefined || typeof value.subject === "string") &&
    typeof value.body === "string" &&
    isCampaignStatus(value.status) &&
    (value.scheduledAt === undefined || typeof value.scheduledAt === "string")
  );
}

function isBaseOperationRecord(
  value: unknown,
): value is BaseOperationRecord & Record<string, unknown> {
  return (
    isRecord(value) &&
    typeof value.version === "number" &&
    Number.isSafeInteger(value.version) &&
    value.version > 0 &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    typeof value.createdBy === "string" &&
    typeof value.updatedBy === "string"
  );
}

function isBrandInput(value: OperationInput): value is BrandInput {
  return "slug" in value && "name" in value && !("code" in value);
}

function isCouponInput(value: OperationInput): value is CouponInput {
  return "code" in value && "discountType" in value;
}

function isCampaignInput(value: OperationInput): value is CampaignInput {
  return "channels" in value && "body" in value;
}

function resolveOperationRoute(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): OperationRoute | null {
  const rawPath = event.rawPath.replace(/\/+$/, "") || "/";
  const match = rawPath.match(
    /^\/admin\/(?:operations\/)?(brands|coupons|campaigns|members)(?:\/([^/]+))?$/,
  );

  if (!match) {
    return null;
  }

  const resource = match[1] as OperationResource;
  const pathParameterNames: Record<StoredResource, string> = {
    brands: "brandId",
    coupons: "couponId",
    campaigns: "campaignId",
  };
  const encodedId =
    resource === "members"
      ? (event.pathParameters?.userSub ?? match[2])
      : (event.pathParameters?.[pathParameterNames[resource]] ?? match[2]);

  if (!encodedId) {
    return { resource };
  }

  let resourceId: string;

  try {
    resourceId = decodeURIComponent(encodedId);
  } catch {
    return null;
  }

  if (resource === "members") {
    return { resource, resourceId };
  }

  return isRecordId(resourceId) ? { resource, resourceId } : null;
}

function getTableEnvironmentName(resource: StoredResource) {
  const names: Record<StoredResource, string> = {
    brands: "BRAND_TABLE_NAME",
    coupons: "COUPON_TABLE_NAME",
    campaigns: "CAMPAIGN_TABLE_NAME",
  };

  return names[resource];
}

function getRecordIdField(resource: StoredResource) {
  const names: Record<StoredResource, string> = {
    brands: "brandId",
    coupons: "couponId",
    campaigns: "campaignId",
  };

  return names[resource];
}

function getRecordIdPrefix(resource: StoredResource) {
  const prefixes: Record<StoredResource, string> = {
    brands: "brand",
    coupons: "coupon",
    campaigns: "campaign",
  };

  return prefixes[resource];
}

function readRequestedRecordId(
  resource: StoredResource,
  body: Record<string, unknown>,
): string | undefined | null {
  const field = getRecordIdField(resource);

  if (!hasOwn(body, field)) {
    return undefined;
  }

  return isRecordId(body[field]) ? body[field] : null;
}

function normalizeSlug(value: string) {
  const normalized = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);

  return normalized && /^[a-z0-9가-힣][a-z0-9가-힣-]*$/.test(normalized)
    ? normalized
    : undefined;
}

function normalizeCouponCode(value: unknown) {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toUpperCase();

  return /^[A-Z0-9][A-Z0-9_-]{2,31}$/.test(normalized) ? normalized : undefined;
}

function readBrandStatus(value: unknown): BrandStatus | undefined {
  return value === "ACTIVE" || value === "ARCHIVED" ? value : undefined;
}

function isBrandStatus(value: unknown): value is BrandStatus {
  return readBrandStatus(value) !== undefined;
}

function readCouponStatus(value: unknown): CouponStatus | undefined {
  return value === "DRAFT" || value === "ACTIVE" || value === "PAUSED"
    ? value
    : undefined;
}

function isCouponStatus(value: unknown): value is CouponStatus {
  return readCouponStatus(value) !== undefined;
}

function readCouponDiscountType(value: unknown): CouponDiscountType | undefined {
  if (value === "PERCENT" || value === "AMOUNT") {
    return value;
  }

  // Earlier internal drafts used FIXED_AMOUNT. Keep reads compatible while
  // persisting the public admin API's AMOUNT vocabulary from now on.
  return value === "FIXED_AMOUNT" ? "AMOUNT" : undefined;
}

function isCouponDiscountType(value: unknown): value is CouponDiscountType {
  return readCouponDiscountType(value) !== undefined;
}

function readCampaignStatus(value: unknown): CampaignStatus | undefined {
  return value === "DRAFT" || value === "SCHEDULED" || value === "PAUSED"
    ? value
    : undefined;
}

function isCampaignStatus(value: unknown): value is CampaignStatus {
  return readCampaignStatus(value) !== undefined;
}

function readCampaignChannels(value: unknown): readonly CampaignChannel[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 3) {
    return undefined;
  }

  const channels = value.filter(
    (channel): channel is CampaignChannel =>
      channel === "EMAIL" || channel === "SMS" || channel === "PUSH",
  );

  return channels.length === value.length && new Set(channels).size === channels.length
    ? channels
    : undefined;
}

function isCampaignChannelArray(value: unknown): value is readonly CampaignChannel[] {
  return readCampaignChannels(value) !== undefined;
}

function readKrwOrPercentAmount(value: unknown): number | undefined {
  if (typeof value === "number") {
    return isKrwOrPercentAmount(value) ? value : undefined;
  }

  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());

    return isKrwOrPercentAmount(parsed) ? parsed : undefined;
  }

  return undefined;
}

function isKrwOrPercentAmount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_KRW_AMOUNT
  );
}

function readOptionalAmount(
  body: Record<string, unknown>,
  field: string,
): number | undefined | null {
  if (!hasOwn(body, field) || body[field] === null || body[field] === "") {
    return undefined;
  }

  return readKrwOrPercentAmount(body[field]) ?? null;
}

function readOptionalPositiveInteger(
  body: Record<string, unknown>,
  field: string,
  maximum: number,
): number | undefined | null {
  if (!hasOwn(body, field) || body[field] === null || body[field] === "") {
    return undefined;
  }

  const value = readKrwOrPercentAmount(body[field]);

  return value !== undefined && isPositiveInteger(value, maximum) ? value : null;
}

function isPositiveInteger(value: unknown, maximum: number): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= maximum
  );
}

function readOptionalText(
  body: Record<string, unknown>,
  field: string,
  maximumLength: number,
): string | undefined | null {
  if (!hasOwn(body, field) || body[field] === null || body[field] === "") {
    return undefined;
  }

  return readBoundedString(body[field], maximumLength) ?? null;
}

function readOptionalUrl(
  body: Record<string, unknown>,
  field: string,
): string | undefined | null {
  if (!hasOwn(body, field) || body[field] === null || body[field] === "") {
    return undefined;
  }

  const value = readBoundedString(body[field], 2_048);

  return value && isSafeAssetUrl(value) ? value : null;
}

function isSafeAssetUrl(value: string) {
  if (value.startsWith("/")) {
    return (
      !value.startsWith("//") && !value.includes("\\") && !value.includes("\u0000")
    );
  }

  try {
    const url = new URL(value);

    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function readOptionalDate(
  body: Record<string, unknown>,
  field: string,
): string | undefined | null {
  if (!hasOwn(body, field) || body[field] === null || body[field] === "") {
    return undefined;
  }

  const source = readBoundedString(body[field], 64);

  if (!source) {
    return null;
  }

  const timestamp = Date.parse(source);

  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function readVersion(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value.trim())
        ? Number(value.trim())
        : NaN;

  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function readListLimit(value: unknown) {
  if (value === undefined) {
    return 50;
  }

  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;

  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 100
    ? parsed
    : undefined;
}

function encodeCursor(resource: StoredResource, value: unknown) {
  const idField = getRecordIdField(resource);

  if (!isRecord(value) || !isRecordId(value[idField])) {
    return undefined;
  }

  return Buffer.from(JSON.stringify({ [idField]: value[idField] })).toString(
    "base64url",
  );
}

function decodeCursor(resource: StoredResource, value: unknown) {
  if (typeof value !== "string" || value.length > 512) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    );
    const idField = getRecordIdField(resource);

    return isRecord(parsed) && isRecordId(parsed[idField])
      ? { [idField]: parsed[idField] }
      : undefined;
  } catch {
    return undefined;
  }
}

function isRecordId(value: unknown): value is string {
  return typeof value === "string" && RECORD_ID_PATTERN.test(value);
}

function hasOwn(value: Record<string, unknown>, field: string) {
  return Object.prototype.hasOwnProperty.call(value, field);
}

function isConditionalWriteError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "ConditionalCheckFailedException"
  );
}
