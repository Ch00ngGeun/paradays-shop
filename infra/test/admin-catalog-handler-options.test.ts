/** 역할: 실제 관리자 카탈로그 handler로 옵션 이름 변경·남은 key 처리, 권한·설정 실패, 재실행 조정, 중복 scan 페이지 처리를 메모리 SDK 전송으로 검증함. */
import assert from "node:assert/strict";
import test from "node:test";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import {
  handler,
  isCatalogProductRecord,
  toPublicCatalogProduct,
  type CatalogProductRecord,
} from "../lambda/admin-catalog-handler.js";
import {
  product,
  existing,
  fresh,
  event,
  unpack,
  fixture,
} from "./admin-catalog-handler-fixture.js";

test("sizeName renames one option in place and moves its size chart atomically", async (t) => {
  const base = { nose: 6.875, tail: 6.5, width: 8.25, length: 31.75, wheelbase: 14.25 };
  const small = { ...base, width: 8, wheelbase: 14 };
  const large = { ...base, width: 8.5, length: 32 };
  const db = fixture(t, [
    product({
      status: "PUBLISHED",
      publicationStatus: "PUBLISHED",
      image: "/deck.webp",
      sizes: ["8.0", "8.25", "8.5"],
      deckSpec: base,
      // "8.75"는 삭제된 옵션이 남긴 낡은 key이며 다시 나타나면 안 됨.
      deckSpecsBySize: { "8.0": small, "8.5": large, "8.75": base },
    }),
  ]);
  const stored = () => db.records.get("prd_deck") as CatalogProductRecord;
  const patch = async (body: Record<string, unknown>) =>
    unpack(await handler(event("PATCH", body, "prd_deck")));

  const renamed = await patch({
    version: 3,
    size: "8.0",
    sizeName: "8.0 wide",
    sizeDeckSpec: { ...small, tail: 6.625 },
  });
  assert.equal(renamed.status, 200);
  assert.deepEqual(renamed.body.product.sizes, ["8.0 wide", "8.25", "8.5"]);
  assert.deepEqual(renamed.body.product.deckSpecsBySize, {
    "8.0 wide": { ...small, tail: 6.625 },
    "8.5": large,
  });
  assert.deepEqual(renamed.body.product.deckSpec, base);
  assert.deepEqual(stored().sizes, ["8.0 wide", "8.25", "8.5"]);
  assert.equal(Object.hasOwn(stored().deckSpecsBySize!, "8.0"), false);
  assert.deepEqual(toPublicCatalogProduct(stored())?.sizes, [
    "8.0 wide",
    "8.25",
    "8.5",
  ]);

  // 빈 표로 이름만 바꾸면 옮길 값이 없고, 같은 이름의 낡은 key는 버림.
  const nameOnly = await patch({
    version: 4,
    size: "8.5",
    sizeName: "8.75",
    sizeDeckSpec: null,
  });
  assert.equal(nameOnly.status, 200);
  assert.deepEqual(nameOnly.body.product.sizes, ["8.0 wide", "8.25", "8.75"]);
  assert.deepEqual(nameOnly.body.product.deckSpecsBySize, {
    "8.0 wide": { ...small, tail: 6.625 },
  });
  assert.equal(Object.hasOwn(stored().deckSpecsBySize!, "8.75"), false);

  // 같은 이름을 유지하면 H-035 옵션 저장과 똑같이 동작함.
  const same = await patch({
    version: 5,
    size: "8.25",
    sizeName: "8.25",
    sizeDeckSpec: base,
  });
  assert.equal(same.status, 200);
  assert.deepEqual(same.body.product.sizes, ["8.0 wide", "8.25", "8.75"]);
  assert.deepEqual(same.body.product.deckSpecsBySize["8.25"], base);

  const writes = db.transactions.length;
  for (const sizeName of [
    "",
    " 8.9",
    "8.9 ",
    "x".repeat(51),
    "8.9, 9.0",
    "8.9\n",
    "__proto__",
    "constructor",
    "prototype",
    "8.75",
    8.9,
    null,
  ]) {
    const refused = await patch({
      version: 6,
      size: "8.25",
      sizeName,
      sizeDeckSpec: base,
    });
    assert.equal(refused.status, 400, JSON.stringify(sizeName));
  }
  for (const invalid of [
    { version: 6, size: "8.25", sizeName: "8.9" },
    { version: 6, sizeName: "8.9", sizeDeckSpec: base },
    { version: 6, size: "9.0", sizeName: "8.9", sizeDeckSpec: base },
    { version: 6, size: "8.25", sizeName: "8.9", sizeDeckSpec: base, sizes: "8.9" },
  ]) {
    assert.equal((await patch(invalid)).status, 400, JSON.stringify(invalid));
  }
  assert.equal(db.transactions.length, writes);

  const stale = await patch({
    version: 5,
    size: "8.25",
    sizeName: "8.9",
    sizeDeckSpec: base,
  });
  assert.equal(stale.status, 409);
  assert.deepEqual(stored().sizes, ["8.0 wide", "8.25", "8.75"]);

  // 이름을 바꾼 행도 DynamoDB marshaller를 그대로 통과함.
  const restored = unmarshall(marshall(stored(), { removeUndefinedValues: true }));
  assert.deepEqual(restored.sizes, ["8.0 wide", "8.25", "8.75"]);
  assert.equal(isCatalogProductRecord(restored), true);
});

