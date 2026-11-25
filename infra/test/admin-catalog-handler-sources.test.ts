/** Real handler with an atomic, conditional in-memory SDK transport. No credentials or network. */
import assert from "node:assert/strict";
import test from "node:test";
import { handler, type CatalogProductRecord } from "../lambda/admin-catalog-handler.js";
import {
  REVISION,
  product,
  existing,
  fresh,
  event,
  unpack,
  fixture,
} from "./admin-catalog-handler-fixture.js";

test("splitting or merging an already applied group cannot re-add its source rows", async (t) => {
  const db = fixture(t);
  const group = existing({
    quantity: 4,
    source: { jobId: "ocr_saved", rowIds: ["row_B", "row_A"] },
  });
  assert.equal(unpack(await handler(event("POST", group))).status, 200);
  for (const [index, rowIds] of [["row_A"], ["row_B"], ["row_C", "row_A"]].entries()) {
    const response = unpack(
      await handler(
        event(
          "POST",
          existing({
            operationId: `ocr_regroup_${index}`,
            quantity: 2,
            existing: { productId: "prd_deck", version: 4 },
            source: { jobId: "ocr_saved", rowIds },
          }),
        ),
      ),
    );
    assert.equal(response.status, 409);
    assert.equal(response.body.code, "OCR_INTAKE_ROW_CONFLICT");
    assert.equal(response.body.product, undefined);
  }
  assert.equal(db.records.get("prd_deck")!.inventoryQuantity, 14);
  assert.equal(db.records.get(REVISION)!.version, 1);
  assert.equal(db.transactions.length, 1);
  assert.equal(
    [...db.records.values()].filter(
      (item) => item.recordType === "CATALOG_INTAKE_RECEIPT",
    ).length,
    1,
  );
  assert.equal(
    [...db.records.values()].filter(
      (item) => item.recordType === "CATALOG_INTAKE_ROW_CLAIM",
    ).length,
    2,
  );
});

test("source order is canonical so reordering a group replays its original receipt", async (t) => {
  const db = fixture(t);
  const group = existing({
    source: { jobId: "ocr_saved", rowIds: ["row_B", "row_A"] },
  });
  await handler(event("POST", group));
  const replay = unpack(
    await handler(
      event("POST", {
        ...group,
        source: { jobId: "ocr_saved", rowIds: ["row_A", "row_B"] },
      }),
    ),
  );
  assert.equal(replay.status, 200);
  assert.equal(replay.body.receipt.replayed, true);
  assert.equal(db.transactions.length, 1);
});

test("retargeting a source row to another product or administrator cannot consume it again", async (t) => {
  const db = fixture(t, [
    product(),
    product({ productId: "prd_other", name: "Other deck", sku: "OTHER" }),
  ]);
  await handler(event("POST", existing()));
  for (const sub of ["admin-A", "admin-B"]) {
    const response = unpack(
      await handler(
        event(
          "POST",
          existing({
            operationId: `ocr_retarget_${sub}`,
            existing: { productId: "prd_other", version: 3 },
          }),
          undefined,
          sub,
        ),
      ),
    );
    assert.equal(response.status, 409);
    assert.equal(response.body.code, "OCR_INTAKE_ROW_CONFLICT");
    assert.equal(response.body.receipt, undefined);
  }
  assert.equal(db.records.get("prd_other")!.inventoryQuantity, 10);
  assert.equal(db.transactions.length, 1);
});

