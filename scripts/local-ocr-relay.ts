/** Development-only loopback OCR bridge. Images and review jobs stay in memory. */
import { createPublicKey, randomUUID, verify, type JsonWebKey } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  MAX_PADDLE_OCR_RESPONSE_BYTES,
  parseOcrImageUpload,
  parseRecognitionResponse,
} from "../infra/lambda/paddle-ocr.js";

type RecordValue = Record<string, unknown>;
type Row = RecordValue & { id: string; sourceText: string };
type Job = {
  jobId: string;
  version: number;
  rawText: string;
  rows: Row[];
  expiresAt: number;
};
export type RelayOptions = {
  origin: string;
  port: number;
  issuer: string;
  clientId: string;
  providerUrl: string;
  sharedSecret: string;
  /** Explicit local desktop profile only; the normal transport stays at 12 seconds. */
  providerTimeoutMs?: number;
  fetcher?: typeof fetch;
  now?: () => number;
  jwksLoader?: () => Promise<unknown>;
};
const record = (value: unknown): value is RecordValue =>
  !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length <= max && !value.includes("\0");
const REQUEST_LIMIT = Math.ceil((4 * 1024 * 1024) / 3) * 4 + 4096;
class Failure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

/** Streaming bytes and the entire upstream response share a hard deadline. */
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

