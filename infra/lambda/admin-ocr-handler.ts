/**
 * 역할: 관리자 입고표 OCR 요청과 수정 검토본을 안전하게 보관합니다.
 * 기능: PaddleOCR secret·원본 이미지는 Lambda 경계 밖으로 노출하거나 저장하지 않고,
 *       짧은 TTL의 텍스트 검토 job만 DynamoDB에 기록합니다.
 */

import { randomUUID } from "node:crypto";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from "aws-lambda";

import { authorizeAdmin } from "./admin-auth.js";
import { documentClient, getRequiredEnvironment } from "./dynamodb-client.js";
import { jsonResponse } from "./http-response.js";
import {
  getPaddleOcrCredentials,
  MAX_INLINE_OCR_IMAGE_BYTES,
  PaddleOcrProviderError,
  parseOcrImageUpload,
  recognizePaddleOcr,
  type OcrBoundingBox,
  type OcrRecognitionRow,
} from "./paddle-ocr.js";
import { isRecord, parseJsonBody } from "./request-helpers.js";

const OCR_JOB_TTL_SECONDS = 7 * 24 * 60 * 60;
export const MAX_OCR_JOB_STORAGE_BYTES = 380 * 1024;
const MAX_JOB_ROWS = 500;
const MAX_RAW_TEXT_LENGTH = 100_000;
const MAX_SOURCE_TEXT_LENGTH = 1_000;
const MAX_PRODUCT_NAME_LENGTH = 240;
const MAX_BRAND_LENGTH = 100;
const MAX_OPTION_LENGTH = 200;
const MAX_QUANTITY_LENGTH = 12;
const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/;
const ROW_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

type OcrJobRoute =
  | Readonly<{ kind: "collection" }>
  | Readonly<{ kind: "item"; jobId: string }>;

/** OCR provider가 읽은 위치·신뢰도와 운영자가 수정한 입고 필드를 함께 보존합니다. */
type OcrJobRow = Readonly<{
  id: string;
  sourceText: string;
  confidence?: number;
  box?: OcrBoundingBox;
  productName?: string;
  brand?: string;
  option?: string;
  quantity?: string;
}>;

/** DynamoDB TTL은 epoch 초 단위입니다. 이미지 bytes는 이 record에 절대 넣지 않습니다. */
type OcrJobRecord = Readonly<{
  recordType: "OCR_JOB";
  jobId: string;
  createdBy: string;
  updatedBy: string;
  version: number;
  rawText: string;
  rows: readonly OcrJobRow[];
  createdAt: string;
  updatedAt: string;
  expiresAt: number;
}>;

type OcrReviewedRow = Readonly<{
  id: string;
  sourceText: string;
  productName: string;
  brand: string;
  option: string;
  quantity: string;
}>;

/**
 * POST /admin/ocr/jobs는 admin만 생성할 수 있습니다.
 * 모든 읽기·수정은 현재 Cognito admin group을 요구합니다.
 */
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> {
  const route = resolveOcrRoute(event);

  if (!route) {
    return jsonResponse(404, { code: "ADMIN_OCR_ROUTE_NOT_FOUND" });
  }

  const method = event.requestContext.http.method;
  const writeAuthorization = method === "GET" ? undefined : await authorizeAdmin(event);

  // POST/PATCH는 provider/table 설정을 읽기 전에 먼저 admin group을 확인합니다.
  if (writeAuthorization && !writeAuthorization.ok) {
    return jsonResponse(writeAuthorization.statusCode, {
      code: writeAuthorization.code,
    });
  }

  let jobTableName: string;

  try {
    jobTableName = getRequiredEnvironment("OCR_JOB_TABLE_NAME");
  } catch {
    return jsonResponse(503, { code: "OCR_JOB_CONFIGURATION_UNAVAILABLE" });
  }

  if (route.kind === "collection") {
    if (method !== "POST") {
      return jsonResponse(405, { code: "METHOD_NOT_ALLOWED" });
    }

    if (!writeAuthorization || !writeAuthorization.ok) {
      return jsonResponse(403, { code: "ADMIN_ROLE_REQUIRED" });
    }

    return createOcrJob(jobTableName, event, writeAuthorization.userSub);
  }

  if (method === "GET") {
    const authorization = await authorizeAdmin(event);

    if (!authorization.ok) {
      return jsonResponse(authorization.statusCode, { code: authorization.code });
    }

    return getOcrJob(jobTableName, route.jobId);
  }

  if (method === "PATCH") {
    if (!writeAuthorization || !writeAuthorization.ok) {
      return jsonResponse(403, { code: "ADMIN_ROLE_REQUIRED" });
    }

    return updateOcrJob(jobTableName, route.jobId, event, writeAuthorization.userSub);
  }

  return jsonResponse(405, { code: "METHOD_NOT_ALLOWED" });
}

