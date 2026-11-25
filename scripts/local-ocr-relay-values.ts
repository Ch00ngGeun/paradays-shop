// 역할: 로컬 OCR 중계 서버의 요청 본문 제한 읽기·provider 응답 기한·작업 공개 형태 변환·검토 행 검증 도우미를 제공합니다.
import { type IncomingMessage } from "node:http";
import {
  parseOcrTableRows,
  type OcrMapping,
  type OcrTableParseResult,
} from "../infra/lambda/ocr-table-parser.js";

export type RecordValue = Record<string, unknown>;

type Row = RecordValue & { id: string; sourceText: string };

export type Job = {
  jobId: string;
  ownerSub: string;
  version: number;
  rawText: string;
  rows: Row[];
  sourceRows?: Row[];
  mapping?: OcrMapping;
  expiresAt: number;
};

export const record = (value: unknown): value is RecordValue =>
  !!value && typeof value === "object" && !Array.isArray(value);

export const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length <= max && !value.includes("\0");

const REQUEST_LIMIT = Math.ceil((4 * 1024 * 1024) / 3) * 4 + 4096;

export class Failure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly details?: RecordValue,
  ) {
    super(code);
  }
}

/** 스트리밍 바이트 읽기와 upstream 응답 전체가 하나의 고정 기한을 공유합니다. */
async function boundedJson(response: Response, maximum: number): Promise<unknown> {
  if (!response.ok || !response.body)
    throw new Failure(502, "OCR_PROVIDER_REQUEST_FAILED");
  const reader = response.body.getReader();
  const bytes = new Uint8Array(maximum);
  let length = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (length + chunk.value.byteLength > maximum)
        throw new Failure(502, "OCR_PROVIDER_RESPONSE_INVALID");
      bytes.set(chunk.value, length);
      length += chunk.value.byteLength;
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)),
    );
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function deadlineJson(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
  maximum: number,
  milliseconds: number,
) {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Failure(502, "OCR_PROVIDER_REQUEST_FAILED"));
    }, milliseconds);
  });
  try {
    return await Promise.race([
      (async () =>
        boundedJson(
          await fetcher(url, { ...init, signal: controller.signal, redirect: "error" }),
          maximum,
        ))(),
      deadline,
    ]);
  } finally {
    clearTimeout(timeout!);
    controller.abort();
  }
}

export function publicJob(job: Job) {
  const sources = job.sourceRows ?? (job.version === 1 ? job.rows : undefined);
  return {
    jobId: job.jobId,
    version: job.version,
    rawText: job.rawText,
    rows: job.rows,
    analysis: sources
      ? publicAnalysis(parseOcrTableRows(sources, job.mapping))
      : { mode: "unclassified", reason: "source-rows-unavailable" },
  };
}

export function publicAnalysis(parsed: OcrTableParseResult): RecordValue {
  return {
    mode: parsed.mode,
    ...("reason" in parsed ? { reason: parsed.reason } : {}),
    ...(parsed.table ? { table: parsed.table } : {}),
    ...(parsed.mode === "table" ? { mapping: parsed.mapping } : {}),
    ...(parsed.region ? { region: parsed.region } : {}),
  };
}

export function checkJobSize(job: Job) {
  if (Buffer.byteLength(JSON.stringify(job), "utf8") > 380 * 1024)
    throw new Failure(413, "OCR_JOB_TOO_LARGE");
}

export function reviewedRows(value: unknown, previous: Row[]): Row[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 500)
    throw new Failure(400, "OCR_JOB_ROWS_INVALID");
  const ids = new Set<string>();
  return value.map((row: unknown) => {
    if (
      !record(row) ||
      !text(row.id, 128) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(row.id) ||
      ids.has(row.id)
    )
      throw new Failure(400, "OCR_JOB_ROWS_INVALID");
    ids.add(row.id);
    const result: Row = { id: row.id, sourceText: "" };
    for (const [key, maximum] of [
      ["sourceText", 1000],
      ["productName", 240],
      ["brand", 100],
      ["option", 200],
      ["quantity", 12],
    ] as const) {
      if (!text(row[key], maximum)) throw new Failure(400, "OCR_JOB_ROWS_INVALID");
      result[key] = row[key].trim();
    }
    if (!/^(?:[0-9]{1,9})?$/.test(String(result.quantity)))
      throw new Failure(400, "OCR_JOB_ROWS_INVALID");
    const metadata = previous.find((item) => item.id === row.id);
    if (metadata?.confidence !== undefined) result.confidence = metadata.confidence;
    if (metadata?.box !== undefined) result.box = metadata.box;
    return result;
  });
}

export async function requestBody(request: IncomingMessage): Promise<unknown> {
  const bytes = Buffer.allocUnsafe(REQUEST_LIMIT);
  let size = 0;
  for await (const chunk of request) {
    const nextSize = size + chunk.length;
    if (nextSize > REQUEST_LIMIT) throw new Failure(413, "OCR_IMAGE_TOO_LARGE");
    bytes.set(chunk, size);
    size = nextSize;
  }
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)),
    );
  } catch {
    throw new Failure(400, "OCR_JOB_BODY_INVALID");
  }
}

/** 데모 업로드는 읽기 기한이 고정되며, 메모리를 할당하기 전에 제한된 처리 자리를 먼저 확보합니다. */
export function demoRequestBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const bytes = Buffer.allocUnsafe(REQUEST_LIMIT);
    let size = 0;
    const timeout = setTimeout(
      () => finish(new Failure(408, "LOCAL_OCR_BODY_TIMEOUT")),
      5000,
    );
    function cleanup() {
      clearTimeout(timeout);
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      request.off("aborted", onAborted);
    }
    function finish(error?: Failure, value?: unknown) {
      cleanup();
      if (error) {
        request.pause();
        reject(error);
      } else resolve(value);
    }
    function onData(chunk: Buffer) {
      if (size + chunk.length > REQUEST_LIMIT) {
        finish(new Failure(413, "OCR_IMAGE_TOO_LARGE"));
        return;
      }
      bytes.set(chunk, size);
      size += chunk.length;
    }
    function onEnd() {
      try {
        finish(
          undefined,
          JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)),
          ),
        );
      } catch {
        finish(new Failure(400, "OCR_JOB_BODY_INVALID"));
      }
    }
    function onError() {
      finish(new Failure(400, "OCR_JOB_BODY_INVALID"));
    }
    function onAborted() {
      finish(new Failure(400, "OCR_JOB_BODY_INVALID"));
    }
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    request.once("aborted", onAborted);
  });
}
