/** Real handler with an atomic, conditional in-memory SDK transport. No credentials or network. */
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
  REVISION,
  product,
  existing,
  fresh,
  event,
  unpack,
  fixture,
} from "./admin-catalog-handler-fixture.js";

test("version conflict, missing product, overflow and malformed intake do not write", async (t) => {
  const db = fixture(t);
  const cases: readonly [unknown, number][] = [
    [existing({ existing: { productId: "prd_deck", version: 2 } }), 409],
    [existing({ existing: { productId: "prd_missing", version: 1 } }), 404],
    [existing({ quantity: 1_000_000 }), 400],
    [existing({ quantity: -1 }), 400],
    [existing({ stock: 100 }), 400],
    [fresh({ product: { ...fresh().product, price: -1 } }), 400],
    [fresh({ product: { ...fresh().product, category: "Invalid" } }), 400],
    [fresh({ product: { ...fresh().product, status: "PUBLISHED" } }), 400],
  ];
  for (const [input, expected] of cases)
    assert.equal(unpack(await handler(event("POST", input))).status, expected);
  assert.equal(db.transactions.length, 0);
});
test("transaction failure leaves stock and receipt unchanged", async (t) => {
  const db = fixture(t);
  db.setFailWrite();
  const response = unpack(await handler(event("POST", existing())));
  assert.equal(response.status, 503);
  assert.equal(response.body.code, "CATALOG_STORAGE_UNAVAILABLE");
  assert.equal(JSON.stringify(response).includes("private"), false);
  assert.equal(db.records.get("prd_deck")!.inventoryQuantity, 10);
  assert.equal(db.records.size, 1);
});
test("failed or truncated identity scan fails closed without a product/receipt write", async (t) => {
  const db = fixture(t);
  db.setEndlessScan();
  assert.equal(unpack(await handler(event("POST", fresh()))).status, 503);
  assert.equal(db.scans.length, 1_000);
  db.setFailScan();
  assert.equal(unpack(await handler(event("POST", fresh()))).status, 503);
  assert.equal(db.transactions.length, 0);
});
test("malformed legacy records and malformed revision fail closed", async (t) => {
  const db = fixture(t);
  db.records.set("prd_broken", { productId: "prd_broken", name: "Hidden duplicate" });
  assert.equal(unpack(await handler(event("POST", fresh()))).status, 503);
  db.records.delete("prd_broken");
  db.records.set(REVISION, { productId: REVISION, recordType: "WRONG", version: 1 });
  assert.equal(unpack(await handler(event("POST", fresh()))).status, 503);
  assert.equal(db.transactions.length, 0);
});
test("normal creation uses the duplicate scan/revision transaction and preserves explicit ID conflicts", async (t) => {
  const db = fixture(t);
  const payload = {
    name: "Deck",
    brand: "Example",
    category: "Deck",
    price: 1,
    sizes: ["8.25"],
    stock: 0,
  };
  const duplicate = unpack(await handler(event("POST", payload)));
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.code, "CATALOG_PRODUCT_DUPLICATE");
  const idConflict = unpack(
    await handler(event("POST", { ...payload, productId: "prd_deck" })),
  );
  assert.equal(idConflict.body.code, "CATALOG_PRODUCT_ID_CONFLICT");
  const created = unpack(
    await handler(event("POST", { ...payload, name: "Another deck" })),
  );
  assert.equal(created.status, 201);
  assert.equal(created.body.product.status, "DRAFT");
  assert.equal(db.transactions.length, 1);
  assert.equal(db.transactions[0].TransactItems!.length, 2);
});
test("normal identity PATCH cannot introduce another product's identity and excludes itself", async (t) => {
  const db = fixture(t, [
    product(),
    product({ productId: "prd_other", name: "Other deck", sku: "OTHER" }),
  ]);
  const duplicate = unpack(
    await handler(event("PATCH", { version: 3, name: "Other deck" }, "prd_deck")),
  );
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.code, "CATALOG_PRODUCT_DUPLICATE");
  const same = unpack(
    await handler(event("PATCH", { version: 3, name: "Deck" }, "prd_deck")),
  );
  assert.equal(same.status, 200);
  assert.equal(same.body.product.version, 4);
  assert.equal(db.transactions.length, 1);
});
test("normal stock-only PATCH and DELETE still advance the revision atomically", async (t) => {
  const db = fixture(t);
  assert.equal(
    unpack(await handler(event("PATCH", { version: 3, stock: 20 }, "prd_deck"))).status,
    200,
  );
  assert.equal(db.records.get(REVISION)!.version, 1);
  assert.equal(db.scans.length, 0);
  assert.equal(
    unpack(await handler(event("DELETE", { version: 4 }, "prd_deck"))).status,
    200,
  );
  assert.equal(db.records.get(REVISION)!.version, 2);
  assert.equal(db.records.has("prd_deck"), false);
});

