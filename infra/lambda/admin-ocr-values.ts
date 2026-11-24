import {
  isOcrMapping,
  parseOcrTableRows,
  type OcrMapping,
  type OcrTableParseResult,
} from "./ocr-table-parser.js";
import { type OcrBoundingBox, type OcrRecognitionRow } from "./paddle-ocr.js";
import { isRecord } from "./request-helpers.js";

const MAX_JOB_ROWS = 500;

const MAX_RAW_TEXT_LENGTH = 100_000;

const MAX_SOURCE_TEXT_LENGTH = 1_000;

const MAX_PRODUCT_NAME_LENGTH = 240;

const MAX_BRAND_LENGTH = 100;

const MAX_OPTION_LENGTH = 200;

const MAX_QUANTITY_LENGTH = 12;

export const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/;

const ROW_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** OCR provider가 읽은 위치·신뢰도와 운영자가 수정한 입고 필드를 함께 보존합니다. */
export type OcrJobRow = Readonly<{
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
export type OcrJobRecord = Readonly<{
  recordType: "OCR_JOB";
  jobId: string;
  createdBy: string;
  updatedBy: string;
  version: number;
  rawText: string;
  rows: readonly OcrJobRow[];
  /** 표로 묶기 전의 provider 원본 행은 수정 payload에 노출하지 않고 보존함. */
  sourceRows?: readonly OcrJobRow[];
  mapping?: OcrMapping;
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

/** OCR API response에는 audit subject·TTL 같은 운영 내부 속성을 절대 넣지 않습니다. */
export function toPublicOcrJob(job: OcrJobRecord): Record<string, unknown> {
  const sources = job.sourceRows ?? (job.version === 1 ? job.rows : undefined);
  return {
    jobId: job.jobId,
    version: job.version,
    rawText: job.rawText,
    analysis: sources
      ? publicAnalysis(parseOcrTableRows(sources, job.mapping))
      : { mode: "unclassified", reason: "source-rows-unavailable" },
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

export function publicAnalysis(parsed: OcrTableParseResult): Record<string, unknown> {
  return {
    mode: parsed.mode,
    ...("reason" in parsed ? { reason: parsed.reason } : {}),
    ...(parsed.table ? { table: parsed.table } : {}),
    ...(parsed.mode === "table" ? { mapping: parsed.mapping } : {}),
    ...(parsed.region ? { region: parsed.region } : {}),
  };
}

/** provider 원본 행도 같은 식별자·길이·좌표 제한을 통과해야만 DB에 기록합니다. */
export function toStoredRecognitionRows(
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
      (row.box !== undefined && !isBoundingBox(row.box)) ||
      (row.productName !== undefined &&
        !isTextWithin(row.productName, MAX_PRODUCT_NAME_LENGTH, true)) ||
      (row.brand !== undefined && !isTextWithin(row.brand, MAX_BRAND_LENGTH, true)) ||
      (row.option !== undefined &&
        !isTextWithin(row.option, MAX_OPTION_LENGTH, true)) ||
      (row.quantity !== undefined && !isValidQuantity(row.quantity))
    ) {
      return null;
    }

    ids.add(row.id);
    storedRows.push({
      id: row.id,
      sourceText: row.sourceText,
      ...(row.confidence !== undefined ? { confidence: row.confidence } : {}),
      ...(row.box ? { box: row.box } : {}),
      ...(row.productName !== undefined ? { productName: row.productName } : {}),
      ...(row.brand !== undefined ? { brand: row.brand } : {}),
      ...(row.option !== undefined ? { option: row.option } : {}),
      ...(row.quantity !== undefined ? { quantity: row.quantity } : {}),
    });
  }

  return storedRows;
}

/** 화면이 보내는 수정 fields를 명시적으로 allowlist하여 임의 Dynamo 속성을 저장하지 않습니다. */
export function parseReviewedRows(value: unknown): readonly OcrReviewedRow[] | null {
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

export function isOcrJobRecord(value: unknown): value is OcrJobRecord {
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
    (value.sourceRows === undefined ||
      (Array.isArray(value.sourceRows) &&
        value.sourceRows.length <= MAX_JOB_ROWS &&
        value.sourceRows.every(isOcrJobRow))) &&
    (value.mapping === undefined || isOcrMapping(value.mapping)) &&
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

export function isBoundedRawText(value: unknown): value is string {
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

export function readVersion(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value.trim())
        ? Number(value.trim())
        : NaN;

  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function isConditionalWriteError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "ConditionalCheckFailedException"
  );
}
