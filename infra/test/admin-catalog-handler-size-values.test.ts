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
  product,
  event,
  unpack,
  fixture,
  shortSleeve,
  top,
} from "./admin-catalog-handler-fixture.js";

const raglanValues = {
  length: 70,
  chest: 58,
  cuff: 10,
  neckToCuff: 80,
  hem: 50,
  armhole: 30,
};
const deckValues = {
  nose: 6.875,
  tail: 6.5,
  width: 8.5,
  length: 31.75,
  wheelbase: 14.25,
};
type Row = CatalogProductRecord;

test("sizeChartValues PATCH saves and clears one option under the product's drawing, even without a default", async (t) => {
  const db = fixture(t, [top({ sizes: ["S", "M"] })]);
  const stored = () => db.records.get("prd_top") as Row;
  const patch = async (body: Record<string, unknown>) =>
    unpack(await handler(event("PATCH", body, "prd_top")));
  // No default and no chosen drawing yet: the category's default drawing applies and is recorded.
  const saved = await patch({
    version: 3,
    size: "M",
    sizeChartValues: shortSleeve.values,
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.product.sizeChartKind, "shortSleeve");
  assert.deepEqual(saved.body.product.sizeChartsBySize, { M: shortSleeve.values });
  assert.equal(saved.body.product.sizeChart, undefined);
  assert.equal(stored().sizeChartKind, "shortSleeve");
  assert.deepEqual(toPublicCatalogProduct(stored())?.sizeChartsBySize, {
    M: shortSleeve.values,
  });
  assert.equal(toPublicCatalogProduct(stored())?.sizeChartKind, "shortSleeve");

  const writes = db.transactions.length;
  for (const invalid of [
    // Other fields never ride along, so an older server cannot half-apply it.
    { version: 4, size: "M", sizeChartValues: shortSleeve.values, featured: true },
    { version: 4, size: "M", sizeChartValues: shortSleeve.values, sizeDeckSpec: null },
    { version: 4, size: "M", sizeChartValues: shortSleeve.values, sizeChart: null },
    { version: 4, size: "XL", sizeChartValues: shortSleeve.values },
    { version: 4, size: "__proto__", sizeChartValues: shortSleeve.values },
    { version: 4, size: "M", sizeChartValues: raglanValues },
    {
      version: 4,
      size: "M",
      sizeChartValues: { ...shortSleeve.values, length: 300.1 },
    },
    { version: 4, size: "M", sizeChartValues: "72" },
    { version: 4, size: "M" },
  ])
    assert.equal((await patch(invalid)).status, 400, JSON.stringify(invalid));
  assert.equal(db.transactions.length, writes);

  const cleared = await patch({ version: 4, size: "M", sizeChartValues: null });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.product.sizeChartsBySize, undefined);
  assert.equal(Object.hasOwn(stored(), "sizeChartsBySize"), false);
  // The chosen drawing stays after its last value is gone.
  assert.equal(cleared.body.product.sizeChartKind, "shortSleeve");

  // A deck has no clothing or wheel drawing to follow.
  const deck = fixture(t, [product()]);
  assert.equal(
    unpack(
      await handler(
        event(
          "PATCH",
          {
            version: 3,
            size: "8.25",
            sizeChartValues: { diameter: 54, width: 33, contactWidth: 20 },
          },
          "prd_deck",
        ),
      ),
    ).status,
    400,
  );
  assert.equal(deck.transactions.length, 0);
});