/** OCR provider 호출은 성공한 검토 가능한 텍스트만 기록하고, imageBase64는 즉시 참조를 잃습니다. */
async function createOcrJob(
  jobTableName: string,
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
  userSub: string,
): Promise<APIGatewayProxyResultV2> {
  const parsedImage = parseOcrImageUpload(parseJsonBody(event));

  if (!parsedImage.ok) {
    return parsedImage.code === "OCR_IMAGE_TOO_LARGE"
      ? jsonResponse(413, {
          code: "OCR_IMAGE_TOO_LARGE",
          maxBytes: MAX_INLINE_OCR_IMAGE_BYTES,
        })
      : jsonResponse(400, { code: "OCR_IMAGE_INVALID" });
  }

  const image = parsedImage.image;

  let secretArn: string;

  try {
    secretArn = getRequiredEnvironment("PADDLE_OCR_SECRET_ARN");
  } catch {
    return jsonResponse(503, { code: "OCR_PROVIDER_CONFIGURATION_UNAVAILABLE" });
  }

  let recognition: Readonly<{ rawText: string; rows: readonly OcrRecognitionRow[] }>;

  try {
    const credentials = await getPaddleOcrCredentials(secretArn);
    recognition = await recognizePaddleOcr(credentials, image);
  } catch (error) {
    return providerFailureResponse(error);
  }

  const rows = toStoredRecognitionRows(recognition.rows);

  if (!rows || !isBoundedRawText(recognition.rawText)) {
    return jsonResponse(502, { code: "OCR_PROVIDER_RESPONSE_INVALID" });
  }

  const timestamp = new Date().toISOString();
  const job: OcrJobRecord = {
    recordType: "OCR_JOB",
    jobId: `ocr_${randomUUID()}`,
    createdBy: userSub,
    updatedBy: userSub,
    version: 1,
    rawText: recognition.rawText,
    rows,
    createdAt: timestamp,
    updatedAt: timestamp,
    expiresAt: Math.floor(Date.now() / 1_000) + OCR_JOB_TTL_SECONDS,
  };

  if (estimateOcrJobStorageBytes(job) > MAX_OCR_JOB_STORAGE_BYTES) {
    return jsonResponse(413, { code: "OCR_JOB_TOO_LARGE" });
  }

  try {
    await documentClient.send(
      new PutCommand({
        TableName: jobTableName,
        Item: job,
        ConditionExpression: "attribute_not_exists(jobId)",
      }),
    );
  } catch (error) {
    if (isConditionalWriteError(error)) {
      return jsonResponse(409, { code: "OCR_JOB_ID_CONFLICT" });
    }

    return jsonResponse(503, { code: "OCR_JOB_STORAGE_UNAVAILABLE" });
  }

  return jsonResponse(201, { job: toPublicOcrJob(job) });
}