test("PATCH explicitly clears compareAtPrice without reviving it from the stored product", async (t) => {
  const db = fixture(t, [
    product({
      status: "PUBLISHED",
      publicationStatus: "PUBLISHED",
      image: "/deck.webp",
      price: 80_000,
      compareAtPrice: 100_000,
    }),
  ]);

  const clearedByNull = unpack(
    await handler(
      event("PATCH", { version: 3, price: 120_000, compareAtPrice: null }, "prd_deck"),
    ),
  );
  assert.equal(clearedByNull.status, 200);
  assert.equal(clearedByNull.body.product.price, 120_000);
  assert.equal(clearedByNull.body.product.compareAtPrice, undefined);
  assert.equal(Object.hasOwn(db.records.get("prd_deck")!, "compareAtPrice"), false);

  const changed = unpack(
    await handler(event("PATCH", { version: 4, compareAtPrice: 140_000 }, "prd_deck")),
  );
  assert.equal(changed.status, 200);
  assert.equal(changed.body.product.compareAtPrice, 140_000);

  const omitted = unpack(
    await handler(event("PATCH", { version: 5, featured: true }, "prd_deck")),
  );
  assert.equal(omitted.status, 200);
  assert.equal(omitted.body.product.compareAtPrice, 140_000);

  const successfulWrites = db.transactions.length;
  const invalid = unpack(
    await handler(event("PATCH", { version: 6, compareAtPrice: 0 }, "prd_deck")),
  );
  assert.equal(invalid.status, 400);
  assert.equal(db.transactions.length, successfulWrites);
  assert.equal(db.records.get("prd_deck")!.compareAtPrice, 140_000);
  assert.equal(db.records.get("prd_deck")!.version, 6);

  const clearedByEmptyText = unpack(
    await handler(event("PATCH", { version: 6, compareAtPrice: "" }, "prd_deck")),
  );
  assert.equal(clearedByEmptyText.status, 200);
  assert.equal(clearedByEmptyText.body.product.compareAtPrice, undefined);
  assert.equal(Object.hasOwn(db.records.get("prd_deck")!, "compareAtPrice"), false);
  assert.equal(
    toPublicCatalogProduct(db.records.get("prd_deck") as CatalogProductRecord)
      ?.compareAtPrice,
    undefined,
  );

  const productWrite = db.transactions
    .at(-1)!
    .TransactItems!.find((item) => item.Put?.Item?.productId === "prd_deck")!.Put!;
  assert.equal(productWrite.ConditionExpression, "#version = :expectedVersion");
  assert.equal(productWrite.ExpressionAttributeValues?.[":expectedVersion"], 6);

  const stale = unpack(
    await handler(event("PATCH", { version: 6, compareAtPrice: 150_000 }, "prd_deck")),
  );
  assert.equal(stale.status, 409);
  assert.equal(db.transactions.length, successfulWrites + 1);
  assert.equal(Object.hasOwn(db.records.get("prd_deck")!, "compareAtPrice"), false);
  assert.equal(db.records.get("prd_deck")!.version, 7);
});
test("deckSpec-only PATCH saves, publishes, survives other edits and clears with null", async (t) => {
  const db = fixture(t, [
    product({
      status: "PUBLISHED",
      publicationStatus: "PUBLISHED",
      image: "/deck.webp",
      inventoryQuantity: 10,
      inventoryReserved: 2,
    }),
  ]);
  const deckSpec = {
    nose: 6.875,
    tail: 6.5,
    width: 8.5,
    length: 31.75,
    wheelbase: 14.25,
  };

  // A reserved product still accepts a size-spec edit because it is not part of its identity.
  const saved = unpack(
    await handler(event("PATCH", { version: 3, deckSpec }, "prd_deck")),
  );
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.product.deckSpec, deckSpec);
  assert.equal(saved.body.product.version, 4);
  assert.deepEqual(
    toPublicCatalogProduct(db.records.get("prd_deck") as CatalogProductRecord)
      ?.deckSpec,
    deckSpec,
  );

  const otherEdit = unpack(
    await handler(event("PATCH", { version: 4, featured: true }, "prd_deck")),
  );
  assert.equal(otherEdit.status, 200);
  assert.deepEqual(otherEdit.body.product.deckSpec, deckSpec);

  const successfulWrites = db.transactions.length;
  for (const invalid of [
    { ...deckSpec, tail: 0 },
    { ...deckSpec, width: "8.5" },
    { ...deckSpec, length: 101 },
    { ...deckSpec, nose: 6.87501 },
    { ...deckSpec, tail: 1e-7 },
    { nose: 6.875 },
    "8.5",
  ]) {
    const rejected = unpack(
      await handler(event("PATCH", { version: 5, deckSpec: invalid }, "prd_deck")),
    );
    assert.equal(rejected.status, 400);
  }
  assert.equal(db.transactions.length, successfulWrites);
  assert.deepEqual(db.records.get("prd_deck")!.deckSpec, deckSpec);

  const cleared = unpack(
    await handler(event("PATCH", { version: 5, deckSpec: null }, "prd_deck")),
  );
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.product.deckSpec, undefined);
  assert.equal(Object.hasOwn(db.records.get("prd_deck")!, "deckSpec"), false);
  assert.equal(
    toPublicCatalogProduct(db.records.get("prd_deck") as CatalogProductRecord)
      ?.deckSpec,
    undefined,
  );
});