test("the kind PATCH clears the default and every option value; a default cannot switch drawing under option values", async (t) => {
  const db = fixture(t, [
    top({
      sizes: ["S", "M"],
      sizeChart: shortSleeve as Row["sizeChart"],
      sizeChartKind: "shortSleeve",
      sizeChartsBySize: { M: shortSleeve.values },
    }),
  ]);
  const stored = () => db.records.get("prd_top") as Row;
  const patch = async (body: Record<string, unknown>) =>
    unpack(await handler(event("PATCH", body, "prd_top")));
  const raglan = { kind: "raglanLongSleeve", values: raglanValues };
  assert.equal((await patch({ version: 3, sizeChart: raglan })).status, 400);
  const sameKind = await patch({
    version: 3,
    sizeChart: { ...shortSleeve, values: { ...shortSleeve.values, length: 73 } },
  });
  assert.equal(sameKind.status, 200);
  assert.deepEqual(stored().sizeChartsBySize, { M: shortSleeve.values });

  const writes = db.transactions.length;
  for (const invalid of [
    { version: 4, sizeChartKind: "wheel" },
    { version: 4, sizeChartKind: "deck" },
    { version: 4, sizeChartKind: null },
    { version: 4, sizeChartKind: "raglanLongSleeve", featured: true },
    { version: 4, sizeChartKind: "raglanLongSleeve", sizeChart: raglan },
  ])
    assert.equal((await patch(invalid)).status, 400, JSON.stringify(invalid));
  assert.equal(db.transactions.length, writes);

  // Choosing the drawing already in use keeps every value.
  const same = await patch({ version: 4, sizeChartKind: "shortSleeve" });
  assert.equal(same.status, 200);
  assert.equal(stored().sizeChart?.values.length, 73);
  assert.deepEqual(stored().sizeChartsBySize, { M: shortSleeve.values });

  const changed = await patch({ version: 5, sizeChartKind: "raglanLongSleeve" });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.product.sizeChartKind, "raglanLongSleeve");
  assert.equal(changed.body.product.sizeChart, undefined);
  assert.equal(changed.body.product.sizeChartsBySize, undefined);
  for (const field of ["sizeChart", "sizeChartsBySize"])
    assert.equal(Object.hasOwn(stored(), field), false, field);
  // New values now follow the new drawing.
  assert.equal(
    (await patch({ version: 6, size: "S", sizeChartValues: raglanValues })).status,
    200,
  );
  assert.equal((await patch({ version: 7, sizeChart: raglan })).status, 200);
  assert.deepEqual(stored().sizeChartsBySize, { S: raglanValues });
});

test("renaming an option moves both kinds of option value, and saves prune missing options and special keys", async (t) => {
  const db = fixture(t, [
    top({
      sizes: ["S", "M"],
      sizeChartKind: "shortSleeve",
      sizeChartsBySize: { S: shortSleeve.values, M: shortSleeve.values },
      deckSpecsBySize: { S: deckValues },
    }),
  ]);
  const stored = () => db.records.get("prd_top") as Row;
  const patch = async (body: Record<string, unknown>) =>
    unpack(await handler(event("PATCH", body, "prd_top")));
  const longer = { ...shortSleeve.values, length: 75 };
  const renamed = await patch({
    version: 3,
    size: "M",
    sizeName: "L",
    sizeChartValues: longer,
  });
  assert.equal(renamed.status, 200);
  assert.deepEqual(stored().sizes, ["S", "L"]);
  assert.deepEqual(stored().sizeChartsBySize, { S: shortSleeve.values, L: longer });
  // A deck-value rename carries the size chart value along too.
  const deckRename = await patch({
    version: 4,
    size: "S",
    sizeName: "XS",
    sizeDeckSpec: null,
  });
  assert.equal(deckRename.status, 200);
  assert.deepEqual(stored().sizeChartsBySize, { L: longer, XS: shortSleeve.values });
  assert.equal(Object.hasOwn(stored(), "deckSpecsBySize"), false);

  // A product save that drops an option drops its value.
  assert.equal((await patch({ version: 5, sizes: ["XS"] })).status, 200);
  assert.deepEqual(stored().sizeChartsBySize, { XS: shortSleeve.values });

  // DynamoDB keeps the nested values exactly.
  const restored = unmarshall(
    marshall(stored(), { removeUndefinedValues: true }),
  ) as Row;
  assert.deepEqual(restored.sizeChartsBySize, stored().sizeChartsBySize);
  assert.equal(restored.sizeChartKind, "shortSleeve");
  assert.equal(isCatalogProductRecord(restored), true);

  // Keys that are not options, or that name Object internals, never reach a response.
  const legacy = top({
    sizes: ["M", "__proto__", "constructor"],
    sizeChartKind: "shortSleeve",
    sizeChartsBySize: JSON.parse(
      `{"__proto__":${JSON.stringify(shortSleeve.values)},"constructor":${JSON.stringify(shortSleeve.values)},"M":${JSON.stringify(shortSleeve.values)},"XL":${JSON.stringify(shortSleeve.values)}}`,
    ),
  });
  assert.equal(isCatalogProductRecord(legacy), true);
  const output = toPublicCatalogProduct(legacy)?.sizeChartsBySize;
  assert.deepEqual(Object.keys(output ?? {}), ["M"]);
  assert.equal(Object.getPrototypeOf(output), Object.prototype);
});

