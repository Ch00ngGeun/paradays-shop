import { generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:net";
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalOcrRelay } from "../scripts/local-ocr-relay";

const issuer =
  "https://cognito-idp.ap-northeast-2.amazonaws.com/ap-northeast-2_Test123";
const clientId = "localtestclient";
const origin = "http://localhost:3138";
const demoOrigin = "https://paradays.web.app";
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = {
  ...keys.publicKey.export({ format: "jwk" }),
  kid: "test-key",
  alg: "RS256",
  use: "sig",
};
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const canonical = {
  result: {
    ocrResults: [
      {
        prunedResult: {
          rec_texts: ["테스트 입고"],
          rec_scores: [0.97],
          rec_boxes: [[1, 2, 30, 40]],
        },
      },
    ],
  },
};

function tableProviderFixture(missingHeader = false) {
  const cells: [string, number, number, number][] = [
    ["Synthetic depot A", 20, 20, 160],
    ["Qty", 20, 75, 45],
    ["Item Name", 180, 75, 100],
    ["Size", 480, 75, 75],
    ["Brand", 700, 75, 95],
    ["23", 30, 150, 25],
    ["Fixture Bearings", 180, 150, 220],
    ["Set of 8", 480, 150, 140],
    ["Juniper Co", 700, 150, 120],
    ["6", 30, 235, 20],
    ["Fixture Griptape", 180, 235, 210],
    ["9 inch", 480, 235, 90],
    ["Echo Goods", 700, 235, 120],
  ].filter(([sourceText]) => !missingHeader || sourceText !== "Size") as [
    string,
    number,
    number,
    number,
  ][];
  const originalRows = cells.map(([sourceText, x, y, width], index) => ({
    id: `ocr_${index + 1}`,
    sourceText,
    confidence: (70 + index) / 100,
    box: [
      [x, y],
      [x + width, y],
      [x + width, y + 20],
      [x, y + 20],
    ],
  }));
  return {
    originalRows,
    envelope: {
      result: {
        ocrResults: [
          {
            prunedResult: {
              rec_texts: originalRows.map((row) => row.sourceText),
              rec_scores: originalRows.map((row) => row.confidence),
              rec_boxes: cells.map(([, x, y, width]) => [x, y, x + width, y + 20]),
            },
          },
        ],
      },
    },
  };
}