test("sizeDeckSpec PATCH saves and clears one option, keeps the default, and drops renamed options", async (t) => {
  const db = fixture(t, [
    product({
      status: "PUBLISHED",
      publicationStatus: "PUBLISHED",
      image: "/deck.webp",
      sizes: ["8.0", "8.25", "8.5"],
    }),
  ]);
  const base = { nose: 6.875, tail: 6.5, width: 8.25, length: 31.75, wheelbase: 14.25 };
  const small = { ...base, width: 8, wheelbase: 14 };
  const large = { ...base, width: 8.5, length: 32 };
  const stored = () => db.records.get("prd_deck") as CatalogProductRecord;
  const patch = async (body: Record<string, unknown>) =>
    unpack(await handler(event("PATCH", body, "prd_deck")));

  assert.equal((await patch({ version: 3, deckSpec: base })).status, 200);
  const savedSmall = await patch({ version: 4, size: "8.0", sizeDeckSpec: small });
  assert.equal(savedSmall.status, 200);
  assert.deepEqual(savedSmall.body.product.deckSpec, base);
  assert.deepEqual(savedSmall.body.product.deckSpecsBySize, { "8.0": small });
  const savedLarge = await patch({ version: 5, size: "8.5", sizeDeckSpec: large });
  assert.deepEqual(savedLarge.body.product.deckSpecsBySize, {
    "8.0": small,
    "8.5": large,
  });
  assert.deepEqual(toPublicCatalogProduct(stored())?.deckSpecsBySize, {
    "8.0": small,
    "8.5": large,
  });
  assert.deepEqual(toPublicCatalogProduct(stored())?.deckSpec, base);

  // A default-only save leaves the option values alone.
  const defaultEdit = await patch({ version: 6, deckSpec: { ...base, tail: 6.625 } });
  assert.deepEqual(defaultEdit.body.product.deckSpecsBySize, {
    "8.0": small,
    "8.5": large,
  });

  const writes = db.transactions.length;
  for (const invalid of [
    { version: 7, size: "9.0", sizeDeckSpec: small },
    { version: 7, size: " 8.0", sizeDeckSpec: small },
    { version: 7, size: 8, sizeDeckSpec: small },
    { version: 7, sizeDeckSpec: small },
    { version: 7, size: "8.0" },
    { version: 7, size: "8.0", deckSpec: small },
    { version: 7, size: "8.0", sizeDeckSpec: small, deckSpec: base },
    { version: 7, size: "8.0", sizeDeckSpec: small, sizes: "8.0" },
    { version: 7, size: "8.0", sizeDeckSpec: { ...small, tail: 0 } },
    { version: 7, size: "8.0", sizeDeckSpec: "8.5" },
  ]) {
    assert.equal((await patch(invalid)).status, 400, JSON.stringify(invalid));
  }
  // The full map is server-built and cannot be replaced directly through PATCH.
  const ignored = await patch({ version: 7, deckSpecsBySize: { "8.25": base } });
  assert.equal(ignored.status, 200);
  assert.deepEqual(ignored.body.product.deckSpecsBySize, {
    "8.0": small,
    "8.5": large,
  });
  assert.equal(db.transactions.length, writes + 1);

  const stale = await patch({ version: 7, size: "8.0", sizeDeckSpec: null });
  assert.equal(stale.status, 409);
  assert.deepEqual(stored().deckSpecsBySize, { "8.0": small, "8.5": large });

  const cleared = await patch({ version: 8, size: "8.0", sizeDeckSpec: null });
  assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.body.product.deckSpecsBySize, { "8.5": large });
  assert.deepEqual(cleared.body.product.deckSpec, { ...base, tail: 6.625 });

  // Renaming 8.5 through a product save drops its value; the empty map leaves the row.
  const renamed = await patch({ version: 9, sizes: "8.0, 8.25, 8.75" });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.product.deckSpecsBySize, undefined);
  assert.equal(Object.hasOwn(stored(), "deckSpecsBySize"), false);
  assert.deepEqual(stored().deckSpec, { ...base, tail: 6.625 });
});

