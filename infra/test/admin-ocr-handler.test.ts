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

test("headerless drag regions preview without write and apply canonical IDs through normal review", async (t) => {
  const db = fixture(t);
  const sources = [
    {
      id: "name1",
      sourceText: "Synthetic board",
      confidence: 0.91,
      box: [
        [100, 200],
        [300, 200],
        [300, 220],
        [100, 220],
      ],
    },
    {
      id: "qty1",
      sourceText: "2",
      confidence: 0.92,
      box: [
        [700, 200],
        [720, 200],
        [720, 220],
        [700, 220],
      ],
    },
    {
      id: "name2",
      sourceText: "Synthetic wheels",
      confidence: 0.93,
      box: [
        [100, 300],
        [300, 300],
        [300, 320],
        [100, 320],
      ],
    },
    {
      id: "qty2",
      sourceText: "3",
      confidence: 0.94,
      box: [
        [700, 300],
        [720, 300],
        [720, 320],
        [700, 320],
      ],
    },
  ];
  db.stored = { ...initialJob(), rows: sources, sourceRows: sources };
  const mapping = {
    schemaVersion: 2,
    parserVersion: 1,
    kind: "regions",
    image: { width: 1000, height: 1000 },
    firstRow: {
      productName: { left: 0.09, top: 0.19, right: 0.4, bottom: 0.23 },
      brand: null,
      option: null,
      quantity: { left: 0.69, top: 0.19, right: 0.75, bottom: 0.23 },
    },
    tableBottom: 0.34,
    secondRowY: null,
    quantityConfirmed: true,
  };
  const preview = unpack(
    await handler(event("PATCH", { version: 1, mapping, preview: true })),
  );
  assert.equal(preview.status, 200);
  assert.equal(db.writes.length, 0);
  assert.equal(preview.body.preview.rows.length, 2);
  assert.equal(preview.body.preview.rows[0].id, "name1");
  assert.equal(preview.body.preview.analysis.region.includedTokenCount, 4);
  assert.equal("table" in preview.body.preview.analysis, false);
  const applied = unpack(await handler(event("PATCH", { version: 1, mapping })));
  assert.equal(applied.status, 200);
  assert.equal(applied.body.job.version, 2);
  assert.deepEqual(applied.body.job.rows, preview.body.preview.rows);
  assert.deepEqual(db.stored.sourceRows, sources);
  const reviewed = unpack(
    await handler(
      event("PATCH", {
        version: 2,
        rows: applied.body.job.rows.map((row: Record<string, unknown>) => ({
          ...row,
          productName: "Edited",
          confidence: 0,
          box: BOX,
        })),
      }),
    ),
  );
  assert.equal(reviewed.status, 200);
  assert.equal(reviewed.body.job.rows[0].confidence, 0.91);
  assert.deepEqual(reviewed.body.job.rows[0].box, sources[0].box);
  assert.deepEqual(reviewed.body.job.analysis.mapping, mapping);
  assert.deepEqual(db.stored.sourceRows, sources);
  assert.equal(
    unpack(await handler(event("PATCH", { version: 1, mapping }))).status,
    409,
  );
  const count = db.writes.length;
  assert.equal(
    unpack(
      await handler(
        event("PATCH", {
          version: 3,
          mapping: { ...mapping, quantityConfirmed: false },
        }),
      ),
    ).status,
    400,
  );
  assert.equal(db.writes.length, count);
  assert.deepEqual(unpack(await handler(event("GET"))).body.job, reviewed.body.job);
});

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