const servers: ReturnType<typeof createLocalOcrRelay>[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function jwt(
  overrides: Record<string, unknown> = {},
  headerOverrides: Record<string, unknown> = {},
) {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: "test-key", ...headerOverrides }),
  ).toString("base64url");
  const claims = Buffer.from(
    JSON.stringify({
      iss: issuer,
      client_id: clientId,
      sub: "test-admin",
      token_use: "access",
      exp: 4102444800,
      "cognito:groups": ["admin"],
      ...overrides,
    }),
  ).toString("base64url");
  return `${header}.${claims}.${sign("RSA-SHA256", Buffer.from(`${header}.${claims}`), keys.privateKey).toString("base64url")}`;
}
async function fixture(extra: Partial<Parameters<typeof createLocalOcrRelay>[0]> = {}) {
  const port = await new Promise<number>((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (typeof address === "object" && address)
        probe.close(() => resolve(address.port));
    });
  });
  const calls: RequestInit[] = [];
  const server = createLocalOcrRelay({
    origin,
    port,
    issuer,
    clientId,
    providerUrl: "http://127.0.0.1:8010",
    sharedSecret: "test-provider-secret",
    jwksLoader: async () => ({ keys: [jwk] }),
    fetcher: async (_url, init) => {
      calls.push(init ?? {});
      return Response.json(canonical);
    },
    ...extra,
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  async function request(
    path = "/admin/ocr/jobs",
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
    authorization = jwt(),
    headers: Record<string, string> = {},
  ) {
    return fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        origin,
        authorization: `Bearer ${authorization}`,
        "content-type": "application/json",
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  const image = {
    fileName: "intake.png",
    mimeType: "image/png",
    imageBase64: png.toString("base64"),
  };
  return { request, image, calls, port, server };
}

/** Headers and one byte are sent, but the upload deliberately never completes. */
function pendingUpload(
  port: number,
  path = "/admin/ocr/jobs",
  authorization = jwt(),
  method = "POST",
  headers: Record<string, string> = {},
) {
  let upload: ReturnType<typeof httpRequest>;
  const response = new Promise<{ status: number | undefined; body: unknown }>(
    (resolve, reject) => {
      upload = httpRequest(
        {
          hostname: "127.0.0.1",
          port,
          path,
          method,
          headers: {
            origin: demoOrigin,
            authorization: `Bearer ${authorization}`,
            "content-type": "application/json",
            "content-length": "100000",
            ...headers,
          },
        },
        (incoming) => {
          let body = "";
          incoming.setEncoding("utf8");
          incoming.on("data", (chunk) => {
            body += chunk;
          });
          incoming.on("end", () => {
            try {
              resolve({ status: incoming.statusCode, body: JSON.parse(body) });
            } catch (error) {
              reject(error);
            }
          });
          incoming.on("error", reject);
        },
      );
      upload.on("error", reject);
      upload.flushHeaders();
      upload.write("{");
    },
  );
  return { upload: upload!, response };
}

describe("local OCR relay boundary and canonical reviews", () => {
  it.each([undefined, false])(
    "keeps Firebase disabled without strict opt-in %s",
    async (demoEnabled) => {
      const { request, image, calls } = await fixture({ demoEnabled });
      const response = await request(undefined, image, "POST", jwt(), {
        origin: demoOrigin,
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ code: "LOCAL_OCR_ORIGIN_REQUIRED" });
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      expect(calls).toHaveLength(0);
    },
  );

  it.each([null, "true", "false", 1, 0, {}, []])(
    "rejects malformed demo opt-in %s",
    (demoEnabled) => {
      expect(() =>
        createLocalOcrRelay({
          origin,
          port: 18011,
          issuer,
          clientId,
          providerUrl: "http://127.0.0.1:8010",
          sharedSecret: "test",
          demoEnabled: demoEnabled as boolean,
        }),
      ).toThrow("LOCAL_OCR_CONFIGURATION_INVALID");
    },
  );

  it("adds only the Firebase Origin and exact preflight responses while preserving local access", async () => {
    const { request, image, calls } = await fixture({ demoEnabled: true });
    for (const allowed of [origin, demoOrigin]) {
      const preflight = await request(undefined, undefined, "OPTIONS", "", {
        origin: allowed,
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin")).toBe(allowed);
      expect(preflight.headers.get("vary")).toBe("Origin");
      expect(preflight.headers.get("access-control-allow-methods")).toBe(
        "GET,POST,PATCH,OPTIONS",
      );
      const created = await request(undefined, image, "POST", jwt(), {
        origin: allowed,
      });
      expect(created.status).toBe(201);
      expect(created.headers.get("access-control-allow-origin")).toBe(allowed);
      const { job } = await created.json();
      const loaded = await request(
        `/admin/ocr/jobs/${job.jobId}`,
        undefined,
        "GET",
        jwt(),
        { origin: allowed },
      );
      expect(loaded.status).toBe(200);
      expect((await loaded.json()).job).toEqual(job);
    }
    expect(calls).toHaveLength(2);
  });

  it.each([
    "http://paradays.web.app",
    "https://paradays.web.app/",
    "https://paradays.web.app:443",
    "https://paradays.web.app.evil.example",
    "https://evil.paradays.web.app",
    "https://paradays.firebaseapp.com",
    "https://remote.example",
    "null",
    "",
  ])("rejects non-exact demo Origin %s including preflight", async (disallowed) => {
    const { request, image, calls } = await fixture({ demoEnabled: true });
    for (const [body, method] of [
      [image, "POST"],
      [undefined, "OPTIONS"],
    ] as const) {
      const response = await request(undefined, body, method, jwt(), {
        origin: disallowed,
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ code: "LOCAL_OCR_ORIGIN_REQUIRED" });
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    }
    expect(calls).toHaveLength(0);
  });

  it("preserves production and local-origin configuration guards even with demo enabled", () => {
    const options = {
      origin,
      port: 18011,
      issuer,
      clientId,
      providerUrl: "http://127.0.0.1:8010",
      sharedSecret: "test",
      demoEnabled: true,
    };
    expect(() => createLocalOcrRelay({ ...options, origin: demoOrigin })).toThrow(
      "LOCAL_OCR_CONFIGURATION_INVALID",
    );
    vi.stubEnv("NODE_ENV", "production");
    expect(() => createLocalOcrRelay(options)).toThrow(
      "LOCAL_OCR_CONFIGURATION_INVALID",
    );
  });

  it("does not trust a tunnel or forwarded Host in demo mode", async () => {
    const { port, calls } = await fixture({ demoEnabled: true });
    const pending = pendingUpload(port, undefined, jwt(), "POST", {
      host: "public-tunnel.example",
      "x-forwarded-host": `127.0.0.1:${port}`,
    });
    try {
      expect(await pending.response).toEqual({
        status: 403,
        body: { code: "LOCAL_OCR_ORIGIN_REQUIRED" },
      });
      expect(calls).toHaveLength(0);
    } finally {
      pending.upload.destroy();
    }
  });

  it("does not use an ID token or decoded groups to bypass signed access-token admin authorization", async () => {
    const { request, image, calls } = await fixture({ demoEnabled: true });
    const response = await request(
      undefined,
      image,
      "POST",
      jwt({ "cognito:groups": undefined }),
      {
        origin: demoOrigin,
        "x-local-id-token": jwt({ token_use: "id", aud: clientId }),
      },
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ code: "ADMIN_ROLE_REQUIRED" });
    expect(calls).toHaveLength(0);
  });

  it.each([false, true])(
    "isolates signed admin subjects for GET, review, mapping, preview and stale versions (demo %s)",
    async (demoEnabled) => {
      const { envelope } = tableProviderFixture();
      const { request, image } = await fixture({
        demoEnabled,
        fetcher: async () => Response.json(envelope),
      });
      const headers = { origin: demoEnabled ? demoOrigin : origin };
      const adminA = jwt({ sub: "admin-A" });
      const adminB = jwt({ sub: "admin-B" });
      const createdResponse = await request(undefined, image, "POST", adminA, headers);
      const { job } = await createdResponse.json();
      const path = `/admin/ocr/jobs/${job.jobId}`;
      const mapping = {
        schemaVersion: 1,
        headerRow: 1,
        columns: { productName: 1, brand: 3, option: 2, quantity: 0 },
      };
      const missing = await request(
        "/admin/ocr/jobs/ocr_missing",
        undefined,
        "GET",
        adminB,
        headers,
      );
      const notFound = await missing.json();
      expect(notFound).toEqual({ code: "OCR_JOB_NOT_FOUND" });
      for (const [body, method] of [
        [undefined, "GET"],
        [undefined, "PATCH"],
        [{ version: 1, rows: job.rows }, "PATCH"],
        [{ version: 1, mapping, preview: true }, "PATCH"],
        [{ version: 1, mapping }, "PATCH"],
        [{ version: 999, rows: job.rows }, "PATCH"],
        [{ version: 0, mapping: null }, "PATCH"],
      ] as const) {
        const denied = await request(path, body, method, adminB, headers);
        expect(denied.status).toBe(404);
        expect(await denied.json()).toEqual(notFound);
      }
      const previewResponse = await request(
        path,
        { version: 1, mapping, preview: true },
        "PATCH",
        adminA,
        headers,
      );
      expect(previewResponse.status).toBe(200);
      const preview = (await previewResponse.json()).preview;
      const appliedResponse = await request(
        path,
        { version: 1, mapping },
        "PATCH",
        adminA,
        headers,
      );
      expect(appliedResponse.status).toBe(200);
      const applied = (await appliedResponse.json()).job;
      expect(applied.version).toBe(2);
      expect(applied.rows).toEqual(preview.rows);
      const reviewedResponse = await request(
        path,
        { version: 2, rows: applied.rows, ownerSub: "admin-B" },
        "PATCH",
        adminA,
        headers,
      );
      const reviewed = (await reviewedResponse.json()).job;
      expect(reviewed.version).toBe(3);
      expect(
        (await request(path, { version: 1, mapping }, "PATCH", adminA, headers)).status,
      ).toBe(409);
      const deniedStale = await request(
        path,
        { version: 1, mapping },
        "PATCH",
        adminB,
        headers,
      );
      expect(deniedStale.status).toBe(404);
      expect(await deniedStale.json()).toEqual(notFound);
      expect(
        (await (await request(path, undefined, "GET", adminA, headers)).json()).job,
      ).toEqual(reviewed);
      for (const publicValue of [job, preview, applied, reviewed]) {
        expect(publicValue).not.toHaveProperty("ownerSub");
        expect(publicValue).not.toHaveProperty("sourceRows");
        expect(JSON.stringify(publicValue)).not.toContain("admin-A");
        expect(JSON.stringify(publicValue)).not.toContain("admin-B");
        expect(JSON.stringify(publicValue)).not.toContain("test-provider-secret");
      }
    },
  );

  it.each([false, true])(
    "rechecks latest canonical version after a held same-owner PATCH body (demo %s)",
    async (demoEnabled) => {
      const { request, image, port, server } = await fixture({ demoEnabled });
      const token = jwt({ sub: "same-owner" });
      const headers = { origin: demoEnabled ? demoOrigin : origin };
      const { job } = await (
        await request(undefined, image, "POST", token, headers)
      ).json();
      const path = `/admin/ocr/jobs/${job.jobId}`;
      const slowBody = JSON.stringify({
        version: 1,
        rawText: "Slow obsolete raw text",
        rows: job.rows.map((row: Record<string, unknown>) => ({
          ...row,
          sourceText: "Slow obsolete source",
          productName: "Slow obsolete product",
          confidence: 0,
          box: [
            [999, 999],
            [1000, 1000],
          ],
        })),
      });
      const started = new Promise<void>((resolve) => {
        server.once("request", () => resolve());
      });
      const held = pendingUpload(port, path, token, "PATCH", {
        ...headers,
        "content-length": String(Buffer.byteLength(slowBody)),
      });
      void held.response.catch(() => {});
      try {
        await started;
        expect((await request(path, undefined, "GET", token, headers)).status).toBe(
          200,
        );
        const fast = await request(
          path,
          {
            version: 1,
            rawText: "Fast canonical raw text",
            rows: job.rows.map((row: Record<string, unknown>) => ({
              ...row,
              sourceText: "Fast canonical source",
              productName: "Fast canonical product",
              confidence: 0,
              box: [
                [777, 777],
                [888, 888],
              ],
            })),
          },
          "PATCH",
          token,
          headers,
        );
        expect(fast.status).toBe(200);
        const saved = (await fast.json()).job;
        expect(saved.version).toBe(2);
        expect(saved.rows[0].confidence).toBe(job.rows[0].confidence);
        expect(saved.rows[0].box).toEqual(job.rows[0].box);
        held.upload.end(slowBody.slice(1));
        expect(await held.response).toEqual({
          status: 409,
          body: { code: "OCR_JOB_VERSION_CONFLICT" },
        });
        expect(
          (await (await request(path, undefined, "GET", token, headers)).json()).job,
        ).toEqual(saved);
      } finally {
        held.upload.destroy();
      }
    },
  );

  it("bounds demo requests before a stalled JWKS lookup completes", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { request, image, calls, server } = await fixture({
      demoEnabled: true,
      jwksLoader: async () => {
        await gate;
        return { keys: [jwk] };
      },
    });
    let started = 0;
    const fourStarted = new Promise<void>((resolve) => {
      server.on("request", () => {
        if (++started === 4) resolve();
      });
    });
    const waiting = Array.from({ length: 4 }, () => request(undefined, image));
    try {
      await fourStarted;
      const overflow = await request(undefined, image);
      expect(overflow.status).toBe(429);
      expect(await overflow.json()).toEqual({ code: "LOCAL_OCR_LIMIT_REACHED" });
      expect(calls).toHaveLength(0);
    } finally {
      release();
    }
    const responses = await Promise.all(waiting);
    expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 429)).toHaveLength(3);
    expect((await request(undefined, image)).status).toBe(201);
  });

  it("reserves demo OCR before upload, times out a stalled body and releases all slots", async () => {
    const { request, image, calls, port, server } = await fixture({
      demoEnabled: true,
    });
    const started = new Promise<void>((resolve) => {
      server.once("request", () => resolve());
    });
    const first = pendingUpload(port);
    try {
      await started;
      // The completed GET guarantees the first handler has passed its auth microtask.
      expect((await request("/admin/ocr/jobs/ocr_missing")).status).toBe(404);
      const overflow = pendingUpload(port);
      try {
        expect(await overflow.response).toEqual({
          status: 429,
          body: { code: "OCR_PROVIDER_BUSY" },
        });
        expect(calls).toHaveLength(0);
      } finally {
        overflow.upload.destroy();
      }
      expect(await first.response).toEqual({
        status: 408,
        body: { code: "LOCAL_OCR_BODY_TIMEOUT" },
      });
      expect(calls).toHaveLength(0);
      expect((await request(undefined, image)).status).toBe(201);
      expect(calls).toHaveLength(1);
    } finally {
      first.upload.destroy();
    }
  }, 10000);

  it("caps pending demo PATCH bodies before allocation and permits GET without reading a body", async () => {
    const { request, image, port, server } = await fixture({ demoEnabled: true });
    const { job } = await (await request(undefined, image)).json();
    const path = `/admin/ocr/jobs/${job.jobId}`;
    let count = 0;
    const started = new Promise<void>((resolve) => {
      server.on("request", () => {
        if (++count === 2) resolve();
      });
    });
    const pending = [
      pendingUpload(port, path, jwt(), "PATCH"),
      pendingUpload(port, path, jwt(), "PATCH"),
    ];
    for (const entry of pending) void entry.response.catch(() => {});
    try {
      await started;
      expect((await request(path)).status).toBe(200);
      const overflow = pendingUpload(port, path, jwt(), "PATCH");
      try {
        expect(await overflow.response).toEqual({
          status: 429,
          body: { code: "LOCAL_OCR_LIMIT_REACHED" },
        });
      } finally {
        overflow.upload.destroy();
      }
      expect((await (await request(path)).json()).job).toEqual(job);
    } finally {
      for (const entry of pending) entry.upload.destroy();
    }
  });

  it("limits all authenticated demo GET/PATCH requests, not only OCR POST", async () => {
    let now = Date.now();
    const { request, image } = await fixture({ demoEnabled: true, now: () => now });
    const { job } = await (await request(undefined, image)).json();
    const path = `/admin/ocr/jobs/${job.jobId}`;
    for (let index = 0; index < 119; index++)
      expect((await request(path)).status).toBe(200);
    for (const [body, method] of [
      [undefined, "GET"],
      [{ version: 1, rows: job.rows }, "PATCH"],
    ] as const) {
      const limited = await request(path, body, method);
      expect(limited.status).toBe(429);
      expect(await limited.json()).toEqual({ code: "LOCAL_OCR_LIMIT_REACHED" });
    }
    now += 60000;
    expect((await (await request(path)).json()).job).toEqual(job);
  });

  it("shares a bounded cheap demo budget for health and preflight without authentication", async () => {
    let now = Date.now();
    const { request, calls } = await fixture({ demoEnabled: true, now: () => now });
    for (let index = 0; index < 240; index++) {
      const response =
        index % 2 === 0
          ? await request("/healthz", undefined, "GET", "")
          : await request(undefined, undefined, "OPTIONS", "", { origin: demoOrigin });
      expect(response.status).toBe(index % 2 === 0 ? 200 : 204);
    }
    expect((await request("/healthz", undefined, "GET", "")).status).toBe(429);
    now += 60000;
    expect(
      (await request(undefined, undefined, "OPTIONS", "", { origin: demoOrigin }))
        .status,
    ).toBe(204);
    expect(calls).toHaveLength(0);
  });

  it("enforces the existing 30 OCR/minute limit before reading a demo upload", async () => {
    let now = Date.now();
    const { request, image, calls, port } = await fixture({
      demoEnabled: true,
      now: () => now,
    });
    for (let index = 0; index < 30; index++)
      expect((await request(undefined, image)).status).toBe(201);
    const pending = pendingUpload(port);
    try {
      expect(await pending.response).toEqual({
        status: 429,
        body: { code: "LOCAL_OCR_LIMIT_REACHED" },
      });
      expect(calls).toHaveLength(30);
      now += 60000;
      expect((await request(undefined, image)).status).toBe(201);
    } finally {
      pending.upload.destroy();
    }
  });

  it("enforces the existing 100-job cap before reading a demo upload", async () => {
    let now = Date.now();
    const { request, image, calls, port } = await fixture({
      demoEnabled: true,
      now: () => now,
    });
    for (let index = 0; index < 100; index++) {
      if (index > 0 && index % 25 === 0) now += 60000;
      expect((await request(undefined, image)).status).toBe(201);
    }
    const pending = pendingUpload(port);
    try {
      expect(await pending.response).toEqual({
        status: 429,
        body: { code: "LOCAL_OCR_LIMIT_REACHED" },
      });
      expect(calls).toHaveLength(100);
    } finally {
      pending.upload.destroy();
    }
  });
  it("previews drag regions read-only and persists canonical sources across apply/review/GET", async () => {
    const { envelope } = tableProviderFixture();
    const { request, image } = await fixture({
      fetcher: async () => Response.json(envelope),
    });
    const created = (await (await request(undefined, image)).json()).job;
    const path = `/admin/ocr/jobs/${created.jobId}`;
    const mapping = {
      schemaVersion: 2,
      parserVersion: 1,
      kind: "regions",
      image: { width: 1000, height: 1000 },
      firstRow: {
        productName: { left: 0.17, top: 0.14, right: 0.41, bottom: 0.18 },
        brand: { left: 0.69, top: 0.14, right: 0.84, bottom: 0.18 },
        option: { left: 0.47, top: 0.14, right: 0.64, bottom: 0.18 },
        quantity: { left: 0.02, top: 0.14, right: 0.065, bottom: 0.18 },
      },
      tableBottom: 0.28,
      secondRowY: null,
      quantityConfirmed: true,
    };
    const previewResponse = await request(
      path,
      { version: 1, mapping, preview: true },
      "PATCH",
    );
    expect(previewResponse.status).toBe(200);
    const preview = (await previewResponse.json()).preview;
    expect(preview.rows).toHaveLength(2);
    expect(preview.rows[0]).toMatchObject({
      id: "ocr_6",
      productName: "Fixture Bearings",
      quantity: "23",
    });
    expect(preview.analysis.region).toMatchObject({
      sourceTokenCount: 13,
      includedTokenCount: 8,
      excludedTokenCount: 5,
    });
    expect((await (await request(path)).json()).job).toEqual(created);
    const appliedResponse = await request(path, { version: 1, mapping }, "PATCH");
    expect(appliedResponse.status).toBe(200);
    const applied = (await appliedResponse.json()).job;
    expect(applied.version).toBe(2);
    expect(applied.rows).toEqual(preview.rows);
    const reviewedResponse = await request(
      path,
      {
        version: 2,
        rows: applied.rows.map((row: Record<string, unknown>) => ({
          ...row,
          productName: "Edited",
          confidence: 0,
          box: [
            [999, 999],
            [1000, 1000],
          ],
        })),
      },
      "PATCH",
    );
    const reviewed = (await reviewedResponse.json()).job;
    expect(reviewed.rows[0].confidence).toBe(applied.rows[0].confidence);
    expect(reviewed.rows[0].box).toEqual(applied.rows[0].box);
    expect(reviewed.analysis.mapping).toEqual(mapping);
    expect((await (await request(path)).json()).job).toEqual(reviewed);
    expect((await request(path, { version: 1, mapping }, "PATCH")).status).toBe(409);
    expect(
      (
        await request(
          path,
          { version: 3, mapping: { ...mapping, quantityConfirmed: false } },
          "PATCH",
        )
      ).status,
    ).toBe(400);
    const again = (
      await (
        await request(path, { version: 3, mapping, preview: true }, "PATCH")
      ).json()
    ).preview;
    expect(again.rows).toEqual(preview.rows);
  });
  it.each([0, -1, 130001, 1.5, NaN, Infinity, "12000", false])(
    "rejects invalid local timeout override %s",
    (providerTimeoutMs) => {
      expect(() =>
        createLocalOcrRelay({
          origin,
          port: 18011,
          issuer,
          clientId,
          providerUrl: "http://127.0.0.1:8010",
          sharedSecret: "test",
          providerTimeoutMs: providerTimeoutMs as number,
        }),
      ).toThrow("LOCAL_OCR_CONFIGURATION_INVALID");
    },
  );

  it("keeps a bounded override and blocks another OCR while provider work is pending", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const { request, image } = await fixture({
      providerTimeoutMs: 130000,
      fetcher: async () => {
        entered();
        await gate;
        return Response.json(canonical);
      },
    });
    const first = request(undefined, image);
    await started;
    expect((await request(undefined, image)).status).toBe(429);
    release();
    expect((await first).status).toBe(201);
    expect((await request(undefined, image)).status).toBe(201);
  });

  it("returns a safe bounded provider timeout without storing a review", async () => {
    const { request, image } = await fixture({
      providerTimeoutMs: 25,
      fetcher: async () => new Promise<Response>(() => {}),
    });
    const response = await request(undefined, image);
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ code: "OCR_PROVIDER_REQUEST_FAILED" });
  });

  it.each([
    [false, 130000, 130000],
    [true, undefined, 12000],
    [true, 12000, 12000],
    [true, 130000, 115000],
  ] as const)(
    "caps only demo provider deadline (demo %s, override %s)",
    async (demoEnabled, providerTimeoutMs, expected) => {
      const { request, image } = await fixture({ demoEnabled, providerTimeoutMs });
      const timeout = vi.spyOn(globalThis, "setTimeout");
      try {
        expect((await request(undefined, image)).status).toBe(201);
        expect(timeout).toHaveBeenCalledWith(expect.any(Function), expected);
        if (demoEnabled)
          expect(timeout).not.toHaveBeenCalledWith(expect.any(Function), 130000);
      } finally {
        timeout.mockRestore();
      }
    },
  );

  it("uses the private provider contract, then preserves rawText and metadata on PATCH/GET", async () => {
    const { request, image, calls } = await fixture();
    const created = await request(undefined, image);
    expect(created.status).toBe(201);
    const { job } = await created.json();
    expect(job.rows[0].sourceText).toBe("테스트 입고");
    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0].body))).toEqual({
      file: image.imageBase64,
      fileType: 1,
      visualize: false,
    });
    expect(calls[0].headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer test-provider-secret",
    });
    const path = `/admin/ocr/jobs/${job.jobId}`;
    const patch = await request(
      path,
      {
        version: 1,
        rawText: " \n수정됨\n ",
        rows: [
          {
            ...job.rows[0],
            sourceText: "",
            productName: "수정 상품",
            quantity: "2",
            confidence: 0,
            box: [
              [0, 0],
              [1, 1],
            ],
          },
        ],
      },
      "PATCH",
    );
    expect(patch.status).toBe(200);
    const saved = (await patch.json()).job;
    expect(saved.version).toBe(2);
    expect(saved.rawText).toBe(" \n수정됨\n ");
    expect(saved.rows[0].sourceText).toBe("");
    expect(saved.rows[0].confidence).toBe(0.97);
    expect(saved.rows[0].box).toEqual([
      [1, 2],
      [30, 2],
      [30, 40],
      [1, 40],
    ]);
    expect((await (await request(path)).json()).job).toEqual(saved);
    expect(JSON.stringify(saved)).not.toContain("imageBase64");
    expect(JSON.stringify(saved)).not.toContain("test-provider-secret");
    expect(JSON.stringify(saved)).not.toContain("expiresAt");
    expect(
      (await request(path, { version: 1, rows: saved.rows }, "PATCH")).status,
    ).toBe(409);
    const blank = await request(
      path,
      { version: 2, rawText: "", rows: saved.rows },
      "PATCH",
    );
    expect((await blank.json()).job.rawText).toBe("");
  });

  it("groups table products and preserves editable fields, original metadata, and conflicts", async () => {
    const { envelope, originalRows } = tableProviderFixture();
    const { request, image } = await fixture({
      fetcher: async () => Response.json(envelope),
    });
    const created = await request(undefined, image);
    expect(created.status).toBe(201);
    const { job } = await created.json();
    const expectedRows = [
      {
        ...originalRows[5],
        sourceText: "23 | Fixture Bearings | Set of 8 | Juniper Co",
        productName: "Fixture Bearings",
        brand: "Juniper Co",
        option: "Set of 8",
        quantity: "23",
      },
      {
        ...originalRows[9],
        sourceText: "6 | Fixture Griptape | 9 inch | Echo Goods",
        productName: "Fixture Griptape",
        brand: "Echo Goods",
        option: "9 inch",
        quantity: "6",
      },
    ];
    expect(job.rows).toEqual(expectedRows);
    expect(job.rawText).toBe(originalRows.map((row) => row.sourceText).join("\n"));
    expect(job.version).toBe(1);
    expect(job).not.toHaveProperty("sourceRows");

    const editedRows = expectedRows.map((row, index) => ({
      ...row,
      ...(index === 1
        ? { productName: "Fixture Griptape revised", quantity: "9" }
        : {}),
    }));
    const path = `/admin/ocr/jobs/${job.jobId}`;
    const patched = await request(
      path,
      {
        version: 1,
        rows: editedRows.map((row) => ({
          ...row,
          confidence: 0,
          box: [
            [999, 999],
            [1000, 1000],
          ],
        })),
        sourceRows: [{ id: "forged", sourceText: "replaced originals" }],
      },
      "PATCH",
    );
    expect(patched.status).toBe(200);
    const saved = (await patched.json()).job;
    expect(saved.jobId).toBe(job.jobId);
    expect(saved.version).toBe(2);
    expect(saved.rawText).toBe(job.rawText);
    expect(saved.rows).toEqual(editedRows);
    expect(saved).not.toHaveProperty("sourceRows");
    const loaded = await request(path);
    expect(loaded.status).toBe(200);
    expect((await loaded.json()).job).toEqual(saved);
    const stale = await request(path, { version: 1, rows: editedRows }, "PATCH");
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ code: "OCR_JOB_VERSION_CONFLICT" });
    expect((await (await request(path)).json()).job).toEqual(saved);
  });

  it("retains every token and metadata when a table header is missing", async () => {
    const { envelope, originalRows } = tableProviderFixture(true);
    const { request, image } = await fixture({
      fetcher: async () => Response.json(envelope),
    });
    const created = await request(undefined, image);
    expect(created.status).toBe(201);
    const { job } = await created.json();
    expect(job.rows).toEqual(
      originalRows.map((row) => ({
        ...row,
        productName: "",
        brand: "",
        option: "",
        quantity: "",
      })),
    );
    expect(job.rawText).toBe(originalRows.map((row) => row.sourceText).join("\n"));
    expect(job).not.toHaveProperty("sourceRows");
    const loaded = await request(`/admin/ocr/jobs/${job.jobId}`);
    expect(loaded.status).toBe(200);
    expect((await loaded.json()).job).toEqual(job);
  });

  it("previews without mutation and reapplies mapping from original tokens after ordinary edits", async () => {
    const { envelope } = tableProviderFixture();
    const { request, image } = await fixture({
      fetcher: async () => Response.json(envelope),
    });
    const created = await request(undefined, image);
    const { job } = await created.json();
    const path = `/admin/ocr/jobs/${job.jobId}`;
    const mapping = {
      schemaVersion: 1,
      headerRow: 1,
      columns: { productName: 1, brand: 3, option: 2, quantity: 0 },
    };
    const previewResponse = await request(
      path,
      {
        version: 1,
        mapping,
        preview: true,
      },
      "PATCH",
    );
    expect(previewResponse.status).toBe(200);
    const previewBody = await previewResponse.json();
    expect(previewBody).not.toHaveProperty("job");
    const preview = previewBody.preview;
    expect(preview.version).toBe(1);
    expect(preview.analysis.mode).toBe("table");
    expect(preview.rows[0].productName).toBe("Fixture Bearings");
    expect(preview).not.toHaveProperty("sourceRows");
    expect((await (await request(path)).json()).job).toEqual(job);

    const applyResponse = await request(path, { version: 1, mapping }, "PATCH");
    expect(applyResponse.status).toBe(200);
    const applied = (await applyResponse.json()).job;
    expect(applied.version).toBe(2);
    expect(applied.rows).toEqual(preview.rows);
    expect(applied.analysis.mapping).toEqual(mapping);
    expect(applied).not.toHaveProperty("sourceRows");
    const edited = await request(
      path,
      {
        version: 2,
        rawText: "operator revised text",
        rows: applied.rows.map((row: Record<string, unknown>) => ({
          ...row,
          sourceText: "operator revised source",
          productName: "operator revised product",
          confidence: 0,
          box: [
            [999, 999],
            [1000, 1000],
          ],
        })),
        sourceRows: [{ id: "forged", sourceText: "fake source" }],
      },
      "PATCH",
    );
    expect(edited.status).toBe(200);
    const reviewed = (await edited.json()).job;
    expect(reviewed.version).toBe(3);
    expect(reviewed.analysis).toEqual(applied.analysis);
    applied.rows.forEach((row: Record<string, unknown>, index: number) => {
      expect(reviewed.rows[index].confidence).toBe(row.confidence);
      expect(reviewed.rows[index].box).toEqual(row.box);
    });
    const swapped = {
      ...mapping,
      columns: { productName: 3, brand: 1, option: 2, quantity: 0 },
    };
    const remappedResponse = await request(
      path,
      {
        version: 3,
        mapping: swapped,
      },
      "PATCH",
    );
    expect(remappedResponse.status).toBe(200);
    const remapped = (await remappedResponse.json()).job;
    expect(remapped.version).toBe(4);
    expect(remapped.rawText).toBe("operator revised text");
    expect(remapped.rows[0].productName).toBe("Juniper Co");
    expect(remapped.rows[0].brand).toBe("Fixture Bearings");
    expect(remapped.rows.map((row: { id: string }) => row.id)).toEqual(
      applied.rows.map((row: { id: string }) => row.id),
    );
    expect(remapped.rows[0].sourceText).toContain("Fixture Bearings");
    const repeated = await request(
      path,
      {
        version: 4,
        mapping: swapped,
        preview: true,
      },
      "PATCH",
    );
    expect(repeated.status).toBe(200);
    expect((await repeated.json()).preview.rows).toEqual(remapped.rows);
    expect((await (await request(path)).json()).job).toEqual(remapped);
    const stale = await request(path, { version: 3, mapping }, "PATCH");
    expect(stale.status).toBe(409);
    expect((await (await request(path)).json()).job).toEqual(remapped);
  });

  it("rejects malformed, mixed and forged mapping requests without changing the review", async () => {
    const { envelope } = tableProviderFixture();
    const { request, image } = await fixture({
      fetcher: async () => Response.json(envelope),
    });
    const { job } = await (await request(undefined, image)).json();
    const path = `/admin/ocr/jobs/${job.jobId}`;
    const mapping = {
      schemaVersion: 1,
      headerRow: 1,
      columns: { productName: 1, brand: 3, option: 2, quantity: 0 },
    };
    for (const body of [
      { version: 1, mapping: null },
      { version: 1, mapping: { ...mapping, schemaVersion: 2 } },
      { version: 1, mapping: { ...mapping, headerRow: 500 } },
      { version: 1, mapping: { ...mapping, unexpected: "raw OCR" } },
      {
        version: 1,
        mapping: { ...mapping, columns: { ...mapping.columns, brand: 1 } },
      },
      { version: 1, mapping, preview: false },
      { version: 1, mapping, rows: job.rows },
      { version: 1, mapping, rawText: "forged" },
      { version: 1, mapping, sourceRows: [] },
    ]) {
      const result = await request(path, body, "PATCH");
      expect(result.status).toBe(400);
      expect((await result.json()).code).toBe("OCR_JOB_MAPPING_INVALID");
    }
    const outOfRange = await request(
      path,
      {
        version: 1,
        mapping: { ...mapping, columns: { ...mapping.columns, quantity: 19 } },
      },
      "PATCH",
    );
    expect(outOfRange.status).toBe(400);
    expect((await outOfRange.json()).code).toBe("OCR_JOB_MAPPING_UNUSABLE");
    expect((await (await request(path)).json()).job).toEqual(job);
  });

  it("returns an explicit mapping error for an unclassified OCR source", async () => {
    const { request, image } = await fixture();
    const { job } = await (await request(undefined, image)).json();
    const path = `/admin/ocr/jobs/${job.jobId}`;
    const result = await request(
      path,
      {
        version: 1,
        mapping: {
          schemaVersion: 1,
          headerRow: 0,
          columns: { productName: 0, brand: null, option: null, quantity: null },
        },
        preview: true,
      },
      "PATCH",
    );
    expect(result.status).toBe(400);
    const error = await result.json();
    expect(error.code).toBe("OCR_JOB_MAPPING_UNUSABLE");
    expect(error.message).toBeTruthy();
    expect((await (await request(path)).json()).job).toEqual(job);
  });

  it.each([
    ["expired", { exp: 1 }, {}, 401],
    ["wrong issuer", { iss: "https://wrong.example" }, {}, 401],
    ["wrong client", { client_id: "anotherclient" }, {}, 401],
    ["ID token", { token_use: "id" }, {}, 401],
    ["future nbf", { nbf: 4102444800 }, {}, 401],
    ["empty subject", { sub: "" }, {}, 401],
    ["missing subject", { sub: undefined }, {}, 401],
    ["non-admin", { "cognito:groups": ["support"] }, {}, 403],
    ["no group", { "cognito:groups": undefined }, {}, 403],
    ["unknown key", {}, { kid: "unknown" }, 401],
    ["none algorithm", {}, { alg: "none" }, 401],
  ])("rejects %s before provider calls", async (_name, claims, header, status) => {
    const { request, image, calls } = await fixture();
    expect((await request(undefined, image, "POST", jwt(claims, header))).status).toBe(
      status,
    );
    expect(calls).toHaveLength(0);
  });

  it("rejects forged signatures, missing bearer, remote Origin and rebinding Host", async () => {
    const { request, image, calls, port } = await fixture();
    const token = jwt();
    const parts = token.split(".");
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    parts[1] = Buffer.from(JSON.stringify({ ...payload, sub: "forged" })).toString(
      "base64url",
    );
    expect((await request(undefined, image, "POST", parts.join("."))).status).toBe(401);
    expect(
      (await request(undefined, image, "POST", token, { authorization: "" })).status,
    ).toBe(401);
    expect(
      (
        await request(undefined, image, "POST", token, {
          origin: "https://remote.example",
        })
      ).status,
    ).toBe(403);
    const rebindingStatus = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(
        {
          hostname: "127.0.0.1",
          port,
          path: "/admin/ocr/jobs",
          method: "POST",
          headers: {
            host: "remote.example",
            origin,
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
        },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode));
        },
      );
      request.on("error", reject);
      request.end(JSON.stringify(image));
    });
    expect(rebindingStatus).toBe(403);
    expect(
      (await request(undefined, image, "POST", token, { origin: "" })).status,
    ).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("expires reviews after seven days and loses them on a new server", async () => {
    let now = Date.now();
    const first = await fixture({ now: () => now });
    const { job } = await (await first.request(undefined, first.image)).json();
    const second = await fixture();
    expect((await second.request(`/admin/ocr/jobs/${job.jobId}`)).status).toBe(404);
    now += 7 * 24 * 60 * 60 * 1000;
    expect((await first.request(`/admin/ocr/jobs/${job.jobId}`)).status).toBe(404);
  });

  it.each([false, true])(
    "rejects image errors and malformed review rows without overwriting canonical state (demo %s)",
    async (demoEnabled) => {
      const { request, image, calls } = await fixture({ demoEnabled });
      expect(
        (await request(undefined, { ...image, imageBase64: "invalid" })).status,
      ).toBe(400);
      expect(
        (
          await request(undefined, {
            ...image,
            imageBase64: Buffer.alloc(4 * 1024 * 1024 + 1).toString("base64"),
          })
        ).status,
      ).toBe(413);
      expect(calls).toHaveLength(0);
      const { job } = await (await request(undefined, image)).json();
      const path = `/admin/ocr/jobs/${job.jobId}`;
      expect(
        (await request(path, { version: 1, rawText: "\0", rows: job.rows }, "PATCH"))
          .status,
      ).toBe(400);
      expect(
        (await request(path, { version: 1, rows: [job.rows[0], job.rows[0]] }, "PATCH"))
          .status,
      ).toBe(400);
      expect(
        (
          await request(
            path,
            { version: 1, rows: [{ ...job.rows[0], quantity: "-1" }] },
            "PATCH",
          )
        ).status,
      ).toBe(400);
      expect((await (await request(path)).json()).job.version).toBe(1);
    },
  );

  it.each([false, true])(
    "caps provider response bytes and rejects invalid provider envelopes (demo %s)",
    async (demoEnabled) => {
      const huge = await fixture({
        demoEnabled,
        fetcher: async () => new Response("x".repeat(2 * 1024 * 1024 + 1)),
      });
      expect((await huge.request(undefined, huge.image)).status).toBe(502);
      const invalid = await fixture({
        demoEnabled,
        fetcher: async () => Response.json({ unrelated: true }),
      });
      expect(
        (await (await invalid.request(undefined, invalid.image)).json()).code,
      ).toBe("OCR_PROVIDER_RESPONSE_INVALID");
    },
  );
});
