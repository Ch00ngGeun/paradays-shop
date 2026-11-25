import type {
  AdminOcrBoundingBox,
  AdminOcrIntakeInput,
  AdminOcrRecognitionResult,
  AdminOcrReviewRow,
  OcrTableAnalysis,
} from "@/lib/admin-ui/types";
import {
  isOcrEditableText,
  isOcrQuantity,
  OCR_INPUT_LIMITS,
  validateOcrImageFile,
} from "@/lib/admin-ui/ocr-input-validation";
import {
  isOcrMapping,
  isOcrColumnMapping,
} from "../../infra/lambda/ocr-table-parser.js";
import { AdminApiResponseError } from "./admin-api-client-errors";
import { isRecord, isSafeText } from "./admin-api-client-response";

const OCR_INTAKE_CATEGORIES = new Set([
  "Deck",
  "Complete",
  "Top",
  "Bottom",
  "Outerwear",
  "Shoes",
  "Accessories",
  "Wheels",
  "Trucks",
  "Bearings",
  "Hardware",
  "Protection",
  "Other",
]);

export function isIntakeInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

export function validateOcrIntakeInput(input: AdminOcrIntakeInput) {
  const plain = (value: unknown): value is Record<string, unknown> => {
    if (
      !isRecord(value) ||
      Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    )
      return false;
    return Reflect.ownKeys(value).every(
      (key) =>
        typeof key === "string" &&
        Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value"),
    );
  };
  const safeText = (value: unknown, maximum: number, empty = false): value is string =>
    typeof value === "string" &&
    value.length <= maximum &&
    (empty || value.trim().length > 0) &&
    !/[\u0000-\u001f\u007f]/u.test(value);
  if (
    !plain(input) ||
    !safeText(input.operationId, 128) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(input.operationId) ||
    !isIntakeInteger(input.quantity, 1, 1_000_000) ||
    !plain(input.source) ||
    Object.keys(input.source).some((key) => !["jobId", "rowIds"].includes(key)) ||
    typeof input.source.jobId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(input.source.jobId) ||
    !Array.isArray(input.source.rowIds) ||
    input.source.rowIds.length < 1 ||
    input.source.rowIds.length > 96 ||
    Object.keys(input.source.rowIds).length !== input.source.rowIds.length ||
    !input.source.rowIds.every(
      (id) => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id),
    ) ||
    new Set(input.source.rowIds).size !== input.source.rowIds.length
  )
    throw new AdminApiResponseError();
  if (input.kind === "existing") {
    if (
      Object.keys(input).some(
        (key) =>
          !["operationId", "quantity", "source", "kind", "existing"].includes(key),
      ) ||
      !plain(input.existing) ||
      Object.keys(input.existing).some(
        (key) => !["productId", "version"].includes(key),
      ) ||
      !safeText(input.existing.productId, 96) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{2,95}$/.test(input.existing.productId) ||
      !isIntakeInteger(input.existing.version, 1, Number.MAX_SAFE_INTEGER - 1)
    )
      throw new AdminApiResponseError();
  } else if (input.kind === "new") {
    const product = input.product;
    if (
      Object.keys(input).some(
        (key) =>
          !["operationId", "quantity", "source", "kind", "product"].includes(key),
      ) ||
      !plain(product) ||
      Object.keys(product).some(
        (key) =>
          !["name", "brandName", "option", "sku", "price", "category"].includes(key),
      ) ||
      !safeText(product.name, 160) ||
      !safeText(product.brandName, 100) ||
      !safeText(product.option, 50, true) ||
      (product.sku !== undefined && !safeText(product.sku, 80)) ||
      !isIntakeInteger(product.price, 0, 100_000_000) ||
      !OCR_INTAKE_CATEGORIES.has(product.category)
    )
      throw new AdminApiResponseError();
  } else throw new AdminApiResponseError();
}

export function parseOcrJob(value: unknown): AdminOcrRecognitionResult {
  const job = isRecord(value) && isRecord(value.job) ? value.job : null;

  if (
    !job ||
    !isValidOcrJobId(job.jobId) ||
    typeof job.version !== "number" ||
    !Number.isSafeInteger(job.version) ||
    job.version < 1 ||
    !isOcrRawText(job.rawText) ||
    !Array.isArray(job.rows) ||
    job.rows.length > OCR_INPUT_LIMITS.maxReviewRows
  ) {
    throw new AdminApiResponseError();
  }

  const rows = job.rows.map((row, index): AdminOcrReviewRow => {
    if (!isRecord(row) || !isSafeText(row.id, 128)) {
      throw new AdminApiResponseError();
    }

    const sourceText = readOcrResponseText(
      row.sourceText,
      OCR_INPUT_LIMITS.maxSourceTextLength,
    );
    const productName =
      row.productName === undefined
        ? ""
        : readOcrResponseText(row.productName, OCR_INPUT_LIMITS.maxProductNameLength);
    const brand =
      row.brand === undefined
        ? ""
        : readOcrResponseText(row.brand, OCR_INPUT_LIMITS.maxBrandLength);
    const option =
      row.option === undefined
        ? ""
        : readOcrResponseText(row.option, OCR_INPUT_LIMITS.maxOptionLength);
    const quantity = row.quantity === undefined ? "" : row.quantity;
    const confidence =
      row.confidence === undefined ? undefined : parseOcrConfidence(row.confidence);
    const box = row.box === undefined ? undefined : parseOcrBoundingBox(row.box);

    if (
      sourceText === undefined ||
      productName === undefined ||
      brand === undefined ||
      option === undefined ||
      !isOcrQuantity(quantity) ||
      (row.confidence !== undefined && confidence === undefined) ||
      (row.box !== undefined && box === undefined)
    ) {
      throw new AdminApiResponseError();
    }

    return {
      id: row.id || `${job.jobId}-${index}`,
      sourceText,
      ...(confidence !== undefined ? { confidence } : {}),
      ...(box ? { box } : {}),
      productName,
      brand,
      option,
      quantity,
    };
  });

  if (new Set(rows.map((row) => row.id)).size !== rows.length)
    throw new AdminApiResponseError();
  const analysis =
    job.analysis === undefined ? undefined : parseOcrAnalysis(job.analysis);
  return {
    jobId: job.jobId,
    version: job.version,
    rawText: job.rawText,
    rows,
    ...(analysis ? { analysis } : {}),
  };
}