async function deadlineJson(
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

export function createLocalOcrRelay(options: RelayOptions) {
  const origin = new URL(options.origin);
  const provider = new URL(options.providerUrl);
  if (
    process.env.NODE_ENV === "production" ||
    origin.protocol !== "http:" ||
    !["localhost", "127.0.0.1"].includes(origin.hostname) ||
    origin.origin !== options.origin ||
    !/^https:\/\/cognito-idp\.[a-z0-9-]+\.amazonaws\.com\/[a-z0-9-]+_[A-Za-z0-9]+$/.test(
      options.issuer,
    ) ||
    !/^[a-z0-9]{1,128}$/.test(options.clientId) ||
    provider.protocol !== "http:" ||
    provider.hostname !== "127.0.0.1" ||
    provider.username ||
    provider.password ||
    provider.search ||
    provider.hash ||
    !options.sharedSecret ||
    (options.providerTimeoutMs !== undefined &&
      (!Number.isSafeInteger(options.providerTimeoutMs) ||
        options.providerTimeoutMs < 1 ||
        options.providerTimeoutMs > 130000)) ||
    !Number.isInteger(options.port) ||
    options.port < 1 ||
    options.port > 65535
  ) {
    throw new Error("LOCAL_OCR_CONFIGURATION_INVALID");
  }
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  const jobs = new Map<string, Job>();
  let keys: RecordValue[] = [];
  let keysExpire = 0;
  let keyRequest: Promise<void> | undefined;
  let active = false;
  let rateWindow = now();
  let requests = 0;

  async function loadKeys() {
    if (!keyRequest) {
      keyRequest = (async () => {
        const value = options.jwksLoader
          ? await options.jwksLoader()
          : await deadlineJson(
              fetcher,
              `${options.issuer}/.well-known/jwks.json`,
              {},
              128 * 1024,
              5000,
            );
        if (!record(value) || !Array.isArray(value.keys) || value.keys.length > 20)
          throw new Failure(401, "ADMIN_AUTH_REQUIRED");
        keys = value.keys.filter(record);
        keysExpire = now() + 60 * 60 * 1000;
      })().finally(() => {
        keyRequest = undefined;
      });
    }
    await keyRequest;
  }
  async function authenticate(request: IncomingMessage) {
    const authorization = request.headers.authorization;
    if (!authorization || !/^Bearer [^\s]{1,16000}$/.test(authorization))
      throw new Failure(401, "ADMIN_AUTH_REQUIRED");
    const token = authorization.slice(7);
    try {
      const parts = token.split(".");
      if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part)))
        throw new Error();
      const header: unknown = JSON.parse(Buffer.from(parts[0], "base64url").toString());
      const claims: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString());
      if (
        !record(header) ||
        header.alg !== "RS256" ||
        !text(header.kid, 256) ||
        !record(claims)
      )
        throw new Error();
      if (keysExpire <= now()) await loadKeys();
      const key = keys.find(
        (key) =>
          key.kid === header.kid &&
          key.kty === "RSA" &&
          key.alg === "RS256" &&
          key.use === "sig",
      );
      if (
        !key ||
        !verify(
          "RSA-SHA256",
          Buffer.from(`${parts[0]}.${parts[1]}`),
          createPublicKey({ key: key as JsonWebKey, format: "jwk" }),
          Buffer.from(parts[2], "base64url"),
        )
      )
        throw new Error();
      const seconds = now() / 1000;
      if (
        claims.iss !== options.issuer ||
        claims.client_id !== options.clientId ||
        claims.token_use !== "access" ||
        !text(claims.sub, 256) ||
        !claims.sub ||
        typeof claims.exp !== "number" ||
        !Number.isFinite(claims.exp) ||
        claims.exp <= seconds ||
        (claims.nbf !== undefined &&
          (typeof claims.nbf !== "number" ||
            !Number.isFinite(claims.nbf) ||
            claims.nbf > seconds))
      )
        throw new Error();
      if (
        !Array.isArray(claims["cognito:groups"]) ||
        !claims["cognito:groups"].includes("admin")
      )
        throw new Failure(403, "ADMIN_ROLE_REQUIRED");
    } catch (error) {
      throw error instanceof Failure && error.status === 403
        ? error
        : new Failure(401, "ADMIN_AUTH_REQUIRED");
    }
  }

  const server = createServer(async (request, response) => {
    function send(status: number, body: unknown) {
      response.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        ...(request.headers.origin === options.origin
          ? {
              "access-control-allow-origin": options.origin,
              vary: "Origin",
              "access-control-allow-methods": "GET,POST,PATCH,OPTIONS",
              "access-control-allow-headers":
                "authorization,content-type,x-local-id-token",
            }
          : {}),
      });
      response.end(JSON.stringify(body));
    }
    try {
      if (
        ![`127.0.0.1:${options.port}`, `localhost:${options.port}`].includes(
          request.headers.host ?? "",
        )
      )
        throw new Failure(403, "LOCAL_OCR_ORIGIN_REQUIRED");
      if (request.url === "/healthz" && request.method === "GET") {
        send(200, { mode: "local", storage: "memory", restartLosesReviews: true });
        return;
      }
      if (request.headers.origin !== options.origin)
        throw new Failure(403, "LOCAL_OCR_ORIGIN_REQUIRED");
      if (request.method === "OPTIONS") {
        send(204, null);
        return;
      }
      await authenticate(request);
      const match =
        /^\/admin\/ocr\/jobs(?:\/([A-Za-z0-9][A-Za-z0-9._-]{2,127}))?$/.exec(
          request.url ?? "",
        );
      if (!match) throw new Failure(404, "ADMIN_OCR_ROUTE_NOT_FOUND");
      for (const [id, job] of jobs) if (job.expiresAt <= now()) jobs.delete(id);
      const jobId = match[1];
      if (jobId && request.method === "GET") {
        const job = jobs.get(jobId);
        if (!job) throw new Failure(404, "OCR_JOB_NOT_FOUND");
        send(200, { job: publicJob(job) });
        return;
      }
      if (
        (!jobId && request.method !== "POST") ||
        (jobId && request.method !== "PATCH")
      )
        throw new Failure(405, "METHOD_NOT_ALLOWED");
      if (!String(request.headers["content-type"] ?? "").startsWith("application/json"))
        throw new Failure(400, "OCR_JOB_BODY_INVALID");
      const body = await requestBody(request);
      if (!jobId) {
        if (active) throw new Failure(429, "OCR_PROVIDER_BUSY");
        if (now() - rateWindow >= 60000) {
          requests = 0;
          rateWindow = now();
        }
        if (++requests > 30 || jobs.size >= 100)
          throw new Failure(429, "LOCAL_OCR_LIMIT_REACHED");
        const image = parseOcrImageUpload(body);
        if (!image.ok)
          throw new Failure(
            image.code === "OCR_IMAGE_TOO_LARGE" ? 413 : 400,
            image.code,
          );
        active = true;
        try {
          const result = await deadlineJson(
            fetcher,
            `${provider.origin}${provider.pathname.replace(/\/+$/, "")}/ocr`,
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                authorization: `Bearer ${options.sharedSecret}`,
              },
              body: JSON.stringify({
                file: image.image.bytes.toString("base64"),
                fileType: 1,
                visualize: false,
              }),
            },
            MAX_PADDLE_OCR_RESPONSE_BYTES,
            options.providerTimeoutMs ?? 12000,
          );
          let recognition;
          try {
            recognition = parseRecognitionResponse(result);
          } catch {
            throw new Failure(502, "OCR_PROVIDER_RESPONSE_INVALID");
          }
          const job: Job = {
            jobId: `ocr_${randomUUID()}`,
            version: 1,
            rawText: recognition.rawText,
            rows: recognition.rows.map((row) => ({
              ...row,
              productName: row.sourceText,
              brand: "",
              option: "",
              quantity: "",
            })),
            expiresAt: now() + 7 * 24 * 60 * 60 * 1000,
          };
          checkJobSize(job);
          jobs.set(job.jobId, job);
          send(201, { job: publicJob(job) });
        } finally {
          active = false;
        }
        return;
      }
      const previous = jobs.get(jobId);
      if (!previous) throw new Failure(404, "OCR_JOB_NOT_FOUND");
      if (
        !record(body) ||
        !Number.isSafeInteger(body.version) ||
        Number(body.version) < 1
      )
        throw new Failure(400, "OCR_JOB_VERSION_REQUIRED");
      if (body.version !== previous.version)
        throw new Failure(409, "OCR_JOB_VERSION_CONFLICT");
      if (body.rawText !== undefined && !text(body.rawText, 100000))
        throw new Failure(400, "OCR_JOB_RAW_TEXT_INVALID");
      const rows = reviewedRows(body.rows, previous.rows);
      const job: Job = {
        ...previous,
        rows,
        version: previous.version + 1,
        rawText:
          body.rawText === undefined ? previous.rawText : (body.rawText as string),
      };
      checkJobSize(job);
      jobs.set(jobId, job);
      send(200, { job: publicJob(job) });
    } catch (error) {
      const failure =
        error instanceof Failure
          ? error
          : new Failure(502, "OCR_PROVIDER_REQUEST_FAILED");
      send(failure.status, { code: failure.code });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return server;
}

function publicJob(job: Job) {
  return {
    jobId: job.jobId,
    version: job.version,
    rawText: job.rawText,
    rows: job.rows,
  };
}
function checkJobSize(job: Job) {
  if (Buffer.byteLength(JSON.stringify(job), "utf8") > 380 * 1024)
    throw new Failure(413, "OCR_JOB_TOO_LARGE");
}
function reviewedRows(value: unknown, previous: Row[]): Row[] {
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
async function requestBody(request: IncomingMessage): Promise<unknown> {
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config: RelayOptions = JSON.parse(await readFile(process.argv[2], "utf8"));
  createLocalOcrRelay(config).listen(config.port, "127.0.0.1", () =>
    console.log(
      `Local OCR relay listening on 127.0.0.1:${config.port}; reviews are memory-only.`,
    ),
  );
}