function tableProviderFixture(missingHeader = false) {
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

test("table POST groups editable products and retains every source token through PATCH/GET/conflict", async (t) => {
  const { envelope, originalRows } = tableProviderFixture();
  const db = fixture(t, envelope);
  const created = unpack(await handler(event("POST", uploadBody())));
  assert.equal(created.status, 201);
  const job = created.body.job;
  const expectedRows = [
    {
      ...originalRows[5],
      sourceText: "Canyon Cargo Shirt | North Loom | Olive / XL | 17",
      productName: "Canyon Cargo Shirt",
      brand: "North Loom",
      option: "Olive / XL",
      quantity: "17",
    },
    {
      ...originalRows[9],
      sourceText: "Metric Truck | Arc Foundry | 149 mm | 4",
      productName: "Metric Truck",
      brand: "Arc Foundry",
      option: "149 mm",
      quantity: "4",
    },
  ];
  assert.deepEqual(job.rows, expectedRows);
  assert.equal(job.rawText, originalRows.map((row) => row.sourceText).join("\n"));
  assert.equal(job.version, 1);
  assert.equal("sourceRows" in job, false);
  assert.deepEqual(db.stored.sourceRows, originalRows);
  assert.equal(db.stored.jobId, job.jobId);

  const editedRows = expectedRows.map((row, index) => ({
    ...row,
    ...(index === 0
      ? { productName: "Canyon Cargo Shirt revised", quantity: "19" }
      : {}),
  }));
  const patched = unpack(
    await handler(
      event(
        "PATCH",
        {
          version: 1,
          rows: editedRows.map((row) => ({ ...row, confidence: 0, box: BOX })),
          sourceRows: [{ id: "forged", sourceText: "replaced originals" }],
        },
        undefined,
        job.jobId,
      ),
    ),
  );
  assert.equal(patched.status, 200);
  assert.equal(patched.body.job.jobId, job.jobId);
  assert.equal(patched.body.job.version, 2);
  assert.equal(patched.body.job.rawText, job.rawText);
  assert.deepEqual(patched.body.job.rows, editedRows);
  assert.equal("sourceRows" in patched.body.job, false);
  assert.deepEqual(db.stored.sourceRows, originalRows);

  const loaded = unpack(await handler(event("GET", undefined, undefined, job.jobId)));
  assert.equal(loaded.status, 200);
  assert.deepEqual(loaded.body.job, patched.body.job);
  const conflict = unpack(
    await handler(
      event("PATCH", { version: 1, rows: editedRows }, undefined, job.jobId),
    ),
  );
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, "OCR_JOB_VERSION_CONFLICT");
  assert.deepEqual(conflict.body.job, patched.body.job);
  assert.deepEqual(db.stored.sourceRows, originalRows);
  assert.equal(db.writes.length, 2);
  assert.ok(db.reads.every((read) => read.Key?.jobId === job.jobId));
});

test("POST with a missing table header retains every original row and metadata", async (t) => {
  const { envelope, originalRows } = tableProviderFixture(true);
  const db = fixture(t, envelope);
  const created = unpack(await handler(event("POST", uploadBody())));
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.job.rows, originalRows);
  assert.equal(
    created.body.job.rawText,
    originalRows.map((row) => row.sourceText).join("\n"),
  );
  assert.deepEqual(db.stored.sourceRows, originalRows);
  const loaded = unpack(
    await handler(event("GET", undefined, undefined, created.body.job.jobId)),
  );
  assert.equal(loaded.status, 200);
  assert.deepEqual(loaded.body.job, created.body.job);
  assert.equal(db.writes.length, 1);
});

const tableMapping = {
  schemaVersion: 1,
  headerRow: 1,
  columns: { productName: 0, brand: 1, option: 2, quantity: 3 },
};

test("mapping preview never writes; apply and ordinary review preserve originals and stable metadata", async (t) => {
  const { originalRows } = tableProviderFixture();
  const db = fixture(t);
  db.stored = {
    ...initialJob(),
    rawText: originalRows.map((row) => row.sourceText).join("\n"),
    rows: originalRows,
    sourceRows: originalRows,
  };
  const original = structuredClone(db.stored);
  const preview = unpack(
    await handler(
      event("PATCH", {
        version: 1,
        mapping: tableMapping,
        preview: true,
      }),
    ),
  );
  assert.equal(preview.status, 200);
  assert.equal("job" in preview.body, false);
  assert.equal(preview.body.preview.version, 1);
  assert.equal(preview.body.preview.analysis.mode, "table");
  assert.equal(preview.body.preview.rows[0].productName, "Canyon Cargo Shirt");
  assert.equal("sourceRows" in preview.body.preview, false);
  assert.deepEqual(db.stored, original);
  assert.equal(db.writes.length, 0);

  const applied = unpack(
    await handler(
      event("PATCH", {
        version: 1,
        mapping: tableMapping,
      }),
    ),
  );
  assert.equal(applied.status, 200);
  assert.equal(applied.body.job.version, 2);
  assert.deepEqual(applied.body.job.rows, preview.body.preview.rows);
  assert.deepEqual(db.stored.mapping, tableMapping);
  assert.deepEqual(db.stored.sourceRows, originalRows);
  assert.equal("sourceRows" in applied.body.job, false);
  const canonicalRows = applied.body.job.rows;

  const reviewed = unpack(
    await handler(
      event("PATCH", {
        version: 2,
        rawText: "operator edited raw text",
        rows: canonicalRows.map((row: Record<string, unknown>) => ({
          ...row,
          sourceText: "operator edited source",
          productName: "operator edited product",
          confidence: 0,
          box: BOX,
        })),
      }),
    ),
  );
  assert.equal(reviewed.status, 200);
  assert.equal(reviewed.body.job.version, 3);
  assert.equal(reviewed.body.job.rawText, "operator edited raw text");
  assert.deepEqual(reviewed.body.job.analysis, applied.body.job.analysis);
  for (let index = 0; index < canonicalRows.length; index += 1) {
    assert.equal(
      reviewed.body.job.rows[index].confidence,
      canonicalRows[index].confidence,
    );
    assert.deepEqual(reviewed.body.job.rows[index].box, canonicalRows[index].box);
  }
  assert.deepEqual(db.stored.sourceRows, originalRows);

  const swapped = {
    ...tableMapping,
    columns: { productName: 1, brand: 0, option: 2, quantity: 3 },
  };
  const remapped = unpack(
    await handler(
      event("PATCH", {
        version: 3,
        mapping: swapped,
      }),
    ),
  );
  assert.equal(remapped.status, 200);
  assert.equal(remapped.body.job.version, 4);
  assert.equal(remapped.body.job.rows[0].productName, "North Loom");
  assert.equal(remapped.body.job.rows[0].brand, "Canyon Cargo Shirt");
  assert.deepEqual(
    remapped.body.job.rows.map((row: { id: string }) => row.id),
    canonicalRows.map((row: { id: string }) => row.id),
  );
  assert.equal(remapped.body.job.rawText, "operator edited raw text");
  assert.deepEqual(db.stored.sourceRows, originalRows);
  const loaded = unpack(await handler(event("GET")));
  assert.deepEqual(loaded.body.job, remapped.body.job);

  const repeated = unpack(
    await handler(
      event("PATCH", {
        version: 4,
        mapping: swapped,
        preview: true,
      }),
    ),
  );
  assert.equal(repeated.status, 200);
  assert.deepEqual(repeated.body.preview.rows, remapped.body.job.rows);
  assert.equal(db.writes.length, 3);
  const stale = unpack(await handler(event("PATCH", { version: 3, mapping: swapped })));
  assert.equal(stale.status, 409);
  assert.equal(db.writes.length, 3);
});