test("only option values whose size still exists are kept or returned", async (t) => {
  const spec = { nose: 6.875, tail: 6.5, width: 8.25, length: 31.75, wheelbase: 14.25 };
  // A row written while an older server ignored the pruning may still hold a removed option.
  const legacy = product({
    status: "PUBLISHED",
    publicationStatus: "PUBLISHED",
    image: "/deck.webp",
    sizes: ["8.25", "8.5"],
    deckSpecsBySize: { "8.25": spec, "8.0": spec },
  });
  const db = fixture(t, [legacy]);
  assert.deepEqual(toPublicCatalogProduct(legacy)?.deckSpecsBySize, { "8.25": spec });
  const read = unpack(await handler(event("GET", undefined, "prd_deck")));
  assert.deepEqual(read.body.product.deckSpecsBySize, { "8.25": spec });

  const saved = unpack(
    await handler(event("PATCH", { version: 3, featured: true }, "prd_deck")),
  );
  assert.equal(saved.status, 200);
  assert.deepEqual(db.records.get("prd_deck")!.deckSpecsBySize, { "8.25": spec });
  assert.equal(
    isCatalogProductRecord(
      product({ deckSpecsBySize: { "8.25": { ...spec, tail: 0 } } }),
    ),
    false,
  );
});

test("option size charts are never taken from a create body", async (t) => {
  const db = fixture(t, []);
  const spec = { nose: 6.875, tail: 6.5, width: 8.25, length: 31.75, wheelbase: 14.25 };
  const created = unpack(
    await handler(
      event("POST", {
        name: "New deck",
        brandName: "Example",
        sizes: ["8.25"],
        category: "Deck",
        price: 80_000,
        deckSpecsBySize: { "8.25": spec },
      }),
    ),
  );
  assert.equal(created.status, 201);
  assert.equal(created.body.product.deckSpecsBySize, undefined);
  const row = [...db.records.values()].find((item) => item.name === "New deck")!;
  assert.equal(Object.hasOwn(row, "deckSpecsBySize"), false);
});

test("unsafe option names are refused and saved option charts survive DynamoDB marshalling", async (t) => {
  const unsafe = ["__proto__", "constructor", "prototype"];
  const db = fixture(t, [product({ sizes: [...unsafe, "8.25"] })]);
  const spec = { nose: 6.875, tail: 6.5, width: 8.25, length: 31.75, wheelbase: 14.25 };
  for (const size of unsafe) {
    const refused = unpack(
      await handler(
        event("PATCH", { version: 3, size, sizeDeckSpec: spec }, "prd_deck"),
      ),
    );
    assert.equal(refused.status, 400, size);
  }
  assert.equal(db.transactions.length, 0);

  const saved = unpack(
    await handler(
      event("PATCH", { version: 3, size: "8.25", sizeDeckSpec: spec }, "prd_deck"),
    ),
  );
  assert.equal(saved.status, 200);
  // The in-memory transport skips the SDK conversion, so round-trip the stored row through it.
  const row = db.records.get("prd_deck")!;
  const restored = unmarshall(marshall(row, { removeUndefinedValues: true }));
  assert.deepEqual(restored.deckSpecsBySize, { "8.25": spec });
  assert.equal(isCatalogProductRecord(restored), true);

  // A row that somehow holds such a key never returns it.
  const legacy = product({
    status: "PUBLISHED",
    publicationStatus: "PUBLISHED",
    image: "/deck.webp",
    sizes: [...unsafe, "8.25"],
    deckSpecsBySize: JSON.parse(
      JSON.stringify({ "8.25": spec, constructor: spec, prototype: spec }).replace(
        '"prototype"',
        '"__proto__"',
      ),
    ),
  });
  assert.deepEqual(toPublicCatalogProduct(legacy)?.deckSpecsBySize, { "8.25": spec });
});
