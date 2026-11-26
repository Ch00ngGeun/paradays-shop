/** 역할: 실제 관리자 카탈로그 handler로 공개 재고 계산, OCR 입고 receipt·재실행, 예약 재고 보호, 동시 요청과 중복 상품 차단을 메모리 SDK 전송으로 검증함. */
import assert from "node:assert/strict";
import test from "node:test";
import { handler, toPublicCatalogProduct } from "../lambda/admin-catalog-handler.js";
import {
  REVISION,
  product,
  existing,
  fresh,
  event,
  unpack,
  fixture,
} from "./admin-catalog-handler-fixture.js";

test("public stock projects available units rather than physical on-hand units", () => {
  assert.equal(
    toPublicCatalogProduct(
      product({
        status: "PUBLISHED",
        publicationStatus: "PUBLISHED",
        image: "/deck.webp",
        inventoryQuantity: 10,
        inventoryReserved: 7,
      }),
    )?.inventoryQuantity,
    3,
  );
});
test("existing intake adds n server-side and atomically stores a private allowlisted receipt", async (t) => {
  const db = fixture(t);
  const response = unpack(await handler(event("POST", existing())));
  assert.equal(response.status, 200);
  assert.equal(response.body.product.inventoryQuantity, 12);
  assert.equal(response.body.product.version, 4);
  assert.deepEqual(response.body.receipt, {
    operationId: "ocr_stable_operation",
    kind: "existing",
    quantity: 2,
    beforeStock: 10,
    afterStock: 12,
    replayed: false,
  });
  assert.equal(db.transactions.length, 1);
  assert.equal(db.transactions[0].TransactItems!.length, 4);
  const ledger = [...db.records.values()].find(
    (item) => item.recordType === "CATALOG_INTAKE_RECEIPT",
  )!;
  assert.equal(ledger.inventoryQuantity, undefined);
  assert.equal(ledger.publicationStatus, undefined);
  assert.equal(ledger.slug, undefined);
  assert.equal(ledger.createdBy, undefined);
  assert.equal(JSON.stringify(ledger).includes("old-admin"), false);
  assert.equal(JSON.stringify(ledger).includes("admin-A"), false);
});

test("server-owned reservations survive PATCH and OCR intake; below-hold, option changes and deletion fail", async (t) => {
  const db = fixture(t, [product({ inventoryReserved: 4 })]);
  assert.equal(
    unpack(
      await handler(event("PATCH", { version: 3, inventoryReserved: 0 }, "prd_deck")),
    ).status,
    400,
  );
  assert.equal(
    unpack(
      await handler(event("PATCH", { version: 3, inventoryQuantity: 3 }, "prd_deck")),
    ).status,
    409,
  );
  assert.equal(
    unpack(await handler(event("PATCH", { version: 3, sizes: ["9"] }, "prd_deck")))
      .status,
    409,
  );
  assert.equal(
    unpack(await handler(event("DELETE", { version: 3 }, "prd_deck"))).status,
    409,
  );
  assert.equal(
    unpack(
      await handler(event("PATCH", { version: 3, inventoryQuantity: 11 }, "prd_deck")),
    ).status,
    200,
  );
  assert.equal(db.records.get("prd_deck")!.inventoryReserved, 4);
  assert.equal(
    unpack(
      await handler(
        event("POST", existing({ existing: { productId: "prd_deck", version: 4 } })),
      ),
    ).status,
    200,
  );
  assert.equal(db.records.get("prd_deck")!.inventoryReserved, 4);
  assert.equal(db.records.get("prd_deck")!.inventoryQuantity, 13);
});

