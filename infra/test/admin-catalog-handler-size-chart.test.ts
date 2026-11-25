/** Real handler with an atomic, conditional in-memory SDK transport. No credentials or network. */
import assert from "node:assert/strict";
import test from "node:test";
import {
  handler,
  isCatalogProductRecord,
  toPublicCatalogProduct,
  type CatalogProductRecord,
} from "../lambda/admin-catalog-handler.js";
import {
  SIZE_CHART_KIND_RULES,
  SIZE_CHART_KINDS,
  isSizeChartValues,
  sizeChartKindsFor,
} from "../lambda/size-chart-rules.js";
import {
  event,
  unpack,
  fixture,
  shortSleeve,
  longPants,
  top,
} from "./admin-catalog-handler-fixture.js";

test("sizeChart PATCH saves a kind the category offers, publishes, survives other edits and clears with null", async (t) => {
  const db = fixture(t, [top()]);
  const stored = () => db.records.get("prd_top") as CatalogProductRecord;
  const saved = unpack(
    await handler(event("PATCH", { version: 3, sizeChart: shortSleeve }, "prd_top")),
  );
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.product.sizeChart, shortSleeve);
  assert.deepEqual(stored().sizeChart, shortSleeve);
  assert.deepEqual(toPublicCatalogProduct(stored())?.sizeChart, shortSleeve);

  // Like deckSpec, other fields may come with it or without it.
  const otherEdit = unpack(
    await handler(event("PATCH", { version: 4, featured: true }, "prd_top")),
  );
  assert.deepEqual(otherEdit.body.product.sizeChart, shortSleeve);
  const raglan = {
    kind: "raglanLongSleeve",
    values: { length: 70, chest: 58, cuff: 10, neckToCuff: 80, hem: 50, armhole: 30 },
  };
  const together = unpack(
    await handler(
      event("PATCH", { version: 5, featured: false, sizeChart: raglan }, "prd_top"),
    ),
  );
  assert.equal(together.status, 200);
  assert.deepEqual(stored().sizeChart, raglan);
  assert.equal(stored().featured, false);

  const writes = db.transactions.length;
  const { values } = shortSleeve;
  for (const invalid of [
    "shortSleeve",
    [],
    { kind: "shortSleeve" },
    { ...shortSleeve, extra: 1 },
    { kind: "deck", values },
    // Wheels and pants are real kinds, but not ones a top can use.
    { kind: "wheel", values: { diameter: 54, width: 33, contactWidth: 20 } },
    longPants,
    { kind: "shortSleeve", values: { ...values, armhole: undefined } },
    { kind: "shortSleeve", values: { ...values, extra: 1 } },
    { kind: "shortSleeve", values: { ...values, length: 0 } },
    { kind: "shortSleeve", values: { ...values, length: 300.1 } },
    { kind: "shortSleeve", values: { ...values, length: 72.25 } },
    { kind: "shortSleeve", values: { ...values, length: "72" } },
  ]) {
    const rejected = unpack(
      await handler(event("PATCH", { version: 6, sizeChart: invalid }, "prd_top")),
    );
    assert.equal(rejected.status, 400, JSON.stringify(invalid));
  }
  assert.equal(db.transactions.length, writes);
  assert.deepEqual(stored().sizeChart, raglan);

  const cleared = unpack(
    await handler(event("PATCH", { version: 6, sizeChart: null }, "prd_top")),
  );
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.product.sizeChart, undefined);
  assert.equal(Object.hasOwn(stored(), "sizeChart"), false);
});

test("a category change keeps a size chart the new category offers and drops one it does not", async (t) => {
  const db = fixture(t, [
    top({ sizeChart: shortSleeve as CatalogProductRecord["sizeChart"] }),
  ]);
  const stored = () => db.records.get("prd_top") as CatalogProductRecord;
  // Top and Outerwear share both top drawings.
  const outerwear = unpack(
    await handler(event("PATCH", { version: 3, category: "Outerwear" }, "prd_top")),
  );
  assert.equal(outerwear.status, 200);
  assert.deepEqual(stored().sizeChart, shortSleeve);
  // A top drawing means nothing for bottoms, so it is removed rather than kept hidden.
  const bottom = unpack(
    await handler(event("PATCH", { version: 4, category: "Bottom" }, "prd_top")),
  );
  assert.equal(bottom.status, 200);
  assert.equal(bottom.body.product.sizeChart, undefined);
  assert.equal(Object.hasOwn(stored(), "sizeChart"), false);
  // A chart sent with the category change is checked against the new category.
  assert.equal(
    unpack(
      await handler(
        event(
          "PATCH",
          { version: 5, category: "Wheels", sizeChart: longPants },
          "prd_top",
        ),
      ),
    ).status,
    400,
  );
  // A category that is not even a string is a bad request, not a crash, and writes nothing.
  const writes = db.transactions.length;
  for (const category of [{ toString: null }, ["Bottom"], 7, null])
    assert.equal(
      unpack(
        await handler(
          event("PATCH", { version: 5, category, sizeChart: longPants }, "prd_top"),
        ),
      ).status,
      400,
      JSON.stringify(category),
    );
  assert.equal(db.transactions.length, writes);
  const both = unpack(
    await handler(
      event(
        "PATCH",
        { version: 5, category: "Bottom", sizeChart: longPants },
        "prd_top",
      ),
    ),
  );
  assert.equal(both.status, 200);
  assert.deepEqual(stored().sizeChart, longPants);
  // Deck keeps its own deckSpec; a deck cannot hold this chart.
  assert.equal(
    unpack(await handler(event("PATCH", { version: 6, category: "Deck" }, "prd_top")))
      .status,
    200,
  );
  assert.equal(Object.hasOwn(stored(), "sizeChart"), false);
});

