/** Real handler PATCH/GET cycles with in-memory SDK transport and no network. */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from "aws-lambda";

import {
  estimateOcrJobStorageBytes,
  handler,
  MAX_OCR_JOB_STORAGE_BYTES,
} from "../lambda/admin-ocr-handler.js";
import { documentClient } from "../lambda/dynamodb-client.js";

const JOB_ID = "ocr_test_job";
let secretFixtureId = 0;
const BOX = [
  [1, 2],
  [3, 2],
  [3, 4],
  [1, 4],
];

function initialJob() {
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

function reviewedRow(id = "manual_1", sourceText = "") {
  return {
    id,
    sourceText,
    productName: "Manual product",
    brand: "",
    option: "",
    quantity: "2",
  };
}

function event(
  method: "GET" | "PATCH" | "POST",
  body?: unknown,
  claims: Record<string, unknown> = { sub: "admin-sub", "cognito:groups": "admin" },
) {
  return {
    rawPath: method === "POST" ? "/admin/ocr/jobs" : `/admin/ocr/jobs/${JOB_ID}`,
    headers: {},
    isBase64Encoded: false,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    requestContext: {
      http: { method },
      authorizer: { jwt: { claims } },
    },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

function unpack(response: APIGatewayProxyResultV2) {
  assert.ok(typeof response === "object" && response !== null);
  assert.ok("body" in response && typeof response.body === "string");
  return { status: response.statusCode, body: JSON.parse(response.body) };
}

function fixture(t: TestContext, providerEnvelope?: unknown) {
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

test("manual empty-source row survives PATCH -> GET -> PATCH with canonical versions", async (t) => {
  const db = fixture(t);
  const patched = unpack(
    await handler(event("PATCH", { version: 1, rows: [reviewedRow()] })),
  );
  assert.equal(patched.status, 200);
  assert.equal(patched.body.job.version, 2);
  assert.equal(patched.body.job.rows[0].sourceText, "");

  const loaded = unpack(await handler(event("GET")));
  assert.equal(loaded.status, 200);
  assert.deepEqual(loaded.body.job, patched.body.job);
  const repatched = unpack(
    await handler(
      event("PATCH", {
        version: loaded.body.job.version,
        rows: loaded.body.job.rows,
      }),
    ),
  );
  assert.equal(repatched.status, 200);
  assert.equal(repatched.body.job.version, 3);
  assert.equal(repatched.body.job.rows[0].sourceText, "");
  assert.equal(db.writes.length, 2);
  assert.ok(db.reads.every((read) => read.ConsistentRead === true));
  assert.equal(db.stored.expiresAt, initialJob().expiresAt);
  assert.equal(db.stored.createdBy, initialJob().createdBy);
  assert.equal(db.stored.createdAt, initialJob().createdAt);
  assert.equal(db.stored.updatedBy, "admin-sub");
  assert.equal(db.stored.rawText, initialJob().rawText);
  assert.equal("createdBy" in repatched.body.job, false);
  assert.equal("expiresAt" in repatched.body.job, false);
});

function uploadBody() {
  return {
    fileName: "fixture.png",
    mimeType: "image/png",
    imageBase64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString(
      "base64",
    ),
  };
}

function providerBody(texts: string[]) {
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

test("POST rejects multibyte OCR item before any DynamoDB write", async (t) => {
  // 99,999 UTF-16 raw units fit provider limits, but duplicated Korean text in
  // rawText plus row sources alone needs about 600k UTF-8 storage bytes.
  const db = fixture(
    t,
    providerBody(Array.from({ length: 200 }, () => "가".repeat(499))),
  );
  const result = unpack(await handler(event("POST", uploadBody())));
  assert.equal(result.status, 413);
  assert.deepEqual(result.body, { code: "OCR_JOB_TOO_LARGE" });
  assert.equal(db.writes.length, 0);
});

test("POST accepts bounded escaped OCR text with metadata and audit attributes", async (t) => {
  const db = fixture(t, providerBody(['quotes " and \\ plus 한글', "상품 2"]));
  const result = unpack(await handler(event("POST", uploadBody())));
  assert.equal(result.status, 201);
  assert.equal(db.writes.length, 1);
  assert.equal(result.body.job.rows[0].confidence, 0.9);
  assert.deepEqual(result.body.job.rows[0].box, BOX);
  assert.equal(db.stored.createdBy, "admin-sub");
  assert.equal(
    estimateOcrJobStorageBytes(db.stored) <= MAX_OCR_JOB_STORAGE_BYTES,
    true,
  );
});

test("PATCH rejects multibyte reviewed rows before any DynamoDB write", async (t) => {
  const db = fixture(t);
  const rows = Array.from({ length: 150 }, (_, index) =>
    reviewedRow(`manual_${index}`, "가".repeat(1_000)),
  );
  const result = unpack(await handler(event("PATCH", { version: 1, rows })));
  assert.equal(result.status, 413);
  assert.deepEqual(result.body, { code: "OCR_JOB_TOO_LARGE" });
  assert.equal(db.writes.length, 0);
});

test("PATCH exact conservative cap succeeds and one additional byte is blocked", async (t) => {
  const db = fixture(t);
  const sourceImage = { mimeType: "image/png", auditNotes: "" };
  const candidate = {
    ...initialJob(),
    rows: [reviewedRow()],
    version: 2,
    updatedBy: "admin-sub",
    sourceImage,
  };
  sourceImage.auditNotes = "x".repeat(
    MAX_OCR_JOB_STORAGE_BYTES - estimateOcrJobStorageBytes(candidate),
  );
  assert.equal(estimateOcrJobStorageBytes(candidate), MAX_OCR_JOB_STORAGE_BYTES);
  db.stored = { ...candidate, version: 1 };
  const accepted = unpack(
    await handler(event("PATCH", { version: 1, rows: [reviewedRow()] })),
  );
  assert.equal(accepted.status, 200);
  assert.equal(db.writes.length, 1);

  db.stored = {
    ...candidate,
    version: 1,
    sourceImage: { ...sourceImage, auditNotes: sourceImage.auditNotes + "x" },
  };
  const rejected = unpack(
    await handler(event("PATCH", { version: 1, rows: [reviewedRow()] })),
  );
  assert.equal(rejected.status, 413);
  assert.equal(db.writes.length, 1);
});

test("retained source-image metadata, rawText and audit subjects count toward PATCH cap", async (t) => {
  const db = fixture(t);
  db.stored = {
    ...initialJob(),
    rawText: "가".repeat(100_000),
    createdBy: "나".repeat(256),
    updatedBy: "다".repeat(256),
    sourceImage: { notes: "라".repeat(30_000) },
  };
  const loaded = unpack(await handler(event("GET")));
  assert.equal(loaded.status, 200);
  const rejected = unpack(
    await handler(event("PATCH", { version: 1, rows: [reviewedRow()] })),
  );
  assert.equal(rejected.status, 413);
  assert.equal(db.writes.length, 0);
});

test("existing oversized valid job remains readable and can be reduced by PATCH", async (t) => {
  const db = fixture(t);
  db.stored = {
    ...initialJob(),
    rows: Array.from({ length: 150 }, (_, index) =>
      reviewedRow(`manual_${index}`, "가".repeat(1_000)),
    ),
  };
  assert.equal(unpack(await handler(event("GET"))).status, 200);
  const reduced = unpack(
    await handler(event("PATCH", { version: 1, rows: [reviewedRow()] })),
  );
  assert.equal(reduced.status, 200);
  assert.equal(db.writes.length, 1);
});

test("storage estimator counts UTF-8 names and container/numeric/binary overhead conservatively", () => {
  // 100 storage + 3 root map + UTF-8 name/value bytes + map-entry byte.
  assert.equal(estimateOcrJobStorageBytes({ 한: "가" }), 110);
  assert.equal(estimateOcrJobStorageBytes({ x: '"\\\n' }), 108);
  assert.equal(estimateOcrJobStorageBytes({ x: 1 }), 126);
  assert.equal(estimateOcrJobStorageBytes({ x: [true, null] }), 112);
  assert.equal(estimateOcrJobStorageBytes({ x: new Uint8Array(10) }), 115);
  assert.equal(estimateOcrJobStorageBytes({ ignored: undefined }), 103);
  assert.equal(estimateOcrJobStorageBytes({ x: new Set(["가"]) }), 112);
});

test("unsupported cyclic and deeply nested metadata fail closed during sizing", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.equal(estimateOcrJobStorageBytes(cyclic), Infinity);
  assert.equal(estimateOcrJobStorageBytes({ date: new Date() }), Infinity);
  let deep: unknown = "leaf";
  for (let i = 0; i < 34; i += 1) deep = [deep];
  assert.equal(estimateOcrJobStorageBytes(deep), Infinity);
});

test("review edits preserve provider metadata and ignore forged metadata on manual rows", async (t) => {
  const db = fixture(t);
  const patchRows = [
    {
      ...reviewedRow("ocr_1", ""),
      confidence: 0.1,
      box: [
        [99, 99],
        [100, 100],
      ],
      adminOnly: "ignored",
    },
    { ...reviewedRow(), confidence: 1, box: BOX },
  ];
  const patched = unpack(
    await handler(event("PATCH", { version: 1, rows: patchRows })),
  );
  assert.equal(patched.status, 200);
  const loaded = unpack(await handler(event("GET")));
  assert.equal(loaded.status, 200);
  assert.equal(loaded.body.job.rows[0].confidence, 0.9);
  assert.deepEqual(loaded.body.job.rows[0].box, BOX);
  assert.equal("adminOnly" in loaded.body.job.rows[0], false);
  assert.equal("confidence" in loaded.body.job.rows[1], false);
  assert.equal("box" in loaded.body.job.rows[1], false);
  assert.equal(db.writes.length, 1);
});

test("required review fields, lengths, quantity and duplicate IDs remain validated", async (t) => {
  const db = fixture(t);
  const missingProduct = { ...reviewedRow() } as Record<string, unknown>;
  delete missingProduct.productName;
  const invalidRows: unknown[] = [
    [{ ...reviewedRow(), sourceText: undefined }],
    [{ ...reviewedRow(), sourceText: 12 }],
    [{ ...reviewedRow(), sourceText: "x".repeat(1_001) }],
    [{ ...reviewedRow(), sourceText: "\u0000" }],
    [missingProduct],
    [{ ...reviewedRow(), productName: null }],
    [{ ...reviewedRow(), productName: "x".repeat(241) }],
    [{ ...reviewedRow(), brand: "x".repeat(101) }],
    [{ ...reviewedRow(), option: "x".repeat(201) }],
    [{ ...reviewedRow(), quantity: "1.2" }],
    [{ ...reviewedRow(), quantity: "1234567890" }],
    [reviewedRow(), reviewedRow()],
    [],
  ];
  for (const rows of invalidRows) {
    const result = unpack(await handler(event("PATCH", { version: 1, rows })));
    assert.equal(result.status, 400);
    assert.equal(result.body.code, "OCR_JOB_ROWS_INVALID");
  }
  assert.equal(db.writes.length, 0);
  assert.equal(db.reads.length, 0);
});

test("trimmed empty source and existing optional empty product fields remain readable", async (t) => {
  fixture(t);
  const row = { ...reviewedRow(), sourceText: "  ", productName: "", quantity: "" };
  const patched = unpack(await handler(event("PATCH", { version: 1, rows: [row] })));
  assert.equal(patched.status, 200);
  const loaded = unpack(await handler(event("GET")));
  assert.equal(loaded.status, 200);
  assert.equal(loaded.body.job.rows[0].sourceText, "");
  assert.equal(loaded.body.job.rows[0].productName, "");
});

test("stored source types, length and NUL corruption remain rejected", async (t) => {
  const db = fixture(t);
  for (const sourceText of [undefined, 123, "x".repeat(1_001), "\u0000"]) {
    db.stored = { ...initialJob(), rows: [{ id: "manual_1", sourceText }] };
    const loaded = unpack(await handler(event("GET")));
    assert.equal(loaded.status, 404);
    assert.equal(loaded.body.code, "OCR_JOB_NOT_FOUND");
  }
  assert.equal(db.writes.length, 0);
});

test("empty source does not weaken stored confidence and bounding-box validation", async (t) => {
  const db = fixture(t);
  for (const invalidMetadata of [
    { confidence: 2 },
    {
      box: [
        [1, "bad"],
        [3, 4],
      ],
    },
  ]) {
    db.stored = { ...initialJob(), rows: [{ ...reviewedRow(), ...invalidMetadata }] };
    const loaded = unpack(await handler(event("GET")));
    assert.equal(loaded.status, 404);
  }
});

test("stale and absent versions retain conflict/validation responses", async (t) => {
  const db = fixture(t);
  const absent = unpack(await handler(event("PATCH", { rows: [reviewedRow()] })));
  assert.equal(absent.status, 400);
  assert.equal(absent.body.code, "OCR_JOB_VERSION_REQUIRED");
  const patched = unpack(
    await handler(event("PATCH", { version: 1, rows: [reviewedRow()] })),
  );
  assert.equal(patched.status, 200);
  const conflict = unpack(
    await handler(event("PATCH", { version: 1, rows: [reviewedRow()] })),
  );
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, "OCR_JOB_VERSION_CONFLICT");
  assert.equal(conflict.body.job.version, 2);
  assert.equal(db.writes.length, 1);
});

test("conditional DynamoDB race retains the safe version-conflict response", async (t) => {
  const db = fixture(t);
  db.failConditionalWrites = true;
  const result = unpack(
    await handler(event("PATCH", { version: 1, rows: [reviewedRow()] })),
  );
  assert.equal(result.status, 409);
  assert.deepEqual(result.body, { code: "OCR_JOB_VERSION_CONFLICT" });
  assert.equal(db.writes.length, 0);
});

test("GET and PATCH require administrator authorization before reading or writing rows", async (t) => {
  const db = fixture(t);
  for (const method of ["GET", "PATCH"] as const) {
    const unauthorized = unpack(
      await handler(event(method, { version: 1, rows: [reviewedRow()] }, {})),
    );
    assert.equal(unauthorized.status, 401);
    const forbidden = unpack(
      await handler(
        event(method, { version: 1, rows: [reviewedRow()] }, { sub: "member-sub" }),
      ),
    );
    assert.equal(forbidden.status, 403);
  }
  assert.equal(db.reads.length, 0);
  assert.equal(db.writes.length, 0);
});

test("edited rawText round-trips through PATCH/GET without replacing row source or metadata", async (t) => {
  const db = fixture(t);
  const edited = "  수정한 원문\n두 번째 줄  ";
  const rows = [reviewedRow("ocr_1", "ORIGINAL OCR")];
  const patched = unpack(
    await handler(
      event("PATCH", { version: 1, rows, rawText: edited, ignoredField: "not stored" }),
    ),
  );
  assert.equal(patched.status, 200);
  assert.equal(patched.body.job.rawText, edited);
  const loaded = unpack(await handler(event("GET")));
  assert.equal(loaded.status, 200);
  assert.equal(loaded.body.job.rawText, edited);
  assert.equal(loaded.body.job.version, 2);
  assert.equal(loaded.body.job.rows[0].sourceText, "ORIGINAL OCR");
  assert.equal(loaded.body.job.rows[0].confidence, 0.9);
  assert.deepEqual(loaded.body.job.rows[0].box, BOX);
  assert.equal(db.stored.createdAt, initialJob().createdAt);
  assert.equal(db.stored.createdBy, initialJob().createdBy);
  assert.equal(db.stored.expiresAt, initialJob().expiresAt);
  assert.equal(db.stored.updatedBy, "admin-sub");
  assert.equal("ignoredField" in db.stored, false);
});

test("omitting rawText preserves previously edited text on subsequent PATCH", async (t) => {
  const db = fixture(t);
  db.stored = { ...initialJob(), rawText: "Previously edited text" };
  const patched = unpack(
    await handler(event("PATCH", { version: 1, rows: [reviewedRow()] })),
  );
  assert.equal(patched.status, 200);
  assert.equal(patched.body.job.rawText, "Previously edited text");
  assert.equal(
    unpack(await handler(event("GET"))).body.job.rawText,
    "Previously edited text",
  );
});

test("explicit empty rawText remains valid and readable", async (t) => {
  fixture(t);
  const patched = unpack(
    await handler(event("PATCH", { version: 1, rows: [reviewedRow()], rawText: "" })),
  );
  assert.equal(patched.status, 200);
  assert.equal(patched.body.job.rawText, "");
  const loaded = unpack(await handler(event("GET")));
  assert.equal(loaded.status, 200);
  assert.equal(loaded.body.job.rawText, "");
});

test("rawText rejects non-strings, NUL and more than 100k UTF-16 units before storage", async (t) => {
  const db = fixture(t);
  for (const rawText of [
    null,
    12,
    false,
    {},
    [],
    "\u0000",
    "x".repeat(100_001),
    "😀".repeat(50_001),
  ]) {
    const result = unpack(
      await handler(event("PATCH", { version: 1, rows: [reviewedRow()], rawText })),
    );
    assert.equal(result.status, 400);
    assert.deepEqual(result.body, { code: "OCR_JOB_RAW_TEXT_INVALID" });
  }
  assert.equal(db.reads.length, 0);
  assert.equal(db.writes.length, 0);
});

test("exactly 100k UTF-16 units of edited rawText are accepted", async (t) => {
  fixture(t);
  const rawText = "😀".repeat(50_000);
  assert.equal(rawText.length, 100_000);
  const result = unpack(
    await handler(event("PATCH", { version: 1, rows: [reviewedRow()], rawText })),
  );
  assert.equal(result.status, 200);
  assert.equal(unpack(await handler(event("GET"))).body.job.rawText, rawText);
});

test("edited rawText participates in whole-item UTF-8 cap before PATCH write", async (t) => {
  const db = fixture(t);
  const rows = Array.from({ length: 100 }, (_, index) =>
    reviewedRow(`manual_${index}`, "x".repeat(1_000)),
  );
  const result = unpack(
    await handler(event("PATCH", { version: 1, rows, rawText: "가".repeat(100_000) })),
  );
  assert.equal(result.status, 413);
  assert.deepEqual(result.body, { code: "OCR_JOB_TOO_LARGE" });
  assert.equal(db.writes.length, 0);
  assert.equal(db.stored.rawText, initialJob().rawText);
});

test("rawText edit cannot bypass optimistic version conflict", async (t) => {
  const db = fixture(t);
  db.stored = { ...initialJob(), version: 2, rawText: "Newest text" };
  const result = unpack(
    await handler(
      event("PATCH", { version: 1, rows: [reviewedRow()], rawText: "Stale edit" }),
    ),
  );
  assert.equal(result.status, 409);
  assert.equal(result.body.code, "OCR_JOB_VERSION_CONFLICT");
  assert.equal(result.body.job.rawText, "Newest text");
  assert.equal(db.writes.length, 0);
});