/** OCR 결과에는 상품명·재고가 포함될 수 있으므로 현재 admin만 조회합니다. */
async function getOcrJob(
  jobTableName: string,
  jobId: string,
): Promise<APIGatewayProxyResultV2> {
  const job = await readOcrJob(jobTableName, jobId);

  if (job === undefined) {
    return jsonResponse(503, { code: "OCR_JOB_STORAGE_UNAVAILABLE" });
  }

  if (!job) {
    return jsonResponse(404, { code: "OCR_JOB_NOT_FOUND" });
  }

  return jsonResponse(200, { job: toPublicOcrJob(job) });
}

/** 검토 rows는 version이 같은 경우에만 저장하여 동시 편집이 최신 결과를 덮어쓰지 않게 합니다. */
async function updateOcrJob(
  jobTableName: string,
  jobId: string,
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
  userSub: string,
): Promise<APIGatewayProxyResultV2> {
  const body = parseJsonBody(event);

  if (!isRecord(body)) {
    return jsonResponse(400, { code: "OCR_JOB_BODY_INVALID" });
  }

  const expectedVersion = readVersion(body.version);
  const reviewedRows = parseReviewedRows(body.rows);
  const reviewedRawText = body.rawText;

  if (!expectedVersion) {
    return jsonResponse(400, { code: "OCR_JOB_VERSION_REQUIRED" });
  }

  if (!reviewedRows) {
    return jsonResponse(400, { code: "OCR_JOB_ROWS_INVALID" });
  }

  // Preserve the exact edited text (including empty strings and whitespace).
  // Omission keeps the old text; this shares the stored rawText validation.
  if (reviewedRawText !== undefined && !isBoundedRawText(reviewedRawText)) {
    return jsonResponse(400, { code: "OCR_JOB_RAW_TEXT_INVALID" });
  }

  const existingJob = await readOcrJob(jobTableName, jobId);

  if (existingJob === undefined) {
    return jsonResponse(503, { code: "OCR_JOB_STORAGE_UNAVAILABLE" });
  }

  if (!existingJob) {
    return jsonResponse(404, { code: "OCR_JOB_NOT_FOUND" });
  }

  if (existingJob.version !== expectedVersion) {
    return jsonResponse(409, {
      code: "OCR_JOB_VERSION_CONFLICT",
      job: toPublicOcrJob(existingJob),
    });
  }

  const previousRowsById = new Map(existingJob.rows.map((row) => [row.id, row]));
  const timestamp = new Date().toISOString();
  const updatedJob: OcrJobRecord = {
    ...existingJob,
    rawText: reviewedRawText === undefined ? existingJob.rawText : reviewedRawText,
    rows: reviewedRows.map((row) => {
      const previous = previousRowsById.get(row.id);

      return {
        id: row.id,
        sourceText: row.sourceText,
        ...(previous?.confidence !== undefined
          ? { confidence: previous.confidence }
          : {}),
        ...(previous?.box ? { box: previous.box } : {}),
        productName: row.productName,
        brand: row.brand,
        option: row.option,
        quantity: row.quantity,
      };
    }),
    version: existingJob.version + 1,
    updatedAt: timestamp,
    updatedBy: userSub,
  };

  if (estimateOcrJobStorageBytes(updatedJob) > MAX_OCR_JOB_STORAGE_BYTES) {
    return jsonResponse(413, { code: "OCR_JOB_TOO_LARGE" });
  }

  try {
    await documentClient.send(
      new PutCommand({
        TableName: jobTableName,
        Item: updatedJob,
        ConditionExpression: "#version = :expectedVersion",
        ExpressionAttributeNames: { "#version": "version" },
        ExpressionAttributeValues: { ":expectedVersion": expectedVersion },
      }),
    );
  } catch (error) {
    if (isConditionalWriteError(error)) {
      return jsonResponse(409, { code: "OCR_JOB_VERSION_CONFLICT" });
    }

    return jsonResponse(503, { code: "OCR_JOB_STORAGE_UNAVAILABLE" });
  }

  return jsonResponse(200, { job: toPublicOcrJob(updatedJob) });
}