function parseOcrAnalysis(value: unknown): OcrTableAnalysis {
  if (
    !isRecord(value) ||
    !["table", "empty", "unclassified"].includes(String(value.mode)) ||
    (value.reason !== undefined && !isSafeText(value.reason, 100)) ||
    (value.mapping !== undefined && !isOcrMapping(value.mapping))
  )
    throw new AdminApiResponseError();
  let table: OcrTableAnalysis["table"];
  if (value.table !== undefined) {
    const descriptor = value.table;
    if (
      !isRecord(descriptor) ||
      !Number.isInteger(descriptor.headerRow) ||
      (descriptor.headerRow as number) < 0 ||
      (descriptor.headerRow as number) > 499 ||
      !Array.isArray(descriptor.columns) ||
      descriptor.columns.length < 2 ||
      descriptor.columns.length > 20
    )
      throw new AdminApiResponseError();
    table = {
      headerRow: descriptor.headerRow as number,
      columns: descriptor.columns.map((column, index) => {
        if (
          !isRecord(column) ||
          column.index !== index ||
          !isSafeText(column.label, 1000) ||
          ![
            "productName",
            "productInfo",
            "brand",
            "option",
            "quantity",
            "price",
            "ignore",
            "unknown",
          ].includes(String(column.role))
        )
          throw new AdminApiResponseError();
        return { index, label: column.label, role: column.role as string };
      }),
    };
  }
  if (
    value.mapping &&
    isOcrColumnMapping(value.mapping) &&
    table &&
    (value.mapping.headerRow !== table.headerRow ||
      Object.values(value.mapping.columns).some(
        (column) => column !== null && column >= table.columns.length,
      ))
  )
    throw new AdminApiResponseError();
  let region: OcrTableAnalysis["region"];
  if (value.region !== undefined) {
    const report = value.region;
    if (
      !isRecord(report) ||
      ![
        report.sourceTokenCount,
        report.includedTokenCount,
        report.excludedTokenCount,
      ].every(
        (n) => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 500,
      ) ||
      Number(report.includedTokenCount) + Number(report.excludedTokenCount) !==
        report.sourceTokenCount ||
      !Array.isArray(report.warnings) ||
      report.warnings.length > 20 ||
      !report.warnings.every(
        (code) => typeof code === "string" && /^[a-z][a-z0-9-]{0,79}$/u.test(code),
      )
    )
      throw new AdminApiResponseError();
    region = {
      sourceTokenCount: Number(report.sourceTokenCount),
      includedTokenCount: Number(report.includedTokenCount),
      excludedTokenCount: Number(report.excludedTokenCount),
      warnings: report.warnings as string[],
    };
  }
  if (
    value.mode === "table" &&
    (!value.mapping || (value.mapping.schemaVersion === 1 ? !table : !region))
  )
    throw new AdminApiResponseError();
  return {
    mode: value.mode as OcrTableAnalysis["mode"],
    ...(value.reason ? { reason: value.reason as string } : {}),
    ...(table ? { table } : {}),
    ...(value.mapping ? { mapping: value.mapping } : {}),
    ...(region ? { region } : {}),
  };
}

function readOcrResponseText(
  value: unknown,
  maximumLength: number,
): string | undefined {
  return isOcrEditableText(value, maximumLength) ? value : undefined;
}

/** Raw text is preserved without trimming, unlike editable row fields. */
export function isOcrRawText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= OCR_INPUT_LIMITS.maxRawTextLength &&
    !value.includes("\u0000")
  );
}

function parseOcrConfidence(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : undefined;
}

function parseOcrBoundingBox(value: unknown): AdminOcrBoundingBox | undefined {
  if (!Array.isArray(value) || value.length < 2 || value.length > 8) {
    return undefined;
  }

  const points: [number, number][] = [];

  for (const point of value) {
    if (
      !Array.isArray(point) ||
      point.length < 2 ||
      typeof point[0] !== "number" ||
      typeof point[1] !== "number" ||
      !Number.isFinite(point[0]) ||
      !Number.isFinite(point[1]) ||
      Math.abs(point[0]) > 1_000_000 ||
      Math.abs(point[1]) > 1_000_000
    ) {
      return undefined;
    }

    points.push([point[0], point[1]]);
  }

  return points;
}

/** inline JSON은 Lambda sync event에 안전한 4MiB 원본만 base64화합니다. */
export async function serializeOcrImageFile(file: File) {
  const image = await validateOcrImageFile(file);

  return {
    fileName: image.fileName,
    mimeType: image.mimeType,
    imageBase64: bytesToBase64(image.bytes),
  };
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 0x8000;

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }

  return globalThis.btoa(binary);
}

export function normalizeOcrJobId(jobId: string): string {
  const normalizedJobId = jobId.trim();

  if (!isValidOcrJobId(normalizedJobId)) {
    throw new AdminApiResponseError();
  }

  return normalizedJobId;
}

function isValidOcrJobId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(value);
}
