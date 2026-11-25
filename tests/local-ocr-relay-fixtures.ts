import { generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:net";
import { request as httpRequest } from "node:http";
import { createLocalOcrRelay } from "../scripts/local-ocr-relay";

export const issuer =
  "https://cognito-idp.ap-northeast-2.amazonaws.com/ap-northeast-2_Test123";
export const clientId = "localtestclient";
export const origin = "http://localhost:3138";
export const demoOrigin = "https://paradays.web.app";
export const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
export const jwk = {
  ...keys.publicKey.export({ format: "jwk" }),
  kid: "test-key",
  alg: "RS256",
  use: "sig",
};
export const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const canonical = {
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

export function tableProviderFixture(missingHeader = false) {
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

export const servers: ReturnType<typeof createLocalOcrRelay>[] = [];

export function jwt(
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
export async function fixture(
  extra: Partial<Parameters<typeof createLocalOcrRelay>[0]> = {},
) {
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
export function pendingUpload(
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