/** primary key strong read와 record shape 검증을 함께 해서 다른 형식의 Dynamo item을 노출하지 않습니다. */
async function readOcrJob(
  jobTableName: string,
  jobId: string,
): Promise<OcrJobRecord | null | undefined> {
  try {
    const response = await documentClient.send(
      new GetCommand({
        TableName: jobTableName,
        Key: { jobId },
        ConsistentRead: true,
      }),
    );

    return isOcrJobRecord(response.Item) ? response.Item : null;
  } catch {
    return undefined;
  }
}

/** OCR API response에는 audit subject·TTL 같은 운영 내부 속성을 절대 넣지 않습니다. */
function toPublicOcrJob(job: OcrJobRecord): Record<string, unknown> {
  return {
    jobId: job.jobId,
    version: job.version,
    rawText: job.rawText,
    rows: job.rows.map((row) => ({
      id: row.id,
      sourceText: row.sourceText,
      ...(row.confidence !== undefined ? { confidence: row.confidence } : {}),
      ...(row.box ? { box: row.box } : {}),
      ...(row.productName !== undefined ? { productName: row.productName } : {}),
      ...(row.brand !== undefined ? { brand: row.brand } : {}),
      ...(row.option !== undefined ? { option: row.option } : {}),
      ...(row.quantity !== undefined ? { quantity: row.quantity } : {}),
    })),
  };
}

function resolveOcrRoute(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): OcrJobRoute | null {
  const rawPath = event.rawPath.replace(/\/+$/, "") || "/";
  const match = rawPath.match(/^\/admin\/ocr\/jobs(?:\/([^/]+))?$/);

  if (!match) {
    return null;
  }

  const encodedJobId = event.pathParameters?.jobId ?? match[1];

  if (!encodedJobId) {
    return { kind: "collection" };
  }

  try {
    const jobId = decodeURIComponent(encodedJobId);

    return JOB_ID_PATTERN.test(jobId) ? { kind: "item", jobId } : null;
  } catch {
    return null;
  }
}

/** provider 원본 행도 같은 식별자·길이·좌표 제한을 통과해야만 DB에 기록합니다. */
function toStoredRecognitionRows(
  rows: readonly OcrRecognitionRow[],
): readonly OcrJobRow[] | null {
  if (rows.length > MAX_JOB_ROWS) {
    return null;
  }

  const ids = new Set<string>();
  const storedRows: OcrJobRow[] = [];

  for (const row of rows) {
    if (
      !ROW_ID_PATTERN.test(row.id) ||
      !isTextWithin(row.sourceText, MAX_SOURCE_TEXT_LENGTH, false) ||
      ids.has(row.id) ||
      (row.confidence !== undefined && !isConfidence(row.confidence)) ||
      (row.box !== undefined && !isBoundingBox(row.box))
    ) {
      return null;
    }

    ids.add(row.id);
    storedRows.push({
      id: row.id,
      sourceText: row.sourceText,
      ...(row.confidence !== undefined ? { confidence: row.confidence } : {}),
      ...(row.box ? { box: row.box } : {}),
    });
  }

  return storedRows;
}

/** 화면이 보내는 수정 fields를 명시적으로 allowlist하여 임의 Dynamo 속성을 저장하지 않습니다. */
function parseReviewedRows(value: unknown): readonly OcrReviewedRow[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_JOB_ROWS) {
    return null;
  }

  const ids = new Set<string>();
  const rows: OcrReviewedRow[] = [];

  for (const valueRow of value) {
    if (!isRecord(valueRow)) {
      return null;
    }

    const id = readRowId(valueRow.id);
    const sourceText = readEditableText(valueRow.sourceText, MAX_SOURCE_TEXT_LENGTH);
    const productName = readEditableText(valueRow.productName, MAX_PRODUCT_NAME_LENGTH);
    const brand = readEditableText(valueRow.brand, MAX_BRAND_LENGTH);
    const option = readEditableText(valueRow.option, MAX_OPTION_LENGTH);
    const quantity = readQuantity(valueRow.quantity);

    if (
      !id ||
      sourceText === undefined ||
      productName === undefined ||
      brand === undefined ||
      option === undefined ||
      quantity === undefined ||
      ids.has(id)
    ) {
      return null;
    }

    ids.add(id);
    rows.push({ id, sourceText, productName, brand, option, quantity });
  }

  return rows;
}

