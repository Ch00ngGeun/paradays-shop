import { generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:net";
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalOcrRelay } from "../scripts/local-ocr-relay";

const issuer =
  "https://cognito-idp.ap-northeast-2.amazonaws.com/ap-northeast-2_Test123";
const clientId = "localtestclient";
const origin = "http://localhost:3138";
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
const servers: ReturnType<typeof createLocalOcrRelay>[] = [];
afterEach(async () => {
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
  return { request, image, calls, port };
}

describe("local OCR relay boundary and canonical reviews", () => {
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

  it.each([
    ["expired", { exp: 1 }, {}, 401],
    ["wrong issuer", { iss: "https://wrong.example" }, {}, 401],
    ["wrong client", { client_id: "anotherclient" }, {}, 401],
    ["ID token", { token_use: "id" }, {}, 401],
    ["future nbf", { nbf: 4102444800 }, {}, 401],
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

  it("rejects image errors and malformed review rows without overwriting canonical state", async () => {
    const { request, image, calls } = await fixture();
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
  });

  it("caps provider response bytes and rejects invalid provider envelopes", async () => {
    const huge = await fixture({
      fetcher: async () => new Response("x".repeat(2 * 1024 * 1024 + 1)),
    });
    expect((await huge.request(undefined, huge.image)).status).toBe(502);
    const invalid = await fixture({
      fetcher: async () => Response.json({ unrelated: true }),
    });
    expect((await (await invalid.request(undefined, invalid.image)).json()).code).toBe(
      "OCR_PROVIDER_RESPONSE_INVALID",
    );
  });
});