test("simultaneous different operation keys claiming the same row commit only one full transaction", async (t) => {
  const db = fixture(t, [
    product(),
    product({ productId: "prd_other", name: "Other deck", sku: "OTHER" }),
  ]);
  const responses = await Promise.all([
    handler(event("POST", existing())),
    handler(
      event(
        "POST",
        existing({
          operationId: "ocr_other_operation",
          existing: { productId: "prd_other", version: 3 },
        }),
      ),
    ),
  ]);
  assert.deepEqual(
    responses.map((response) => unpack(response).status).sort(),
    [200, 409],
  );
  assert.equal(
    responses.map(unpack).find((response) => response.status === 409)!.body.code,
    "OCR_INTAKE_ROW_CONFLICT",
  );
  assert.equal(db.transactions.length, 1);
  assert.equal(
    [...db.records.values()].filter(
      (item) => item.recordType === "CATALOG_INTAKE_RECEIPT",
    ).length,
    1,
  );
  assert.equal(
    [...db.records.values()].filter(
      (item) => item.recordType === "CATALOG_INTAKE_ROW_CLAIM",
    ).length,
    1,
  );
  assert.equal(
    Number(db.records.get("prd_deck")!.inventoryQuantity) +
      Number(db.records.get("prd_other")!.inventoryQuantity),
    22,
  );
});

test("a claimed source aborts new-product creation, receipt, revision and remaining claims together", async (t) => {
  const db = fixture(t);
  await handler(event("POST", existing()));
  const before = structuredClone([...db.records.entries()]);
  const response = unpack(
    await handler(
      event(
        "POST",
        fresh({ source: { jobId: "ocr_saved", rowIds: ["row_A", "row_unclaimed"] } }),
      ),
    ),
  );
  assert.equal(response.status, 409);
  assert.equal(response.body.code, "OCR_INTAKE_ROW_CONFLICT");
  assert.deepEqual([...db.records.entries()], before);
  assert.equal(db.transactions.length, 1);
});

test("96 source rows fit 99 atomic actions, while 97 rows are rejected before reading or writing", async (t) => {
  const db = fixture(t, []);
  const rowIds = Array.from({ length: 96 }, (_, index) => `row_${index}`);
  const response = unpack(
    await handler(event("POST", fresh({ source: { jobId: "ocr_saved", rowIds } }))),
  );
  assert.equal(response.status, 201);
  assert.equal(db.transactions[0].TransactItems!.length, 99);
  const reads = db.reads.length;
  const rejected = unpack(
    await handler(
      event(
        "POST",
        fresh({
          operationId: "ocr_oversized",
          source: { jobId: "ocr_saved", rowIds: [...rowIds, "row_97"] },
        }),
      ),
    ),
  );
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.code, "OCR_INTAKE_INVALID");
  assert.equal(db.reads.length, reads);
  assert.equal(db.transactions.length, 1);
});

test("claims contain only opaque references and are excluded from list, identity scan and direct routes", async (t) => {
  const db = fixture(t);
  await handler(event("POST", existing()));
  const claim = [...db.records.values()].find(
    (item) => item.recordType === "CATALOG_INTAKE_ROW_CLAIM",
  )!;
  assert.deepEqual(Object.keys(claim).sort(), [
    "operationHash",
    "ownerHash",
    "productId",
    "recordType",
  ]);
  assert.equal(JSON.stringify(claim).includes("ocr_saved"), false);
  assert.equal(JSON.stringify(claim).includes("row_A"), false);
  assert.equal(
    unpack(
      await handler(
        event("GET", undefined, encodeURIComponent(claim.productId as string)),
      ),
    ).status,
    404,
  );
  assert.equal(unpack(await handler(event("GET"))).body.products.length, 1);
  assert.equal(unpack(await handler(event("POST", fresh()))).status, 201);
  const cursorEvent = event("GET");
  cursorEvent.queryStringParameters = {
    cursor: Buffer.from(JSON.stringify({ productId: claim.productId })).toString(
      "base64url",
    ),
  };
  assert.equal(unpack(await handler(cursorEvent)).status, 200);
});

function historyPages(products: readonly CatalogProductRecord[] = [product()]) {
  const records: Record<string, unknown>[] = Array.from(
    { length: 5_001 },
    (_, index) => ({
      productId: `~catalog_${index % 2 ? "claim" : "receipt"}_${index.toString(16).padStart(64, "0")}`,
      recordType: index % 2 ? "CATALOG_INTAKE_ROW_CLAIM" : "CATALOG_INTAKE_RECEIPT",
    }),
  );
  records.push(...products);
  return Array.from({ length: Math.ceil(records.length / 1_000) }, (_, page) =>
    records.slice(page * 1_000, (page + 1) * 1_000),
  );
}

