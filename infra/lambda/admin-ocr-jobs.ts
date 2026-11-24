import { randomUUID } from "node:crypto";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { documentClient, getRequiredEnvironment } from "./dynamodb-client.js";
import { jsonResponse } from "./http-response.js";
import {
  isOcrMapping,
  parseOcrTableRows,
  type OcrMapping,
} from "./ocr-table-parser.js";
import {
  getPaddleOcrCredentials,
  MAX_INLINE_OCR_IMAGE_BYTES,
  PaddleOcrProviderError,
  parseOcrImageUpload,
  recognizePaddleOcr,
  type PaddleOcrRecognition,
} from "./paddle-ocr.js";
import { isRecord, parseJsonBody } from "./request-helpers.js";
import {
  type OcrJobRow,
  type OcrJobRecord,
  toPublicOcrJob,
  publicAnalysis,
  toStoredRecognitionRows,
  parseReviewedRows,
  isOcrJobRecord,
  isBoundedRawText,
  readVersion,
  isConditionalWriteError,
} from "./admin-ocr-values.js";
import {
  MAX_OCR_JOB_STORAGE_BYTES,
  estimateOcrJobStorageBytes,
} from "./admin-ocr-handler.js";

const OCR_JOB_TTL_SECONDS = 7 * 24 * 60 * 60;

/** OCR provider 호출은 성공한 검토 가능한 텍스트만 기록하고, imageBase64는 즉시 참조를 잃습니다. */
export async function createOcrJob(
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

  let recognition: PaddleOcrRecognition;

  try {
    const credentials = await getPaddleOcrCredentials(secretArn);
    recognition = await recognizePaddleOcr(credentials, image);
  } catch (error) {
    return providerFailureResponse(error);
  }

  const rows = toStoredRecognitionRows(recognition.rows);
  const sourceRows = toStoredRecognitionRows(
    recognition.sourceRows ?? recognition.rows,
  );

  if (!rows || sourceRows === null || !isBoundedRawText(recognition.rawText)) {
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
    sourceRows,
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
export async function getOcrJob(
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
export async function updateOcrJob(
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
  const mappingUpdate = Object.hasOwn(body, "mapping");
  const reviewedRows = mappingUpdate ? undefined : parseReviewedRows(body.rows);
  const reviewedRawText = body.rawText;

  if (!expectedVersion) {
    return jsonResponse(400, { code: "OCR_JOB_VERSION_REQUIRED" });
  }

  if (
    mappingUpdate &&
    (!isOcrMapping(body.mapping) ||
      (body.preview !== undefined && body.preview !== true) ||
      Object.keys(body).some((key) => !["version", "mapping", "preview"].includes(key)))
  ) {
    return jsonResponse(400, { code: "OCR_JOB_MAPPING_INVALID" });
  }

  if (!mappingUpdate && !reviewedRows) {
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

  let projectedRows: readonly OcrJobRow[] | undefined;
  let sources: readonly OcrJobRow[] | undefined;
  let mapping: OcrMapping | undefined;

  if (mappingUpdate && isOcrMapping(body.mapping)) {
    sources =
      existingJob.sourceRows ??
      (existingJob.version === 1 ? existingJob.rows : undefined);
    if (!sources) {
      return jsonResponse(400, {
        code: "OCR_JOB_SOURCE_ROWS_UNAVAILABLE",
        message: "원본 인식 행이 없는 이전 검토본은 다시 매핑할 수 없습니다.",
      });
    }
    const parsed = parseOcrTableRows(sources, body.mapping);
    if (parsed.mode !== "table" || parsed.rows.length === 0) {
      return jsonResponse(400, {
        code: "OCR_JOB_MAPPING_UNUSABLE",
        message: "선택한 열로 검토 가능한 상품 행을 만들 수 없습니다.",
        analysis: publicAnalysis(parsed),
      });
    }
    projectedRows = toStoredRecognitionRows(parsed.rows) ?? undefined;
    if (!projectedRows) {
      return jsonResponse(400, { code: "OCR_JOB_MAPPING_UNUSABLE" });
    }
    mapping = body.mapping;
    if (body.preview === true) {
      return jsonResponse(200, {
        preview: {
          jobId: existingJob.jobId,
          version: existingJob.version,
          rows: projectedRows,
          analysis: publicAnalysis(parsed),
        },
      });
    }
  }

  const previousRowsById = new Map(existingJob.rows.map((row) => [row.id, row]));
  const timestamp = new Date().toISOString();
  const updatedJob: OcrJobRecord = {
    ...existingJob,
    rawText: reviewedRawText === undefined ? existingJob.rawText : reviewedRawText,
    ...(mapping ? { mapping, sourceRows: sources } : {}),
    rows:
      projectedRows ??
      reviewedRows!.map((row) => {
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
