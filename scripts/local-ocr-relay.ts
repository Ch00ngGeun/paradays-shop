// 역할: 개발 전용 loopback OCR 중계 서버로, Cognito token을 검증해 OCR provider로 전달하고 이미지·검토 작업은 메모리에만 둡니다.
import { createPublicKey, randomUUID, verify, type JsonWebKey } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { isOcrMapping, parseOcrTableRows } from "../infra/lambda/ocr-table-parser.js";
import {
  MAX_PADDLE_OCR_RESPONSE_BYTES,
  parseOcrImageUpload,
  parseRecognitionResponse,
} from "../infra/lambda/paddle-ocr.js";
import {
  type RecordValue,
  type Job,
  record,
  text,
  Failure,
  deadlineJson,
  publicJob,
  publicAnalysis,
  checkJobSize,
  reviewedRows,
  requestBody,
  demoRequestBody,
} from "./local-ocr-relay-values.js";

export type RelayOptions = {
  origin: string;
  /** 명시적으로 켜면 https://paradays.web.app만 추가 허용하며 로컬 origin은 계속 필요합니다. */
  demoEnabled?: boolean;
  port: number;
  issuer: string;
  clientId: string;
  providerUrl: string;
  sharedSecret: string;
  /** 명시한 로컬 데스크톱 프로필에서만 쓰며 일반 전송 제한은 12초로 유지됩니다. */
  providerTimeoutMs?: number;
  fetcher?: typeof fetch;
  now?: () => number;
  jwksLoader?: () => Promise<unknown>;
};