for (const mutation of ["normal-create", "ocr-create", "identity-update"] as const) {
  test(`${mutation} succeeds with more than 5000 permanent internal records and few products`, async (t) => {
    const db = fixture(t);
    db.setScanPages(historyPages());
    const request =
      mutation === "ocr-create"
        ? event("POST", fresh())
        : mutation === "normal-create"
          ? event("POST", {
              name: "Another deck",
              brandName: "Example",
              sizes: ["8.25"],
              category: "Deck",
              price: 1,
            })
          : event("PATCH", { version: 3, name: "Renamed deck" }, "prd_deck");
    const response = unpack(await handler(request));
    assert.equal(response.status, mutation === "identity-update" ? 200 : 201);
    assert.equal(db.scans.length, 6);
    assert.equal(
      db.scans.every((scan) => scan.ConsistentRead === true && scan.Limit === 1_000),
      true,
    );
    assert.equal(db.transactions.length, 1);
  });
}

test("a legacy duplicate behind more than 5000 internal records is still rejected", async (t) => {
  const db = fixture(t);
  db.setScanPages(historyPages());
  const response = unpack(
    await handler(
      event(
        "POST",
        fresh({
          product: {
            name: "Deck",
            brandName: "Example",
            option: "8.25",
            price: 1,
            category: "Deck",
          },
        }),
      ),
    ),
  );
  assert.equal(response.status, 409);
  assert.equal(response.body.code, "CATALOG_PRODUCT_DUPLICATE");
  assert.equal(db.scans.length, 6);
  assert.equal(db.transactions.length, 0);
});

test("5001 validated real products exceed the product budget with no partial mutation", async (t) => {
  const db = fixture(t, []);
  const products = Array.from({ length: 5_001 }, (_, index) =>
    product({
      productId: `prd_${index}`,
      name: `Product ${index}`,
      sku: `SKU-${index}`,
    }),
  );
  db.setScanPages(
    Array.from({ length: 6 }, (_, page) =>
      products.slice(page * 1_000, (page + 1) * 1_000),
    ),
  );
  const response = unpack(await handler(event("POST", fresh())));
  assert.equal(response.status, 503);
  assert.equal(db.transactions.length, 0);
  assert.equal(db.records.size, 0);
});

test("raw scan budget is separate from the real product budget", async (t) => {
  const db = fixture(t, []);
  db.reportScanCount(1_000_001);
  assert.equal(unpack(await handler(event("POST", fresh()))).status, 503);
  assert.equal(db.scans.length, 1);
  assert.equal(db.transactions.length, 0);
});

test("a stalled SDK scan cannot extend the five-second deadline even if it ignores abort", async (t) => {
  const db = fixture(t, []);
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  db.stallScan();
  const pending = handler(event("POST", fresh()));
  for (let tick = 0; tick < 12 && db.scans.length === 0; tick += 1)
    await Promise.resolve();
  assert.equal(db.scans.length, 1);
  let settled = false;
  void pending.then(() => {
    settled = true;
  });
  t.mock.timers.tick(4_999);
  await Promise.resolve();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  const response = unpack(await pending);
  assert.equal(response.status, 503);
  assert.equal(db.scanSignal()!.aborted, true);
  assert.equal(db.transactions.length, 0);
});

test("a scan resolving at the deadline cannot return a successful duplicate check", async (t) => {
  const db = fixture(t, []);
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  db.beforeScan(() => {
    t.mock.timers.setTime(Date.now() + 5_000);
  });
  assert.equal(unpack(await handler(event("POST", fresh()))).status, 503);
  assert.equal(db.scanSignal()!.aborted, true);
  assert.equal(db.transactions.length, 0);
});