test("reserved products accept full-form edits that resend unchanged identity fields", async (t) => {
  const db = fixture(t, [product({ inventoryReserved: 4 })]);
  const unchangedIdentity = {
    name: "Deck",
    brandName: "Example",
    sku: "DECK-825",
    price: 80_000,
    sizes: ["8.25"],
  };
  const edited = unpack(
    await handler(
      event(
        "PATCH",
        { version: 3, ...unchangedIdentity, description: ["Updated copy"] },
        "prd_deck",
      ),
    ),
  );
  assert.equal(edited.status, 200);
  assert.deepEqual(db.records.get("prd_deck")!.description, ["Updated copy"]);
  assert.equal(db.records.get("prd_deck")!.inventoryReserved, 4);
  const repriced = unpack(
    await handler(
      event("PATCH", { version: 4, ...unchangedIdentity, price: 90_000 }, "prd_deck"),
    ),
  );
  assert.equal(repriced.status, 409);
  assert.equal(repriced.body.code, "CATALOG_PRODUCT_RESERVED");
  assert.equal(db.records.get("prd_deck")!.price, 80_000);
});

test("invalid comparison prices are rejected without writing", async (t) => {
  const db = fixture(t, [product({ price: 80_000, compareAtPrice: 100_000 })]);
  for (const compareAtPrice of [-1, 80_000, "not-a-price"]) {
    const response = unpack(
      await handler(event("PATCH", { version: 3, compareAtPrice }, "prd_deck")),
    );
    assert.equal(response.status, 400, String(compareAtPrice));
  }
  assert.equal(db.transactions.length, 0);
  assert.equal(db.records.get("prd_deck")!.compareAtPrice, 100_000);
});

test("a write race cannot clear the current comparison price", async (t) => {
  const db = fixture(t, [product({ price: 80_000, compareAtPrice: 100_000 })]);
  db.beforeTransaction(() => {
    db.records.set("prd_deck", { ...db.records.get("prd_deck")!, version: 4 });
  });
  const raced = unpack(
    await handler(event("PATCH", { version: 3, compareAtPrice: null }, "prd_deck")),
  );
  assert.equal(raced.status, 409);
  assert.equal(db.transactions.length, 0);
  assert.equal(db.records.get("prd_deck")!.compareAtPrice, 100_000);
});

test("outstanding sold units block hard deletion; archival remains possible", async (t) => {
  const db = fixture(t, [product({ inventoryCommitted: 2 })]);
  assert.equal(
    unpack(await handler(event("DELETE", { version: 3 }, "prd_deck"))).status,
    409,
  );
  assert.equal(
    unpack(await handler(event("PATCH", { version: 3, status: "DRAFT" }, "prd_deck")))
      .status,
    200,
  );
  assert.equal(db.records.get("prd_deck")!.inventoryCommitted, 2);
});
test("same request replays saved snapshot after later catalog changes without another add", async (t) => {
  const db = fixture(t);
  await handler(event("POST", existing()));
  db.records.set("prd_deck", {
    ...db.records.get("prd_deck"),
    inventoryQuantity: 99,
    version: 8,
  });
  const response = unpack(await handler(event("POST", existing())));
  assert.equal(response.status, 200);
  assert.equal(response.body.receipt.replayed, true);
  assert.equal(response.body.product.inventoryQuantity, 12);
  assert.equal(db.records.get("prd_deck")!.inventoryQuantity, 99);
  assert.equal(db.transactions.length, 1);
});
test("same operation with changed payload rejects rather than re-adds", async (t) => {
  const db = fixture(t);
  await handler(event("POST", existing()));
  const response = unpack(await handler(event("POST", existing({ quantity: 3 }))));
  assert.equal(response.status, 409);
  assert.equal(response.body.code, "OCR_INTAKE_OPERATION_CONFLICT");
  assert.equal(db.transactions.length, 1);
});
test("concurrent identical requests commit once and the loser replays the winner", async (t) => {
  const db = fixture(t);
  const responses = await Promise.all([
    handler(event("POST", existing())),
    handler(event("POST", existing())),
  ]);
  assert.deepEqual(
    responses.map((item) => unpack(item).status),
    [200, 200],
  );
  assert.deepEqual(responses.map((item) => unpack(item).body.receipt.replayed).sort(), [
    false,
    true,
  ]);
  assert.equal(db.records.get("prd_deck")!.inventoryQuantity, 12);
  assert.equal(db.transactions.length, 1);
});
for (const [kind, body] of [
  ["existing", existing],
  ["new", fresh],
] as const) {
  test(`a ${kind} intake whose same operation commits after the receipt check replays instead of 409`, async (t) => {
    const db = fixture(t);
    const snapshot = () =>
      new Map([...db.records].map(([key, value]) => [key, structuredClone(value)]));
    const restore = (state: Map<string, Record<string, unknown>>) => {
      db.records.clear();
      for (const [key, value] of state) db.records.set(key, structuredClone(value));
    };
    const initial = snapshot();
    const winner = unpack(await handler(event("POST", body())));
    assert.equal(winner.status, kind === "new" ? 201 : 200);
    const committed = snapshot();
    const winnerWrites = db.transactions.length;
    restore(initial);
    // 이긴 요청은 진 요청이 receipt를 처음 읽은 직후 commit함.
    const firstRead = db.reads.length + 1;
    db.beforeRead((count) => {
      if (count === firstRead + 1) restore(committed);
    });
    const loser = unpack(await handler(event("POST", body())));
    assert.equal(loser.status, 200);
    assert.equal(loser.body.receipt.replayed, true);
    assert.equal(db.transactions.length, winnerWrites);
  });
}