function isOcrJobRecord(value: unknown): value is OcrJobRecord {
  return (
    isRecord(value) &&
    value.recordType === "OCR_JOB" &&
    isJobId(value.jobId) &&
    isTextWithin(value.createdBy, 256, false) &&
    isTextWithin(value.updatedBy, 256, false) &&
    readVersion(value.version) !== undefined &&
    isBoundedRawText(value.rawText) &&
    Array.isArray(value.rows) &&
    value.rows.length <= MAX_JOB_ROWS &&
    value.rows.every(isOcrJobRow) &&
    isTimestamp(value.createdAt) &&
    isTimestamp(value.updatedAt) &&
    typeof value.expiresAt === "number" &&
    Number.isSafeInteger(value.expiresAt) &&
    value.expiresAt > 0
  );
}

function isOcrJobRow(value: unknown): value is OcrJobRow {
  return (
    isRecord(value) &&
    readRowId(value.id) !== undefined &&
    // Manual review rows have no provider source text. PATCH already accepts
    // this empty string; persisted rows must accept the same shape on GET.
    isTextWithin(value.sourceText, MAX_SOURCE_TEXT_LENGTH, true) &&
    (value.confidence === undefined || isConfidence(value.confidence)) &&
    (value.box === undefined || isBoundingBox(value.box)) &&
    (value.productName === undefined ||
      isTextWithin(value.productName, MAX_PRODUCT_NAME_LENGTH, true)) &&
    (value.brand === undefined || isTextWithin(value.brand, MAX_BRAND_LENGTH, true)) &&
    (value.option === undefined ||
      isTextWithin(value.option, MAX_OPTION_LENGTH, true)) &&
    (value.quantity === undefined || isValidQuantity(value.quantity))
  );
}

function readRowId(value: unknown): string | undefined {
  return typeof value === "string" && ROW_ID_PATTERN.test(value) ? value : undefined;
}

function isJobId(value: unknown): value is string {
  return typeof value === "string" && JOB_ID_PATTERN.test(value);
}

/** 빈 편집 필드는 허용하되, 공백만 가진 긴 값·제어 문자는 정규화해 저장하지 않습니다. */
function readEditableText(value: unknown, maximumLength: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();

  return normalized.length <= maximumLength && !/[\u0000]/.test(normalized)
    ? normalized
    : undefined;
}

function readQuantity(value: unknown): string | undefined {
  const normalized = readEditableText(value, MAX_QUANTITY_LENGTH);

  return normalized !== undefined &&
    (normalized === "" || /^[0-9]{1,9}$/.test(normalized))
    ? normalized
    : undefined;
}

function isValidQuantity(value: unknown): value is string {
  return typeof value === "string" && (value === "" || /^[0-9]{1,9}$/.test(value));
}

function isTextWithin(value: unknown, maximumLength: number, allowEmpty: boolean) {
  return (
    typeof value === "string" &&
    value.length <= maximumLength &&
    !/[\u0000]/.test(value) &&
    (allowEmpty || Boolean(value.trim()))
  );
}

function isBoundedRawText(value: unknown): value is string {
  return isTextWithin(value, MAX_RAW_TEXT_LENGTH, true);
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 64 &&
    Number.isFinite(Date.parse(value))
  );
}

function isConfidence(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
  );
}