export function createLocalOcrRelay(options: RelayOptions) {
  const origin = new URL(options.origin);
  const provider = new URL(options.providerUrl);
  if (
    process.env.NODE_ENV === "production" ||
    origin.protocol !== "http:" ||
    !["localhost", "127.0.0.1"].includes(origin.hostname) ||
    origin.origin !== options.origin ||
    (options.demoEnabled !== undefined && typeof options.demoEnabled !== "boolean") ||
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
  const allowedOrigins = new Set([
    options.origin,
    ...(options.demoEnabled === true ? ["https://paradays.web.app"] : []),
  ]);
  const jobs = new Map<string, Job>();
  let keys: RecordValue[] = [];
  let keysExpire = 0;
  let keyRequest: Promise<void> | undefined;
  let active = false;
  let rateWindow = now();
  let requests = 0;
  let demoRateWindow = now();
  let demoRequests = 0;
  let demoCheapRequests = 0;
  let demoActiveRequests = 0;
  let demoPendingBodies = 0;

  // 공개 데모 요청 중 인증 전·health·preflight 요청은 가벼운 예산을 함께 쓰고, 서명된 요청은
  // 더 낮은 별도 예산을 씁니다. 해독한 token 정보는 어느 rate 키에도 넣지 않습니다.
  function checkDemoRate(cheap: boolean) {
    if (now() - demoRateWindow >= 60000) {
      demoRateWindow = now();
      demoRequests = 0;
      demoCheapRequests = 0;
    }
    if (cheap ? ++demoCheapRequests > 240 : ++demoRequests > 120)
      throw new Failure(429, "LOCAL_OCR_LIMIT_REACHED");
  }
  function checkOcrLimits() {
    if (active) throw new Failure(429, "OCR_PROVIDER_BUSY");
    if (now() - rateWindow >= 60000) {
      requests = 0;
      rateWindow = now();
    }
    if (++requests > 30 || jobs.size >= 100)
      throw new Failure(429, "LOCAL_OCR_LIMIT_REACHED");
  }

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
      return claims.sub;
    } catch (error) {
      throw error instanceof Failure && error.status === 403
        ? error
        : new Failure(401, "ADMIN_AUTH_REQUIRED");
    }
  }

  const server = createServer(async (request, response) => {
    let demoRequestReserved = false;
    let demoBodyReserved = false;
    let providerReserved = false;
    const allowedOrigin =
      typeof request.headers.origin === "string" &&
      allowedOrigins.has(request.headers.origin)
        ? request.headers.origin
        : undefined;
    function send(status: number, body: unknown) {
      response.writeHead(status, {
        "content-type": "application/json",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        ...(options.demoEnabled === true && status >= 400
          ? { connection: "close" }
          : {}),
        ...(allowedOrigin
          ? {
              "access-control-allow-origin": allowedOrigin,
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
        if (options.demoEnabled === true) checkDemoRate(true);
        send(200, { mode: "local", storage: "memory", restartLosesReviews: true });
        return;
      }
      if (!allowedOrigin) throw new Failure(403, "LOCAL_OCR_ORIGIN_REQUIRED");
      if (options.demoEnabled === true) checkDemoRate(true);
      if (request.method === "OPTIONS") {
        send(204, null);
        return;
      }
      if (options.demoEnabled === true) {
        if (demoActiveRequests >= 4) throw new Failure(429, "LOCAL_OCR_LIMIT_REACHED");
        demoActiveRequests++;
        demoRequestReserved = true;
      }
      const subject = await authenticate(request);
      if (options.demoEnabled === true) checkDemoRate(false);
      const match =
        /^\/admin\/ocr\/jobs(?:\/([A-Za-z0-9][A-Za-z0-9._-]{2,127}))?$/.exec(
          request.url ?? "",
        );
      if (!match) throw new Failure(404, "ADMIN_OCR_ROUTE_NOT_FOUND");
      for (const [id, job] of jobs) if (job.expiresAt <= now()) jobs.delete(id);
      const jobId = match[1];
      const ownedJob = jobId ? jobs.get(jobId) : undefined;
      if (jobId && (!ownedJob || ownedJob.ownerSub !== subject))
        throw new Failure(404, "OCR_JOB_NOT_FOUND");
      if (ownedJob && request.method === "GET") {
        send(200, { job: publicJob(ownedJob) });
        return;
      }
      if (
        (!jobId && request.method !== "POST") ||
        (jobId && request.method !== "PATCH")
      )
        throw new Failure(405, "METHOD_NOT_ALLOWED");
      if (!String(request.headers["content-type"] ?? "").startsWith("application/json"))
        throw new Failure(400, "OCR_JOB_BODY_INVALID");
      if (options.demoEnabled === true) {
        if (!jobId) {
          checkOcrLimits();
          active = true;
          providerReserved = true;
        }
        if (demoPendingBodies >= 2) throw new Failure(429, "LOCAL_OCR_LIMIT_REACHED");
        demoPendingBodies++;
        demoBodyReserved = true;
      }
      const body =
        options.demoEnabled === true
          ? await demoRequestBody(request)
          : await requestBody(request);
      if (demoBodyReserved) {
        demoPendingBodies--;
        demoBodyReserved = false;
      }
      if (!jobId) {
        if (options.demoEnabled !== true) checkOcrLimits();
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
            options.demoEnabled === true
              ? Math.min(options.providerTimeoutMs ?? 12000, 115000)
              : (options.providerTimeoutMs ?? 12000),
          );
          let recognition;
          try {
            recognition = parseRecognitionResponse(result);
          } catch {
            throw new Failure(502, "OCR_PROVIDER_RESPONSE_INVALID");
          }
          const job: Job = {
            jobId: `ocr_${randomUUID()}`,
            ownerSub: subject,
            version: 1,
            rawText: recognition.rawText,
            rows: recognition.rows.map((row) => ({
              ...row,
              productName: row.productName ?? "",
              brand: row.brand ?? "",
              option: row.option ?? "",
              quantity: row.quantity ?? "",
            })),
            sourceRows: [...(recognition.sourceRows ?? recognition.rows)],
            expiresAt: now() + 7 * 24 * 60 * 60 * 1000,
          };
          checkJobSize(job);
          jobs.set(job.jobId, job);
          send(201, { job: publicJob(job) });
        } finally {
          active = false;
          providerReserved = false;
        }
        return;
      }
      // 이 본문을 받는 동안 같은 소유자의 다른 PATCH가 끝날 수 있으므로 작업을 다시 확인합니다.
      const previous = jobs.get(jobId);
      if (!previous || previous.ownerSub !== subject || previous.expiresAt <= now())
        throw new Failure(404, "OCR_JOB_NOT_FOUND");
      if (
        !record(body) ||
        !Number.isSafeInteger(body.version) ||
        Number(body.version) < 1
      )
        throw new Failure(400, "OCR_JOB_VERSION_REQUIRED");
      if (body.version !== previous.version)
        throw new Failure(409, "OCR_JOB_VERSION_CONFLICT");
      if (Object.hasOwn(body, "mapping")) {
        if (
          !isOcrMapping(body.mapping) ||
          (body.preview !== undefined && body.preview !== true) ||
          Object.keys(body).some(
            (key) => !["version", "mapping", "preview"].includes(key),
          )
        )
          throw new Failure(400, "OCR_JOB_MAPPING_INVALID");
        const sources =
          previous.sourceRows ?? (previous.version === 1 ? previous.rows : undefined);
        if (!sources)
          throw new Failure(400, "OCR_JOB_SOURCE_ROWS_UNAVAILABLE", {
            message: "원본 인식 행이 없는 이전 검토본은 다시 매핑할 수 없습니다.",
          });
        const parsed = parseOcrTableRows(sources, body.mapping);
        if (parsed.mode !== "table" || parsed.rows.length === 0)
          throw new Failure(400, "OCR_JOB_MAPPING_UNUSABLE", {
            message: "선택한 열로 검토 가능한 상품 행을 만들 수 없습니다.",
            analysis: publicAnalysis(parsed),
          });
        const rows = parsed.rows.map((row) => ({ ...row }));
        if (body.preview === true) {
          send(200, {
            preview: {
              jobId: previous.jobId,
              version: previous.version,
              rows,
              analysis: publicAnalysis(parsed),
            },
          });
          return;
        }
        const job: Job = {
          ...previous,
          rows,
          sourceRows: sources,
          mapping: body.mapping,
          version: previous.version + 1,
        };
        checkJobSize(job);
        jobs.set(jobId, job);
        send(200, { job: publicJob(job) });
        return;
      }
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
      send(failure.status, { code: failure.code, ...failure.details });
    } finally {
      if (demoBodyReserved) demoPendingBodies--;
      if (demoRequestReserved) demoActiveRequests--;
      if (providerReserved) active = false;
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config: RelayOptions = JSON.parse(await readFile(process.argv[2], "utf8"));
  createLocalOcrRelay(config).listen(config.port, "127.0.0.1", () =>
    console.log(
      `Local OCR relay listening on 127.0.0.1:${config.port}; reviews are memory-only.`,
    ),
  );
}
