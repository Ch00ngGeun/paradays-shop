/**
 * 역할: PaddleOCR 호환 서버를 Lambda에서만 호출하고, 이미지 입력과 인식 결과를 정규화함.
 * 기능: 브라우저에 OCR 비밀값을 노출하지 않고 이미지 매직 바이트·용량을 검증한 뒤 편집 가능한 텍스트 행을 반환함.
 */

import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { isRecord, readBoundedString } from "./request-helpers.js";
import { parseOcrTableRows } from "./ocr-table-parser.js";
import {
  readSupportedMimeType,
  readImageBase64,
  decodeBase64Image,
  detectImageMimeType,
  readSafeOcrFileName,
  invalidOcrImage,
} from "./paddle-ocr-image.js";
import {
  findRecognitionNode,
  readConfidence,
  readBoundingBox,
} from "./paddle-ocr-response.js";

/** Lambda synchronous invoke payload 안에 안전하게 담을 수 있는 raw image 상한입니다. */
export const MAX_INLINE_OCR_IMAGE_BYTES = 4 * 1024 * 1024;

// 100k UTF-16 text units need at most 600k bytes when JSON-escaped; 500 rows
// of scores/geometry and the envelope fit within the provider's 1.8MB canonical
// limit. Keep 2MiB of transport headroom, enforced on streamed bytes, not headers.
export const MAX_PADDLE_OCR_RESPONSE_BYTES = 2 * 1024 * 1024;

const OCR_REQUEST_DEADLINE_MS = 12_000;

const MAX_OCR_ROWS = 500;

const MAX_ROW_TEXT_LENGTH = 512;

const MAX_RAW_TEXT_LENGTH = 100_000;

/** Secrets Manager에만 보관할 OCR service endpoint·공유 비밀값입니다. */
export type PaddleOcrCredentials = Readonly<{
  baseUrl: string;
  sharedSecret: string;
}>;

/** 원본 이미지와 다른 임시 입력은 OCR 요청을 마치면 참조를 잃고 DynamoDB에는 저장하지 않습니다. */
export type ValidatedOcrImage = Readonly<{
  fileName: string;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  bytes: Buffer;
}>;

/** handler가 invalid input과 inline 전송 한도 초과를 서로 다른 HTTP 상태로 응답할 수 있게 합니다. */
export type OcrImageUploadParseResult =
  | Readonly<{ ok: true; image: ValidatedOcrImage }>
  | Readonly<{ ok: false; code: "OCR_IMAGE_INVALID" | "OCR_IMAGE_TOO_LARGE" }>;

export type OcrBoundingBox = readonly (readonly [number, number])[];

/** 운영자가 product fields로 옮겨 적거나 수정할 수 있는 정규화 OCR 행입니다. */
export type OcrRecognitionRow = Readonly<{
  id: string;
  sourceText: string;
  confidence?: number;
  box?: OcrBoundingBox;
  productName?: string;
  brand?: string;
  option?: string;
  quantity?: string;
}>;

export type PaddleOcrRecognition = Readonly<{
  rawText: string;
  rows: readonly OcrRecognitionRow[];
  /** 표 구조화 전의 원본 텍스트·행 ID·provider metadata를 서버 내부에 보존함. */
  sourceRows?: readonly OcrRecognitionRow[];
}>;

/** 공급자 설정·네트워크·응답 오류를 handler가 외부 안전 오류 코드로 바꾸기 위한 오류입니다. */
export class PaddleOcrProviderError extends Error {
  constructor(readonly kind: "CONFIGURATION" | "REQUEST" | "RESPONSE") {
    super("PADDLE_OCR_PROVIDER_ERROR");
    this.name = "PaddleOcrProviderError";
  }
}

const secretsManagerClient = new SecretsManagerClient({});

const credentialsBySecretArn = new Map<string, Promise<PaddleOcrCredentials>>();

/** POST body의 base64 image를 strict하게 읽고 선언 MIME과 실제 매직 바이트가 같은지 확인합니다. */
export function parseOcrImageUpload(value: unknown): OcrImageUploadParseResult {
  if (!isRecord(value)) {
    return invalidOcrImage();
  }

  const fileName = readSafeOcrFileName(value.fileName);
  const mimeType = readSupportedMimeType(value.mimeType);

  if (!fileName || !mimeType) {
    return invalidOcrImage();
  }

  const imageBase64 = readImageBase64(value.imageBase64, mimeType);

  if (imageBase64.kind === "too-large") {
    return { ok: false, code: "OCR_IMAGE_TOO_LARGE" };
  }

  if (imageBase64.kind === "invalid") {
    return invalidOcrImage();
  }

  const decoded = decodeBase64Image(imageBase64.base64);

  if (decoded.kind === "too-large") {
    return { ok: false, code: "OCR_IMAGE_TOO_LARGE" };
  }

  if (decoded.kind === "invalid") {
    return invalidOcrImage();
  }

  const actualMimeType = detectImageMimeType(decoded.bytes);

  if (!actualMimeType || actualMimeType !== mimeType) {
    return invalidOcrImage();
  }

  return { ok: true, image: { fileName, mimeType, bytes: decoded.bytes } };
}