test("a rename onto a stale key with an empty chart does not bring the stale chart back", async (t) => {
  const spec = { nose: 6.875, tail: 6.5, width: 8.25, length: 31.75, wheelbase: 14.25 };
  // "8.75"는 이전 서버가 이제 없는 옵션에 남긴 key임.
  const db = fixture(t, [
    product({ sizes: ["8.25", "8.5"], deckSpecsBySize: { "8.75": spec } }),
  ]);
  const renamed = unpack(
    await handler(
      event(
        "PATCH",
        { version: 3, size: "8.5", sizeName: "8.75", sizeDeckSpec: null },
        "prd_deck",
      ),
    ),
  );
  assert.equal(renamed.status, 200);
  assert.deepEqual(renamed.body.product.sizes, ["8.25", "8.75"]);
  assert.equal(renamed.body.product.deckSpecsBySize, undefined);
  assert.equal(Object.hasOwn(db.records.get("prd_deck")!, "deckSpecsBySize"), false);
});

test("an existing option the new-name rules would refuse still saves and deletes its chart", async (t) => {
  const spec = { nose: 6.875, tail: 6.5, width: 8.25, length: 31.75, wheelbase: 14.25 };
  // 배열로 보낸 상품 body는 옵션 하나에 쉼표를 저장할 수 있지만, 새 이름에는 쓸 수 없음.
  const legacy = "8.5, wide";
  const db = fixture(t, [product({ sizes: ["8.25", legacy] })]);
  for (const [version, body] of [
    [3, { size: legacy, sizeDeckSpec: spec }],
    [4, { size: legacy, sizeName: legacy, sizeDeckSpec: spec }],
    [5, { size: legacy, sizeDeckSpec: null }],
  ] as const) {
    const saved = unpack(
      await handler(event("PATCH", { version, ...body }, "prd_deck")),
    );
    assert.equal(saved.status, 200, JSON.stringify(body));
  }
  assert.deepEqual(db.records.get("prd_deck")!.sizes, ["8.25", legacy]);
  assert.equal(Object.hasOwn(db.records.get("prd_deck")!, "deckSpecsBySize"), false);
});

test("an option rename is refused while stock is reserved or when it duplicates another product", async (t) => {
  const spec = { nose: 6.875, tail: 6.5, width: 8.25, length: 31.75, wheelbase: 14.25 };
  const db = fixture(t, [
    product({ sizes: ["8.25", "8.5"], inventoryReserved: 1 }),
    product({
      productId: "prd_free",
      name: "Free deck",
      sku: "FREE-1",
      sizes: ["8.25"],
    }),
    product({
      productId: "prd_other",
      name: "Free deck",
      sku: "OTHER-1",
      sizes: ["9.0"],
    }),
  ]);
  const reserved = unpack(
    await handler(
      event(
        "PATCH",
        { version: 3, size: "8.5", sizeName: "8.75", sizeDeckSpec: spec },
        "prd_deck",
      ),
    ),
  );
  assert.equal(reserved.status, 409);
  assert.equal(reserved.body.code, "CATALOG_PRODUCT_RESERVED");
  // 표만 저장하는 요청은 예약 재고가 있는 상품에서도 계속 동작함.
  const chartOnly = unpack(
    await handler(
      event(
        "PATCH",
        { version: 3, size: "8.5", sizeName: "8.5", sizeDeckSpec: spec },
        "prd_deck",
      ),
    ),
  );
  assert.equal(chartOnly.status, 200);
  assert.deepEqual(db.records.get("prd_deck")!.sizes, ["8.25", "8.5"]);

  const duplicate = unpack(
    await handler(
      event(
        "PATCH",
        { version: 3, size: "8.25", sizeName: "9.0", sizeDeckSpec: null },
        "prd_free",
      ),
    ),
  );
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.code, "CATALOG_PRODUCT_DUPLICATE");
  assert.deepEqual(duplicate.body.productIds, ["prd_other"]);
  assert.deepEqual(db.records.get("prd_free")!.sizes, ["8.25"]);
});

test("a key left for a removed option does not count against the option limit", async (t) => {
  const spec = { nose: 6.875, tail: 6.5, width: 8.25, length: 31.75, wheelbase: 14.25 };
  const sizes = Array.from({ length: 20 }, (_, index) => `S${index}`);
  const legacy = Object.fromEntries([
    ...sizes.slice(0, 19).map((size) => [size, spec]),
    ["removed", spec],
  ]);
  const db = fixture(t, [product({ sizes, deckSpecsBySize: legacy })]);
  const saved = unpack(
    await handler(
      event("PATCH", { version: 3, size: "S19", sizeDeckSpec: spec }, "prd_deck"),
    ),
  );
  assert.equal(saved.status, 200);
  assert.deepEqual(
    Object.keys(db.records.get("prd_deck")!.deckSpecsBySize as object).sort(),
    [...sizes].sort(),
  );
});