test("a category change drops option values and the chosen drawing it cannot use; creation ignores them", async (t) => {
  const db = fixture(t, [
    top({
      sizes: ["M"],
      sizeChartKind: "raglanLongSleeve",
      sizeChartsBySize: { M: raglanValues },
    }),
  ]);
  const stored = () => db.records.get("prd_top") as Row;
  assert.equal(
    unpack(
      await handler(event("PATCH", { version: 3, category: "Outerwear" }, "prd_top")),
    ).status,
    200,
  );
  assert.deepEqual(stored().sizeChartsBySize, { M: raglanValues });
  assert.equal(stored().sizeChartKind, "raglanLongSleeve");
  const bottom = unpack(
    await handler(event("PATCH", { version: 4, category: "Bottom" }, "prd_top")),
  );
  assert.equal(bottom.status, 200);
  for (const field of ["sizeChartKind", "sizeChartsBySize"]) {
    assert.equal(Object.hasOwn(stored(), field), false, field);
    assert.equal(bottom.body.product[field], undefined, field);
  }

  const created = unpack(
    await handler(
      event("POST", {
        name: "Fresh top",
        brand: "Example",
        category: "Top",
        price: 1,
        sizes: ["M"],
        stock: 0,
        sizeChartKind: "raglanLongSleeve",
        sizeChartsBySize: { M: raglanValues },
      }),
    ),
  );
  assert.equal(created.status, 201);
  const record = [...db.records.values()].find((row) => row.name === "Fresh top")!;
  for (const field of ["sizeChartKind", "sizeChartsBySize"])
    assert.equal(Object.hasOwn(record, field), false, field);
});

const partialDeck = {
  nose: 6.875,
  tail: null,
  width: null,
  length: 31.75,
  wheelbase: null,
};

test("a deck row with blank size fields stays a valid product in the admin list and the store", async (t) => {
  // The record check runs on every read; a blank field must never hide the product.
  const row = product({
    status: "PUBLISHED",
    publicationStatus: "PUBLISHED",
    image: "/deck.webp",
    sizes: ["8.25", "8.5"],
    deckSpec: partialDeck,
    deckSpecsBySize: { "8.5": { ...partialDeck, nose: null, tail: 6.5 } },
  });
  assert.equal(isCatalogProductRecord(row), true);
  const visible = toPublicCatalogProduct(row);
  assert.deepEqual(visible?.deckSpec, partialDeck);
  assert.deepEqual(visible?.deckSpecsBySize, {
    "8.5": { ...partialDeck, nose: null, tail: 6.5 },
  });
  // DynamoDB keeps the blank fields as null.
  const restored = unmarshall(marshall(row, { removeUndefinedValues: true }));
  assert.deepEqual(restored.deckSpec, partialDeck);
  assert.equal(isCatalogProductRecord(restored), true);

  fixture(t, [row]);
  const list = unpack(await handler(event("GET")));
  assert.equal(list.status, 200);
  assert.equal(list.body.products.length, 1);
  assert.deepEqual(list.body.products[0].deckSpec, partialDeck);
  const read = unpack(await handler(event("GET", undefined, "prd_deck")));
  assert.deepEqual(read.body.product.deckSpecsBySize["8.5"].nose, null);
  // A broken value still makes the row invalid, as before.
  assert.equal(
    isCatalogProductRecord(product({ deckSpec: { ...partialDeck, tail: 0 } })),
    false,
  );
});