test("an intake whose committed product was deleted before the loser read replays instead of 404", async (t) => {
  const db = fixture(t);
  assert.equal(unpack(await handler(event("POST", existing()))).status, 200);
  const writes = db.transactions.length;
  // 진 요청은 첫 읽기에서 receipt를 못 보고, 그 뒤 receipt가 생기고 상품은 사라짐.
  const receipts = [...db.records].filter(
    ([, value]) => value.recordType === "CATALOG_INTAKE_RECEIPT",
  );
  assert.ok(receipts.length > 0);
  for (const [key] of receipts) db.records.delete(key);
  db.records.delete("prd_deck");
  const firstRead = db.reads.length + 1;
  db.beforeRead((count) => {
    if (count === firstRead + 1)
      for (const [key, value] of receipts) db.records.set(key, structuredClone(value));
  });
  const loser = unpack(await handler(event("POST", existing())));
  assert.equal(loser.status, 200);
  assert.equal(loser.body.receipt.replayed, true);
  assert.equal(db.transactions.length, writes);
});

test("a failed receipt recheck before an early intake failure is a 503, not an unhandled error", async (t) => {
  const db = fixture(t, [product({ version: 9 })]);
  const firstRead = db.reads.length + 1;
  db.beforeRead((count) => {
    // receipt, revision, 상품 순으로 읽은 뒤 재확인 읽기가 실패함
    if (count === firstRead + 3) throw new Error("private read details");
  });
  const response = unpack(await handler(event("POST", existing())));
  assert.equal(response.status, 503);
  assert.equal(response.body.code, "CATALOG_STORAGE_UNAVAILABLE");
  assert.equal(db.transactions.length, 0);
});