test("product creation ignores sizeChart, which is saved only by PATCH", async (t) => {
  const db = fixture(t, []);
  const created = unpack(
    await handler(
      event("POST", {
        name: "New top",
        brand: "Example",
        category: "Top",
        price: 1,
        sizes: ["M"],
        stock: 0,
        sizeChart: shortSleeve,
      }),
    ),
  );
  assert.equal(created.status, 201);
  assert.equal(created.body.product.sizeChart, undefined);
  const record = [...db.records.values()].find((row) => row.name === "New top");
  assert.equal(Object.hasOwn(record!, "sizeChart"), false);
});

test("a malformed or mismatched stored size chart never hides the product and is left out", async (t) => {
  for (const sizeChart of [
    { kind: "shortSleeve", values: { length: 72 } },
    { ...longPants },
    "72",
  ]) {
    const row = top({
      sizeChart: sizeChart as unknown as CatalogProductRecord["sizeChart"],
    });
    assert.equal(isCatalogProductRecord(row), true);
    const visible = toPublicCatalogProduct(row);
    assert.equal(visible?.slug, "top");
    assert.equal(visible?.sizeChart, undefined);
  }
  const db = fixture(t, [
    top({ sizeChart: longPants as unknown as CatalogProductRecord["sizeChart"] }),
  ]);
  const read = unpack(await handler(event("GET", undefined, "prd_top")));
  assert.equal(read.status, 200);
  assert.equal(read.body.product.sizeChart, undefined);
  // An unrelated save still works and cleans the unusable value away.
  const saved = unpack(
    await handler(event("PATCH", { version: 3, featured: true }, "prd_top")),
  );
  assert.equal(saved.status, 200);
  assert.equal(Object.hasOwn(db.records.get("prd_top")!, "sizeChart"), false);
});

test("server size chart rules match the storefront rules table", async () => {
  // The root package is not an infra dependency, so it is loaded at run time only.
  const client = (await import(
    new URL("../../lib/size-chart.ts", import.meta.url).href
  )) as {
    SIZE_CHART_KINDS: readonly string[];
    SIZE_CHART_KIND_INFO: Record<string, { unit: string; fields: { key: string }[] }>;
    sizeChartKindsFor: (category: string) => readonly string[];
    isSizeChartValues: (kind: string, value: unknown) => boolean;
  };
  assert.deepEqual([...SIZE_CHART_KINDS], [...client.SIZE_CHART_KINDS]);
  for (const kind of SIZE_CHART_KINDS) {
    const info = client.SIZE_CHART_KIND_INFO[kind];
    assert.equal(SIZE_CHART_KIND_RULES[kind].unit, info.unit, kind);
    assert.deepEqual(
      [...SIZE_CHART_KIND_RULES[kind].keys],
      info.fields.map((field) => field.key),
      kind,
    );
  }
  // Both sides judge the same values, including each unit's edges, the same way.
  for (const kind of SIZE_CHART_KINDS) {
    const { unit, keys } = SIZE_CHART_KIND_RULES[kind];
    const max = unit === "mm" ? 100 : 300;
    const filled = (value: unknown) =>
      Object.fromEntries(keys.map((key) => [key, value]));
    const cases: [unknown, boolean][] = [
      [filled(max), true],
      [filled(0.1), true],
      [filled(12.5), true],
      [filled(max + 0.1), false],
      [filled(0), false],
      [filled(-1), false],
      [filled(12.25), false],
      [filled("12"), false],
      [filled(Number.NaN), false],
      [filled(Number.POSITIVE_INFINITY), false],
      [{ ...filled(12), extra: 12 }, false],
      [Object.fromEntries(keys.slice(1).map((key) => [key, 12])), false],
      [null, false],
      [[], false],
      // Blank fields are null; at least one number has to remain.
      [Object.fromEntries(keys.map((key, index) => [key, index ? null : 12])), true],
      [Object.fromEntries(keys.map((key, index) => [key, index ? 12.5 : null])), true],
      [filled(null), false],
      [{ ...filled(null), [keys[0]]: "12" }, false],
      [{ ...filled(12), [keys[0]]: undefined }, false],
    ];
    for (const [value, expected] of cases) {
      const label = `${kind} ${JSON.stringify(value)}`;
      assert.equal(isSizeChartValues(kind, value), expected, label);
      assert.equal(client.isSizeChartValues(kind, value), expected, label);
    }
  }
  assert.equal(
    isSizeChartValues("wheel", { diameter: 100, width: 100, contactWidth: 100 }),
    true,
  );
  assert.equal(
    isSizeChartValues("wheel", { diameter: 100.1, width: 100, contactWidth: 100 }),
    false,
  );
  for (const category of [
    "Deck",
    "Complete",
    "Top",
    "Bottom",
    "Outerwear",
    "Shoes",
    "Accessories",
    "Wheels",
    "Trucks",
    "Bearings",
    "Hardware",
    "Protection",
    "Other",
    "__proto__",
  ])
    assert.deepEqual(
      [...sizeChartKindsFor(category)],
      [...client.sizeChartKindsFor(category)],
      category,
    );
});