test("mapping payloads reject malformed configuration, mixed edits and unusable layouts without writes", async (t) => {
  const { originalRows } = tableProviderFixture();
  const db = fixture(t);
  db.stored = { ...initialJob(), rows: originalRows, sourceRows: originalRows };
  const original = structuredClone(db.stored);
  for (const body of [
    { version: 1, mapping: null },
    { version: 1, mapping: { ...tableMapping, schemaVersion: 2 } },
    { version: 1, mapping: { ...tableMapping, headerRow: 500 } },
    { version: 1, mapping: { ...tableMapping, unexpected: "raw OCR" } },
    {
      version: 1,
      mapping: { ...tableMapping, columns: { ...tableMapping.columns, brand: 0 } },
    },
    { version: 1, mapping: tableMapping, preview: false },
    { version: 1, mapping: tableMapping, rows: [reviewedRow()] },
    { version: 1, mapping: tableMapping, rawText: "forged" },
    { version: 1, mapping: tableMapping, sourceRows: [] },
  ]) {
    const result = unpack(await handler(event("PATCH", body)));
    assert.equal(result.status, 400);
    assert.equal(result.body.code, "OCR_JOB_MAPPING_INVALID");
  }
  const unavailableColumn = unpack(
    await handler(
      event("PATCH", {
        version: 1,
        mapping: {
          ...tableMapping,
          columns: { ...tableMapping.columns, quantity: 19 },
        },
      }),
    ),
  );
  assert.equal(unavailableColumn.status, 400);
  assert.equal(unavailableColumn.body.code, "OCR_JOB_MAPPING_UNUSABLE");
  db.stored = { ...initialJob(), sourceRows: [] };
  const empty = unpack(
    await handler(event("PATCH", { version: 1, mapping: tableMapping })),
  );
  assert.equal(empty.status, 400);
  assert.equal(empty.body.code, "OCR_JOB_MAPPING_UNUSABLE");
  db.stored = original;
  assert.equal(db.writes.length, 0);
  assert.deepEqual(db.stored, original);
});

test("legacy source availability and mapping conditional conflicts fail safely", async (t) => {
  const { originalRows } = tableProviderFixture();
  const db = fixture(t);
  db.stored = { ...initialJob(), version: 2, rows: originalRows };
  const legacy = unpack(
    await handler(event("PATCH", { version: 2, mapping: tableMapping })),
  );
  assert.equal(legacy.status, 400);
  assert.equal(legacy.body.code, "OCR_JOB_SOURCE_ROWS_UNAVAILABLE");
  assert.equal(db.writes.length, 0);
  const loaded = unpack(await handler(event("GET")));
  assert.deepEqual(loaded.body.job.analysis, {
    mode: "unclassified",
    reason: "source-rows-unavailable",
  });

  db.stored = { ...initialJob(), rows: originalRows };
  db.failConditionalWrites = true;
  const conflict = unpack(
    await handler(event("PATCH", { version: 1, mapping: tableMapping })),
  );
  assert.equal(conflict.status, 409);
  assert.equal(db.writes.length, 0);
  db.failConditionalWrites = false;
  const promoted = unpack(
    await handler(event("PATCH", { version: 1, mapping: tableMapping })),
  );
  assert.equal(promoted.status, 200);
  assert.deepEqual(db.stored.sourceRows, originalRows);
});

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
