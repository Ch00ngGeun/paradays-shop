/** 역할: 실제 관리자 OCR handler로 수동 행 보존, 표 영역 mapping 미리보기·적용, 표 header 누락 시 원본 보존과 충돌 처리를 메모리 SDK 전송으로 검증함. */
import assert from "node:assert/strict";
import test from "node:test";
import { handler } from "../lambda/admin-ocr-handler.js";
import {
  BOX,
  initialJob,
  reviewedRow,
  event,
  unpack,
  fixture,
  uploadBody,
  tableProviderFixture,
  tableMapping,
} from "./admin-ocr-handler-fixture.js";

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
