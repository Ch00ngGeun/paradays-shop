/** Strict OCR intake inputs and conservative, exact catalog identity comparison. */
export const INTAKE_CATEGORIES = [
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
] as const;

export type IntakeCategory = (typeof INTAKE_CATEGORIES)[number];
export type CatalogIntakeRequest = Readonly<{
  action: "ocr-intake";
  operationId: string;
  quantity: number;
  source: Readonly<{ jobId: string; rowIds: readonly string[] }>;
}> &
  (
    | Readonly<{
        kind: "existing";
        existing: Readonly<{ productId: string; version: number }>;
      }>
    | Readonly<{
        kind: "new";
        product: Readonly<{
          name: string;
          brandName: string;
          option: string;
          sku?: string;
          price: number;
          category: IntakeCategory;
        }>;
      }>
  );

export type CatalogIdentity = Readonly<{
  productId?: string;
  name: string;
  brandName: string;
  sku?: string;
  sizes: readonly string[];
}>;

const PRODUCT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,96}$/;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/;
const SOURCE_JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/;
const SOURCE_ROW_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Only declared fields are accepted; audit values, absolute stock and publish flags are forbidden. */
export function parseCatalogIntakeRequest(value: unknown): CatalogIntakeRequest | null {
  if (
    !record(value) ||
    !keys(value, [
      "action",
      "operationId",
      "kind",
      "quantity",
      "source",
      value.kind === "existing" ? "existing" : "product",
    ])
  )
    return null;
  if (
    value.action !== "ocr-intake" ||
    typeof value.operationId !== "string" ||
    !OPERATION_ID.test(value.operationId) ||
    !integer(value.quantity, 1, 1_000_000)
  )
    return null;
  if (
    !record(value.source) ||
    !keys(value.source, ["jobId", "rowIds"]) ||
    typeof value.source.jobId !== "string" ||
    !SOURCE_JOB_ID.test(value.source.jobId) ||
    !Array.isArray(value.source.rowIds) ||
    value.source.rowIds.length < 1 ||
    value.source.rowIds.length > 96 ||
    !value.source.rowIds.every(
      (rowId) => typeof rowId === "string" && SOURCE_ROW_ID.test(rowId),
    ) ||
    new Set(value.source.rowIds).size !== value.source.rowIds.length
  )
    return null;
  const source = {
    jobId: value.source.jobId,
    rowIds: [...value.source.rowIds].sort() as string[],
  };
  if (value.kind === "existing") {
    const existing = value.existing;
    if (
      !record(existing) ||
      !keys(existing, ["productId", "version"]) ||
      typeof existing.productId !== "string" ||
      !PRODUCT_ID.test(existing.productId) ||
      !integer(existing.version, 1, Number.MAX_SAFE_INTEGER - 1)
    )
      return null;
    return {
      action: "ocr-intake",
      operationId: value.operationId,
      kind: "existing",
      quantity: value.quantity,
      source,
      existing: { productId: existing.productId, version: existing.version },
    };
  }
  if (value.kind !== "new" || !record(value.product)) return null;
  const product = value.product;
  if (!keys(product, ["name", "brandName", "option", "price", "category"], ["sku"]))
    return null;
  const name = text(product.name, 160);
  const brandName = text(product.brandName, 100);
  const option = text(product.option, 50, true);
  const sku = "sku" in product ? text(product.sku, 80) : undefined;
  if (
    !name ||
    !brandName ||
    option === null ||
    ("sku" in product && !sku) ||
    !integer(product.price, 0, 100_000_000) ||
    typeof product.category !== "string" ||
    !(INTAKE_CATEGORIES as readonly string[]).includes(product.category)
  )
    return null;
  return {
    action: "ocr-intake",
    operationId: value.operationId,
    kind: "new",
    quantity: value.quantity,
    source,
    product: {
      name,
      brandName,
      option,
      ...(sku ? { sku } : {}),
      price: product.price,
      category: product.category as IntakeCategory,
    },
  };
}

/** NFC only: whitespace runs collapse, case folds, internal spaces and punctuation remain significant. */
export function normalizeCatalogIdentityText(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/gu, " ").toLowerCase();
}

/** SKU is an identifier: NFC and edge trimming only, with case-sensitive exact equality. */
export function normalizeCatalogSku(value: string): string {
  return value.normalize("NFC").trim();
}

/** Empty options are ambiguous, never evidence that a same-name/brand product is definitely new. */
export function findCatalogDuplicateIds(
  incoming: CatalogIdentity,
  products: readonly CatalogIdentity[],
  excludedProductId?: string,
): readonly string[] {
  const name = normalizeCatalogIdentityText(incoming.name);
  const brand = normalizeCatalogIdentityText(incoming.brandName);
  const options = incoming.sizes.map(normalizeCatalogIdentityText).filter(Boolean);
  const sku = incoming.sku ? normalizeCatalogSku(incoming.sku) : "";
  return products
    .filter((product) => {
      if (!product.productId || product.productId === excludedProductId) return false;
      if (sku && product.sku && sku === normalizeCatalogSku(product.sku)) return true;
      if (
        name !== normalizeCatalogIdentityText(product.name) ||
        brand !== normalizeCatalogIdentityText(product.brandName)
      )
        return false;
      const otherOptions = product.sizes
        .map(normalizeCatalogIdentityText)
        .filter(Boolean);
      return (
        options.length === 0 ||
        otherOptions.length === 0 ||
        options.some((option) => otherOptions.includes(option))
      );
    })
    .map((product) => product.productId!);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function keys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
  );
}
function integer(value: unknown, minimum: number, maximum: number): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}
function text(value: unknown, maximum: number, empty = false): string | null {
  if (typeof value !== "string" || value.includes("\0")) return null;
  const normalized = value.normalize("NFC").trim();
  return normalized.length <= maximum && (empty || normalized.length > 0)
    ? normalized
    : null;
}