/** Secret ARN마다 Lambda container 수명 동안 credential 조회 하나만 공유합니다. */
export function getPaddleOcrCredentials(
  secretArn: string,
): Promise<PaddleOcrCredentials> {
  const cachedCredentials = credentialsBySecretArn.get(secretArn);

  if (cachedCredentials) {
    return cachedCredentials;
  }

  const credentials = readPaddleOcrCredentials(secretArn).catch((error: unknown) => {
    credentialsBySecretArn.delete(secretArn);
    throw error;
  });

  credentialsBySecretArn.set(secretArn, credentials);

  return credentials;
}

/** `/ocr` JSON API에 base64 file과 PaddleOCR 옵션만 전달하며 원본·secret은 로그에 남기지 않습니다. */
export async function recognizePaddleOcr(
  credentials: PaddleOcrCredentials,
  image: ValidatedOcrImage,
): Promise<PaddleOcrRecognition> {
  const endpoint = toOcrEndpoint(credentials.baseUrl);
  const controller = new AbortController();
  const deadlineAt = Date.now() + OCR_REQUEST_DEADLINE_MS;
  let rejectDeadline: () => void = () => {};
  const deadline = new Promise<never>((_, reject) => {
    rejectDeadline = () => reject(new PaddleOcrProviderError("REQUEST"));
  });
  controller.signal.addEventListener("abort", rejectDeadline, { once: true });
  const timeout = setTimeout(() => controller.abort(), OCR_REQUEST_DEADLINE_MS);
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let completed = false;

  const checkDeadline = () => {
    // JSON decoding/parsing is synchronous, so the timer cannot interrupt it.
    // Check elapsed time before and after it, as well as between stream reads.
    if (controller.signal.aborted || Date.now() >= deadlineAt) {
      controller.abort();
      throw new PaddleOcrProviderError("REQUEST");
    }
  };

  try {
    response = await Promise.race([
      fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${credentials.sharedSecret}`,
        },
        body: JSON.stringify({
          file: image.bytes.toString("base64"),
          fileType: 1,
          visualize: false,
        }),
        signal: controller.signal,
      }),
      deadline,
    ]);
    checkDeadline();
    if (!response.ok) {
      throw new PaddleOcrProviderError("REQUEST");
    }

    const contentLength = Number(response.headers.get("content-length"));
    if (
      (Number.isFinite(contentLength) &&
        contentLength > MAX_PADDLE_OCR_RESPONSE_BYTES) ||
      !response.body
    ) {
      throw new PaddleOcrProviderError("RESPONSE");
    }

    reader = response.body.getReader();
    // A fixed buffer also bounds memory when a provider sends millions of tiny
    // chunks; retaining every chunk would accumulate array/object overhead.
    const responseBytes = new Uint8Array(MAX_PADDLE_OCR_RESPONSE_BYTES);
    let bytes = 0;
    while (true) {
      checkDeadline();
      // Race every read: an upstream stream that ignores AbortSignal must not
      // keep this invocation waiting after the shared headers/body deadline.
      const chunk = await Promise.race([reader.read(), deadline]);
      checkDeadline();
      if (chunk.done) {
        break;
      }
      const nextBytes = bytes + chunk.value.byteLength;
      if (nextBytes > MAX_PADDLE_OCR_RESPONSE_BYTES) {
        throw new PaddleOcrProviderError("RESPONSE");
      }
      responseBytes.set(chunk.value, bytes);
      bytes = nextBytes;
    }

    const responseText = new TextDecoder("utf-8", { fatal: true }).decode(
      responseBytes.subarray(0, bytes),
    );
    checkDeadline();
    const recognition = parseRecognitionResponse(JSON.parse(responseText) as unknown);
    checkDeadline();
    completed = true;
    return recognition;
  } catch (error: unknown) {
    if (controller.signal.aborted || Date.now() >= deadlineAt || !response) {
      throw new PaddleOcrProviderError("REQUEST");
    }
    throw error instanceof PaddleOcrProviderError
      ? error
      : new PaddleOcrProviderError("RESPONSE");
  } finally {
    clearTimeout(timeout);
    controller.signal.removeEventListener("abort", rejectDeadline);
    if (!completed) {
      controller.abort();
      // Cancellation is best-effort and never awaited: a stalled cancel must
      // not extend the deadline or hide the safe provider error.
      try {
        const cancellation = reader ? reader.cancel() : response?.body?.cancel();
        void cancellation?.catch(() => {});
      } catch {}
    }
    try {
      reader?.releaseLock();
    } catch {}
  }
}

/** Secrets JSON에서 baseUrl/sharedSecret만 꺼내며 임의 문자열·HTTP endpoint·자격증명 URL은 거절합니다. */
async function readPaddleOcrCredentials(
  secretArn: string,
): Promise<PaddleOcrCredentials> {
  let response;

  try {
    response = await secretsManagerClient.send(
      new GetSecretValueCommand({ SecretId: secretArn }),
    );
  } catch {
    throw new PaddleOcrProviderError("CONFIGURATION");
  }

  if (!response.SecretString) {
    throw new PaddleOcrProviderError("CONFIGURATION");
  }

  try {
    const parsed: unknown = JSON.parse(response.SecretString);

    if (
      !isRecord(parsed) ||
      typeof parsed.baseUrl !== "string" ||
      typeof parsed.sharedSecret !== "string" ||
      !parsed.sharedSecret.trim() ||
      /[\r\n]/.test(parsed.sharedSecret)
    ) {
      throw new Error("PADDLE_OCR_SECRET_INVALID");
    }

    const endpoint = toOcrEndpoint(parsed.baseUrl);

    return {
      baseUrl: endpoint.toString().replace(/\/ocr$/, ""),
      sharedSecret: parsed.sharedSecret.trim(),
    };
  } catch {
    throw new PaddleOcrProviderError("CONFIGURATION");
  }
}

/** trusted base URL의 기존 path 뒤에만 /ocr을 붙여 SSRF 가능한 protocol·credential URL을 막습니다. */
function toOcrEndpoint(baseUrl: string): URL {
  let endpoint: URL;

  try {
    endpoint = new URL(baseUrl);
  } catch {
    throw new PaddleOcrProviderError("CONFIGURATION");
  }

  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash ||
    endpoint.search
  ) {
    throw new PaddleOcrProviderError("CONFIGURATION");
  }

  endpoint.pathname = `${endpoint.pathname.replace(/\/+$/, "")}/ocr`;

  return endpoint;
}

/** PaddleX/PaddleOCR 응답의 result·prunedResult 중 rec_* 배열이 담긴 첫 node를 찾습니다. */
export function parseRecognitionResponse(value: unknown): PaddleOcrRecognition {
  const node = findRecognitionNode(value);

  if (!node || !Array.isArray(node.rec_texts) || node.rec_texts.length > MAX_OCR_ROWS) {
    throw new PaddleOcrProviderError("RESPONSE");
  }

  const scores = Array.isArray(node.rec_scores) ? node.rec_scores : [];
  const boxes = Array.isArray(node.rec_boxes) ? node.rec_boxes : [];
  const polys = Array.isArray(node.rec_polys) ? node.rec_polys : [];
  const rows: OcrRecognitionRow[] = [];

  for (let index = 0; index < node.rec_texts.length; index += 1) {
    const sourceText = readBoundedString(node.rec_texts[index], MAX_ROW_TEXT_LENGTH);

    if (!sourceText) {
      continue;
    }

    const confidence = readConfidence(scores[index]);
    // canonical rec_boxes를 우선하되, 구형 provider가 polygon만 준 행은 같은 index의
    // rec_polys로만 보완합니다. 한 행의 geometry 오류가 다른 텍스트 행을 버리면 안 됩니다.
    const box = readBoundingBox(boxes[index]) ?? readBoundingBox(polys[index]);

    rows.push({
      id: `ocr_${index + 1}`,
      sourceText,
      ...(confidence !== undefined ? { confidence } : {}),
      ...(box ? { box } : {}),
    });
  }

  const rawText = rows.map((row) => row.sourceText).join("\n");

  if (rawText.length > MAX_RAW_TEXT_LENGTH) {
    throw new PaddleOcrProviderError("RESPONSE");
  }

  const table = parseOcrTableRows(rows);

  // 미분류도 재매핑할 수 있도록 원본 토큰을 항상 별도로 보존함.
  return { rawText, rows: table.rows, sourceRows: rows };
}