test("internal rows cannot be addressed and are hidden without breaking catalog pagination", async (t) => {
  const db = fixture(t);
  await handler(event("POST", existing()));
  const ledger = [...db.records.values()].find(
    (item) => item.recordType === "CATALOG_INTAKE_RECEIPT",
  )!;
  assert.equal(
    unpack(
      await handler(
        event("GET", undefined, encodeURIComponent(ledger.productId as string)),
      ),
    ).status,
    404,
  );
  db.setEndlessScan();
  const list = unpack(await handler(event("GET")));
  assert.equal(list.body.products.length, 1);
  const cursorEvent = event("GET");
  cursorEvent.queryStringParameters = {
    cursor: Buffer.from(JSON.stringify({ productId: ledger.productId })).toString(
      "base64url",
    ),
  };
  assert.equal(unpack(await handler(cursorEvent)).status, 200);
});
test("admin authorization and table configuration fail before any storage mutation", async (t) => {
  const db = fixture(t);
  assert.equal(
    unpack(await handler(event("POST", fresh(), undefined, "", false))).status,
    401,
  );
  assert.equal(
    unpack(await handler(event("POST", fresh(), undefined, "not-admin", false))).status,
    403,
  );
  delete process.env.CATALOG_TABLE_NAME;
  assert.equal(unpack(await handler(event("POST", fresh()))).status, 503);
  assert.equal(db.reads.length, 0);
  assert.equal(db.transactions.length, 0);
});
test("storage read failure returns a safe error without contacting another service", async (t) => {
  const db = fixture(t);
  db.setFailRead();
  const response = unpack(await handler(event("POST", existing())));
  assert.equal(response.status, 503);
  assert.equal(JSON.stringify(response).includes("private"), false);
  assert.equal(db.transactions.length, 0);
});

test("a lost committed response is safely reconciled by the same operation replay", async (t) => {
  const db = fixture(t);
  db.loseCommitResponse();
  assert.equal(unpack(await handler(event("POST", existing()))).status, 503);
  const replay = unpack(await handler(event("POST", existing())));
  assert.equal(replay.status, 200);
  assert.equal(replay.body.receipt.replayed, true);
  assert.equal(db.records.get("prd_deck")!.inventoryQuantity, 12);
  assert.equal(db.transactions.length, 1);
});

test("duplicate scanning follows pages before deciding a new product is safe", async (t) => {
  const db = fixture(t);
  db.setScanPages([
    [product({ productId: "prd_first", name: "Unrelated" })],
    [product()],
  ]);
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
  assert.equal(db.scans.length, 2);
  assert.deepEqual(db.scans[1].ExclusiveStartKey, { productId: "prd_page_cursor" });
  assert.equal(db.transactions.length, 0);
});

test("normal create and OCR create share the same atomic identity guard", async (t) => {
  const db = fixture(t, []);
  const responses = await Promise.all([
    handler(event("POST", fresh())),
    handler(
      event("POST", {
        name: "New wheel",
        brandName: "Example",
        sizes: ["56mm"],
        category: "Wheels",
        price: 0,
      }),
    ),
  ]);
  assert.deepEqual(
    responses.map((response) => unpack(response).status).sort(),
    [201, 409],
  );
  assert.equal(db.transactions.length, 1);
});

test("cross-admin simultaneous replay cannot produce a second addition or disclose an outcome", async (t) => {
  const db = fixture(t);
  const responses = await Promise.all([
    handler(event("POST", existing(), undefined, "admin-A")),
    handler(event("POST", existing(), undefined, "admin-B")),
  ]);
  assert.deepEqual(
    responses.map((response) => unpack(response).status).sort(),
    [200, 409],
  );
  const conflict = responses.map(unpack).find((response) => response.status === 409)!;
  assert.equal(conflict.body.code, "OCR_INTAKE_OPERATION_CONFLICT");
  assert.equal(conflict.body.product, undefined);
  assert.equal(conflict.body.receipt, undefined);
  assert.equal(db.records.get("prd_deck")!.inventoryQuantity, 12);
  assert.equal(db.transactions.length, 1);
});

test("replay re-applies response allowlists instead of returning arbitrary stored fields", async (t) => {
  const db = fixture(t);
  await handler(event("POST", existing()));
  const ledger = [...db.records.values()].find(
    (item) => item.recordType === "CATALOG_INTAKE_RECEIPT",
  )!;
  const outcome = ledger.outcome as {
    product: Record<string, unknown>;
    receipt: Record<string, unknown>;
  };
  outcome.product.createdBy = "private actor";
  outcome.product.rawText = "private source";
  outcome.receipt.rawText = "private source";
  const replay = unpack(await handler(event("POST", existing())));
  assert.equal(replay.status, 200);
  assert.equal(JSON.stringify(replay).includes("private"), false);
});
