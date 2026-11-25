/** Real handler PATCH/GET cycles with in-memory SDK transport and no network. */
import assert from "node:assert/strict";
import test from "node:test";
import {
  estimateOcrJobStorageBytes,
  handler,
  MAX_OCR_JOB_STORAGE_BYTES,
} from "../lambda/admin-ocr-handler.js";
import {
  BOX,
  initialJob,
  reviewedRow,
  event,
  unpack,
  fixture,
  uploadBody,
  providerBody,
} from "./admin-ocr-handler-fixture.js";

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