test("the global receipt rejects another admin's same operation without replay or a second add", async (t) => {
  const db = fixture(t);
  await handler(event("POST", existing()));
  const rejected = unpack(
    await handler(event("POST", existing(), undefined, "admin-B")),
  );
  assert.equal(rejected.status, 409);
  assert.equal(rejected.body.code, "OCR_INTAKE_OPERATION_CONFLICT");
  assert.equal(rejected.body.product, undefined);
  const alsoRejected = unpack(
    await handler(
      event(
        "POST",
        existing({ existing: { productId: "prd_deck", version: 4 } }),
        undefined,
        "admin-B",
      ),
    ),
  );
  assert.equal(alsoRejected.status, 409);
  assert.equal(alsoRejected.body.code, "OCR_INTAKE_OPERATION_CONFLICT");
  assert.equal(db.records.get("prd_deck")!.inventoryQuantity, 12);
  assert.equal(db.transactions.length, 1);
  assert.equal(
    [...db.records.values()].filter(
      (item) => item.recordType === "CATALOG_INTAKE_RECEIPT",
    ).length,
    1,
  );
});
test("new intake requires price/category and creates a non-featured, image-free DRAFT with initial stock", async (t) => {
  const db = fixture(t);
  const response = unpack(
    await handler(
      event("POST", fresh({ product: { ...fresh().product, name: "새 바퀴" } })),
    ),
  );
  assert.equal(response.status, 201);
  assert.equal(response.body.product.name, "새 바퀴");
  assert.equal(response.body.product.price, 0);
  assert.equal(response.body.product.category, "Wheels");
  assert.equal(response.body.product.inventoryQuantity, 4);
  assert.equal(response.body.product.status, "DRAFT");
  assert.equal(response.body.product.featured, false);
  assert.deepEqual(response.body.product.sizes, ["56mm"]);
  assert.deepEqual(response.body.product.images, []);
  assert.equal(response.body.product.createdBy, undefined);
  assert.equal(
    db.scans.every((scan) => scan.ConsistentRead === true),
    true,
  );
  assert.equal(db.transactions.length, 1);
});
test("new intake replay returns the same product and does not generate a duplicate", async (t) => {
  const db = fixture(t, []);
  const first = unpack(await handler(event("POST", fresh())));
  const second = unpack(await handler(event("POST", fresh())));
  assert.equal(second.status, 200);
  assert.equal(second.body.product.productId, first.body.product.productId);
  assert.equal(second.body.receipt.replayed, true);
  assert.equal(db.transactions.length, 1);
});
test("legacy exact SKU and normalized name/brand/option block duplicate new products", async (t) => {
  const db = fixture(t);
  const matches = [
    { ...fresh().product, sku: " DECK-825 " },
    {
      name: " deck ",
      brandName: "EXAMPLE",
      option: "8.25",
      price: 1,
      category: "Deck",
    },
    { name: "Deck", brandName: "Example", option: "", price: 1, category: "Deck" },
  ];
  for (const candidate of matches) {
    const response = unpack(
      await handler(event("POST", fresh({ product: candidate }))),
    );
    assert.equal(response.status, 409);
    assert.equal(response.body.code, "CATALOG_PRODUCT_DUPLICATE");
    assert.deepEqual(response.body.productIds, ["prd_deck"]);
  }
  assert.equal(db.transactions.length, 0);
});
test("distinct explicit options are not fuzzy merged", async (t) => {
  const db = fixture(t);
  const response = unpack(
    await handler(
      event(
        "POST",
        fresh({
          product: {
            name: "Deck",
            brandName: "Example",
            option: "8.5",
            price: 1,
            category: "Deck",
          },
        }),
      ),
    ),
  );
  assert.equal(response.status, 201);
  assert.equal(db.transactions.length, 1);
});
test("two administrators cannot create the same identity concurrently", async (t) => {
  const db = fixture(t, []);
  const responses = await Promise.all([
    handler(event("POST", fresh(), undefined, "admin-A")),
    handler(event("POST", fresh(), undefined, "admin-B")),
  ]);
  assert.deepEqual(
    responses.map((response) => unpack(response).status).sort(),
    [201, 409],
  );
  assert.equal(db.transactions.length, 1);
  assert.equal(
    [...db.records.values()].filter(
      (item) => item.recordType === "CATALOG_INTAKE_RECEIPT",
    ).length,
    1,
  );
});
test("revision change between scan and commit prevents a stale duplicate decision", async (t) => {
  const db = fixture(t, []);
  db.beforeTransaction(() => {
    db.records.set(REVISION, {
      productId: REVISION,
      recordType: "CATALOG_IDENTITY_REVISION",
      version: 1,
    });
    db.records.set(
      "prd_other",
      product({ productId: "prd_other", name: "New wheel", sizes: ["56mm"] }),
    );
  });
  const response = unpack(await handler(event("POST", fresh())));
  assert.equal(response.status, 409);
  assert.equal(response.body.code, "CATALOG_IDENTITY_CONFLICT");
  assert.equal(db.transactions.length, 0);
  assert.equal(
    [...db.records.values()].some(
      (item) => item.recordType === "CATALOG_INTAKE_RECEIPT",
    ),
    false,
  );
});
