import assert from "node:assert/strict";
import test from "node:test";
import {
  findCatalogDuplicateIds,
  normalizeCatalogIdentityText,
  parseCatalogIntakeRequest,
} from "../lambda/catalog-intake.js";

const existing = {
  action: "ocr-intake",
  operationId: "operation_123",
  kind: "existing",
  quantity: 2,
  source: { jobId: "ocr_job", rowIds: ["row_A"] },
  existing: { productId: "prd_deck", version: 3 },
};
const create = {
  action: "ocr-intake",
  operationId: "operation_123",
  kind: "new",
  quantity: 2,
  source: { jobId: "ocr_job", rowIds: ["row_A"] },
  product: {
    name: "Deck",
    brandName: "Brand",
    option: "8.25",
    price: 0,
    category: "Deck",
  },
};

test("strict existing and draft intake inputs accept exact boundaries", () => {
  assert.deepEqual(parseCatalogIntakeRequest(existing), existing);
  assert.deepEqual(parseCatalogIntakeRequest(create), create);
  assert.ok(
    parseCatalogIntakeRequest({
      ...create,
      quantity: 1_000_000,
      product: { ...create.product, price: 100_000_000, option: "" },
    }),
  );
});
test("intake rejects quantity coercion, invalid numbers, extra fields and reserved IDs", () => {
  for (const quantity of [0, -1, 1.5, 1_000_001, NaN, Infinity, "2"])
    assert.equal(parseCatalogIntakeRequest({ ...existing, quantity }), null);
  for (const patch of [
    { stock: 2 },
    { createdBy: "forged" },
    { action: "other" },
    { operationId: "x" },
    { kind: "replace" },
    { existing: { ...existing.existing, productId: "~catalog_revision" } },
    { existing: { ...existing.existing, version: Number.MAX_SAFE_INTEGER } },
    { existing: { ...existing.existing, extra: 1 } },
  ])
    assert.equal(parseCatalogIntakeRequest({ ...existing, ...patch }), null);
  assert.equal(parseCatalogIntakeRequest([]), null);
});
test("new intake requires bounded name, brand, explicit option, price and allowed category", () => {
  for (const patch of [
    { name: "" },
    { name: "n".repeat(161) },
    { brandName: "b".repeat(101) },
    { option: "x".repeat(51) },
    { option: null },
    { price: undefined },
    { price: "0" },
    { price: -1 },
    { price: NaN },
    { price: Infinity },
    { price: 0.5 },
    { price: 100_000_001 },
    { category: "Unknown" },
    { status: "PUBLISHED" },
    { sku: "" },
    { sku: "s".repeat(81) },
    { name: "x\0y" },
  ])
    assert.equal(
      parseCatalogIntakeRequest({
        ...create,
        product: { ...create.product, ...patch },
      }),
      null,
    );
  assert.ok(
    parseCatalogIntakeRequest({
      ...create,
      product: { ...create.product, sku: " SKU-A " },
    }),
  );
});
test("name comparison composes Korean, collapses whitespace and folds case without removing punctuation/spaces", () => {
  assert.equal(
    normalizeCatalogIdentityText("  한글\u3000 DECK\t BOARD "),
    "한글 deck board",
  );
  assert.equal(normalizeCatalogIdentityText("한글"), "한글");
  assert.notEqual(
    normalizeCatalogIdentityText("Deck Board"),
    normalizeCatalogIdentityText("DeckBoard"),
  );
  assert.notEqual(
    normalizeCatalogIdentityText("Ａ"),
    normalizeCatalogIdentityText("A"),
  );
});
test("exact SKU wins over different text, remains case sensitive, and ignores self on edit", () => {
  const product = {
    productId: "prd_old",
    name: "Other",
    brandName: "Other",
    sku: " ABC ",
    sizes: ["M"],
  };
  assert.deepEqual(
    findCatalogDuplicateIds({ name: "New", brandName: "New", sku: "ABC", sizes: [] }, [
      product,
    ]),
    ["prd_old"],
  );
  assert.deepEqual(
    findCatalogDuplicateIds({ name: "New", brandName: "New", sku: "abc", sizes: [] }, [
      product,
    ]),
    [],
  );
  assert.deepEqual(findCatalogDuplicateIds(product, [product], "prd_old"), []);
});
test("composite identity detects any overlapping option and blocks empty-option ambiguity", () => {
  const product = {
    productId: "prd_old",
    name: " Deck  Board ",
    brandName: "BRAND",
    sizes: ["S", " M "],
  };
  assert.deepEqual(
    findCatalogDuplicateIds({ name: "deck board", brandName: "brand", sizes: ["m"] }, [
      product,
    ]),
    ["prd_old"],
  );
  assert.deepEqual(
    findCatalogDuplicateIds({ name: "deck board", brandName: "brand", sizes: [] }, [
      product,
    ]),
    ["prd_old"],
  );
  assert.deepEqual(
    findCatalogDuplicateIds({ name: "deck board", brandName: "brand", sizes: ["XL"] }, [
      product,
    ]),
    [],
  );
  assert.deepEqual(
    findCatalogDuplicateIds({ name: "deck board", brandName: "brand", sizes: ["XL"] }, [
      { ...product, sizes: [] },
    ]),
    ["prd_old"],
  );
});

test("source identities are required, bounded, unique and canonically sorted", () => {
  const sorted = parseCatalogIntakeRequest({
    ...existing,
    source: { jobId: "ocr_job", rowIds: ["b", "a"] },
  });
  assert.deepEqual(sorted?.source, { jobId: "ocr_job", rowIds: ["a", "b"] });
  const maximum = Array.from({ length: 96 }, (_, index) => `row_${index}`);
  assert.ok(
    parseCatalogIntakeRequest({
      ...existing,
      source: { jobId: "x".repeat(128), rowIds: maximum },
    }),
  );
  for (const source of [
    undefined,
    null,
    {},
    { jobId: "ocr_job", rowIds: [] },
    { jobId: "ocr_job", rowIds: [...maximum, "row_97"] },
    { jobId: "ocr_job", rowIds: ["a", "a"] },
    { jobId: "ocr_job", rowIds: ["a/b"] },
    { jobId: "ocr_job", rowIds: ["x".repeat(129)] },
    { jobId: "x".repeat(129), rowIds: ["a"] },
    { jobId: "ocr_job", rowIds: ["a"], private: true },
  ]) {
    assert.equal(parseCatalogIntakeRequest({ ...existing, source }), null);
  }
});
