/** Real handler PATCH/GET cycles with in-memory SDK transport and no network. */
import assert from "node:assert/strict";
import { type TestContext } from "node:test";
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { documentClient } from "../lambda/dynamodb-client.js";

const JOB_ID = "ocr_test_job";
let secretFixtureId = 0;
export const BOX = [
  [1, 2],
  [3, 2],
  [3, 4],
  [1, 4],
];

export function initialJob() {
  return {
    recordType: "OCR_JOB",
    jobId: JOB_ID,
    createdBy: "creator-sub",
    updatedBy: "creator-sub",
    version: 1,
    rawText: "ORIGINAL OCR",
    rows: [{ id: "ocr_1", sourceText: "ORIGINAL OCR", confidence: 0.9, box: BOX }],
    createdAt: "2026-10-07T00:00:00.000Z",
    updatedAt: "2026-10-07T00:00:00.000Z",
    expiresAt: 1_800_000_000,
  };
}

export function reviewedRow(id = "manual_1", sourceText = "") {
  return {
    id,
    sourceText,
    productName: "Manual product",
    brand: "",
    option: "",
    quantity: "2",
  };
}

export function event(
  method: "GET" | "PATCH" | "POST",
  body?: unknown,
  claims: Record<string, unknown> = { sub: "admin-sub", "cognito:groups": "admin" },
  jobId = JOB_ID,
) {
  return {
    rawPath: method === "POST" ? "/admin/ocr/jobs" : `/admin/ocr/jobs/${jobId}`,
    headers: {},
    isBase64Encoded: false,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    requestContext: {
      http: { method },
      authorizer: { jwt: { claims } },
    },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

export function unpack(response: APIGatewayProxyResultV2) {
  assert.ok(typeof response === "object" && response !== null);
  assert.ok("body" in response && typeof response.body === "string");
  return { status: response.statusCode, body: JSON.parse(response.body) };
}

export function fixture(t: TestContext, providerEnvelope?: unknown) {
  const previousTable = process.env.OCR_JOB_TABLE_NAME;
  const previousSecret = process.env.PADDLE_OCR_SECRET_ARN;
  process.env.OCR_JOB_TABLE_NAME = "test-ocr-jobs";
  if (providerEnvelope !== undefined) {
    process.env.PADDLE_OCR_SECRET_ARN = `test-only-secret-${secretFixtureId++}`;
  }
  t.after(() => {
    if (previousTable === undefined) delete process.env.OCR_JOB_TABLE_NAME;
    else process.env.OCR_JOB_TABLE_NAME = previousTable;
    if (previousSecret === undefined) delete process.env.PADDLE_OCR_SECRET_ARN;
    else process.env.PADDLE_OCR_SECRET_ARN = previousSecret;
  });
  let stored: Record<string, unknown> = structuredClone(initialJob());
  let conditionalFailure = false;
  const writes: PutCommand["input"][] = [];
  const reads: GetCommand["input"][] = [];
  const send = t.mock.method(documentClient, "send", async (command: unknown) => {
    if (command instanceof GetCommand) {
      reads.push(command.input);
      return { Item: structuredClone(stored) };
    }
    if (command instanceof PutCommand) {
      if (conditionalFailure) {
        throw Object.assign(new Error("private-database-details"), {
          name: "ConditionalCheckFailedException",
        });
      }
      assert.equal(command.input.TableName, "test-ocr-jobs");
      if (command.input.ConditionExpression === "attribute_not_exists(jobId)") {
        assert.equal(providerEnvelope !== undefined, true);
      } else {
        assert.equal(command.input.ConditionExpression, "#version = :expectedVersion");
        assert.equal(
          command.input.ExpressionAttributeValues?.[":expectedVersion"],
          stored.version,
        );
      }
      writes.push(command.input);
      stored = structuredClone(command.input.Item!);
      return {};
    }
    throw new Error("Unexpected DynamoDB command");
  });
  const noNetwork = async () => {
    throw new Error("Network must not be called");
  };
  const cognito = t.mock.method(
    CognitoIdentityProviderClient.prototype,
    "send",
    noNetwork,
  );
  const secrets = t.mock.method(
    SecretsManagerClient.prototype,
    "send",
    providerEnvelope === undefined
      ? noNetwork
      : async () => ({
          SecretString: JSON.stringify({
            baseUrl: "https://ocr.example.test/provider",
            sharedSecret: "test-only-shared-secret",
          }),
        }),
  );
  const fetch = t.mock.method(
    globalThis,
    "fetch",
    providerEnvelope === undefined
      ? noNetwork
      : async () => new Response(JSON.stringify(providerEnvelope)),
  );
  t.after(() => {
    assert.equal(cognito.mock.callCount(), 0);
    assert.equal(secrets.mock.callCount(), providerEnvelope === undefined ? 0 : 1);
    assert.equal(fetch.mock.callCount(), providerEnvelope === undefined ? 0 : 1);
  });
  return {
    writes,
    reads,
    send,
    set failConditionalWrites(value: boolean) {
      conditionalFailure = value;
    },
    get stored() {
      return stored;
    },
    set stored(value: Record<string, unknown>) {
      stored = value;
    },
  };
}
export function uploadBody() {
  return {
    fileName: "fixture.png",
    mimeType: "image/png",
    imageBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString(
      "base64",
    ),
  };
}
export function providerBody(texts: string[]) {
  return {
    result: {
      ocrResults: [
        {
          prunedResult: {
            rec_texts: texts,
            rec_scores: texts.map(() => 0.9),
            rec_boxes: texts.map(() => BOX),
          },
        },
      ],
    },
  };
}

export function tableProviderFixture(missingHeader = false) {
  const cells: [string, number, number, number][] = [
    ["Inventory batch Z", 40, 20, 170],
    ["상품명", 40, 75, 100],
    ["브랜드", 320, 75, 90],
    ["옵션", 520, 75, 80],
    ["수량", 770, 75, 60],
    ["Canyon Cargo Shirt", 40, 145, 220],
    ["North Loom", 320, 145, 140],
    ["Olive / XL", 520, 145, 140],
    ["17", 790, 145, 25],
    ["Metric Truck", 40, 240, 190],
    ["Arc Foundry", 320, 240, 140],
    ["149 mm", 520, 240, 100],
    ["4", 790, 240, 20],
  ].filter(([sourceText]) => !missingHeader || sourceText !== "브랜드") as [
    string,
    number,
    number,
    number,
  ][];
  const originalRows = cells.map(([sourceText, x, y, width], index) => ({
    id: `ocr_${index + 1}`,
    sourceText,
    confidence: (80 + index) / 100,
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
export const tableMapping = {
  schemaVersion: 1,
  headerRow: 1,
  columns: { productName: 0, brand: 1, option: 2, quantity: 3 },
};