test("a deckSpec PATCH saves blank fields as null and needs at least one number", async (t) => {
  const db = fixture(t, [product({ sizes: ["8.25", "8.5"] })]);
  const stored = () => db.records.get("prd_deck") as CatalogProductRecord;
  const patch = async (body: Record<string, unknown>) =>
    unpack(await handler(event("PATCH", body, "prd_deck")));

  const saved = await patch({ version: 3, deckSpec: partialDeck });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.product.deckSpec, partialDeck);
  assert.deepEqual(stored().deckSpec, partialDeck);

  const writes = db.transactions.length;
  for (const invalid of [
    { nose: null, tail: null, width: null, length: null, wheelbase: null },
    // Every field must still be present; a blank one is null, not missing.
    { nose: 6.875, tail: null, width: null, length: 31.75 },
    { ...partialDeck, tail: "null" },
    { ...partialDeck, tail: 0 },
  ]) {
    assert.equal((await patch({ version: 4, deckSpec: invalid })).status, 400);
    assert.equal(
      (await patch({ version: 4, size: "8.5", sizeDeckSpec: invalid })).status,
      400,
    );
  }
  assert.equal(db.transactions.length, writes);

  // One option with blank fields, then a rename that carries it.
  const option = { ...partialDeck, width: 8.5 };
  const optionSaved = await patch({ version: 4, size: "8.5", sizeDeckSpec: option });
  assert.equal(optionSaved.status, 200);
  assert.deepEqual(stored().deckSpecsBySize, { "8.5": option });
  const renamed = await patch({
    version: 5,
    size: "8.5",
    sizeName: "8.6",
    sizeDeckSpec: { ...option, tail: 6.5 },
  });
  assert.equal(renamed.status, 200);
  assert.deepEqual(stored().deckSpecsBySize, { "8.6": { ...option, tail: 6.5 } });
  // An unrelated edit keeps the blank fields, and deleting still uses null.
  assert.equal((await patch({ version: 6, featured: true })).status, 200);
  assert.deepEqual(stored().deckSpec, partialDeck);
  assert.equal((await patch({ version: 7, deckSpec: null })).status, 200);
  assert.equal(Object.hasOwn(stored(), "deckSpec"), false);
  // An older client's full spec still saves as before.
  assert.equal(
    (
      await patch({
        version: 8,
        deckSpec: {
          nose: 6.875,
          tail: 6.5,
          width: 8.5,
          length: 31.75,
          wheelbase: 14.25,
        },
      })
    ).status,
    200,
  );
});

test("clothing and wheel size charts save blank fields as null on every path and keep them", async (t) => {
  const partialTop = { ...shortSleeve.values, shoulder: null, armhole: null };
  const db = fixture(t, [top({ sizes: ["S", "M"] })]);
  const stored = () => db.records.get("prd_top") as CatalogProductRecord;
  const patch = async (body: Record<string, unknown>) =>
    unpack(await handler(event("PATCH", body, "prd_top")));

  const saved = await patch({
    version: 3,
    sizeChart: { kind: "shortSleeve", values: partialTop },
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.product.sizeChart.values, partialTop);
  const option = { ...partialTop, length: null, chest: 58 };
  assert.equal(
    (await patch({ version: 4, size: "M", sizeChartValues: option })).status,
    200,
  );
  assert.deepEqual(stored().sizeChartsBySize, { M: option });

  const writes = db.transactions.length;
  const allBlank = Object.fromEntries(
    Object.keys(partialTop).map((key) => [key, null]),
  );
  const missingKey = Object.fromEntries(
    Object.entries(partialTop).filter(([key]) => key !== "armhole"),
  );
  for (const values of [allBlank, missingKey, { ...partialTop, chest: "null" }]) {
    assert.equal(
      (await patch({ version: 5, sizeChart: { kind: "shortSleeve", values } })).status,
      400,
    );
    assert.equal(
      (await patch({ version: 5, size: "S", sizeChartValues: values })).status,
      400,
    );
  }
  assert.equal(db.transactions.length, writes);

  // A rename carries the blank fields, and both outputs keep them as null.
  assert.equal(
    (await patch({ version: 5, size: "M", sizeName: "L", sizeChartValues: option }))
      .status,
    200,
  );
  assert.deepEqual(stored().sizeChartsBySize, { L: option });
  assert.deepEqual(toPublicCatalogProduct(stored())?.sizeChartsBySize, { L: option });
  assert.deepEqual(toPublicCatalogProduct(stored())?.sizeChart?.values, partialTop);
  const restored = unmarshall(marshall(stored(), { removeUndefinedValues: true }));
  assert.deepEqual(restored.sizeChart.values, partialTop);
  assert.deepEqual(restored.sizeChartsBySize, { L: option });
  assert.equal(isCatalogProductRecord(restored), true);

  // A product save keeps them; a drawing switch clears them like any other values.
  assert.equal((await patch({ version: 6, sizes: ["S", "L"] })).status, 200);
  assert.deepEqual(stored().sizeChartsBySize, { L: option });
  assert.equal(
    (await patch({ version: 7, sizeChartKind: "raglanLongSleeve" })).status,
    200,
  );
  for (const field of ["sizeChart", "sizeChartsBySize"])
    assert.equal(Object.hasOwn(stored(), field), false, field);
});