function isBoundingBox(value: unknown): value is OcrBoundingBox {
  if (!Array.isArray(value) || value.length < 2 || value.length > 8) {
    return false;
  }

  return value.every(
    (point) =>
      Array.isArray(point) &&
      point.length >= 2 &&
      typeof point[0] === "number" &&
      typeof point[1] === "number" &&
      Number.isFinite(point[0]) &&
      Number.isFinite(point[1]) &&
      Math.abs(point[0]) <= 1_000_000 &&
      Math.abs(point[1]) <= 1_000_000,
  );
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

function isConditionalWriteError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "ConditionalCheckFailedException"
  );
}

/**
 * Conservative DynamoDB item estimate, not JSON wire size or exact billing.
 * https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/CapacityUnitCalculations.html
 * Count UTF-8 names/strings, raw binary, map/list overhead (3 + 1 per entry),
 * and 21 bytes per number (above 38-digit numeric storage's approximate maximum).
 * Include another 100 storage bytes and top-level map overhead conservatively;
 * the 380KiB write cap leaves 20KiB below DynamoDB's 400KiB item limit.
 * Walk the entire final item, including preserved metadata/audit attributes.
 * Unsupported/cyclic/deep structures fail closed; GET shape checks stay intact.
 */
export function estimateOcrJobStorageBytes(item: unknown): number {
  let bytes = 100;
  let visited = 0;
  const ancestors = new WeakSet<object>();

  const walk = (value: unknown, depth: number): void => {
    if (bytes > MAX_OCR_JOB_STORAGE_BYTES) return;
    visited += 1;
    if (depth > 32 || visited > 100_000) {
      bytes = Infinity;
    } else if (value === undefined) {
      // DocumentClient has removeUndefinedValues enabled.
    } else if (typeof value === "string") {
      bytes += Buffer.byteLength(value, "utf8");
    } else if (typeof value === "number" || typeof value === "bigint") {
      bytes +=
        typeof value === "number" && !Number.isFinite(value)
          ? Infinity
          : Math.max(21, Buffer.byteLength(String(value), "utf8"));
    } else if (value === null || typeof value === "boolean") {
      bytes += 1;
    } else if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
      bytes += value.byteLength;
    } else if (typeof value === "object") {
      if (ancestors.has(value)) {
        bytes = Infinity;
        return;
      }
      ancestors.add(value);
      bytes += 3;
      if (Array.isArray(value) || value instanceof Set) {
        // Sets need less overhead; counting them like lists is conservative.
        for (const element of value) {
          bytes += 1;
          walk(element, depth + 1);
          if (bytes > MAX_OCR_JOB_STORAGE_BYTES) break;
        }
      } else if (
        Object.getPrototypeOf(value) === Object.prototype ||
        Object.getPrototypeOf(value) === null
      ) {
        for (const [name, element] of Object.entries(value)) {
          if (element === undefined) continue;
          bytes += Buffer.byteLength(name, "utf8") + 1;
          walk(element, depth + 1);
          if (bytes > MAX_OCR_JOB_STORAGE_BYTES) break;
        }
      } else {
        bytes = Infinity;
      }
      ancestors.delete(value);
    } else {
      bytes = Infinity;
    }
  };

  try {
    walk(item, 0);
  } catch {
    return Infinity;
  }
  return bytes;
}

function providerFailureResponse(error: unknown): APIGatewayProxyResultV2 {
  if (error instanceof PaddleOcrProviderError) {
    if (error.kind === "CONFIGURATION") {
      return jsonResponse(503, { code: "OCR_PROVIDER_CONFIGURATION_UNAVAILABLE" });
    }

    if (error.kind === "REQUEST") {
      return jsonResponse(502, { code: "OCR_PROVIDER_REQUEST_FAILED" });
    }
  }

  return jsonResponse(502, { code: "OCR_PROVIDER_RESPONSE_INVALID" });
}
