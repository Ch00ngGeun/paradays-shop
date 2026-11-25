/** 역할: 관리자 상품 생성·수정 요청 body를 허용 필드만 읽어 검증하고, 기존 상품과 PATCH 값을 병합함. */
import { isRecord, readBoundedString } from "./request-helpers.js";
import { allowedSizeChartKind, defaultSizeChartKind } from "./size-chart-rules.js";
import { type CatalogProductRecord } from "./admin-catalog-handler.js";
import {
  readReferenceId,
  createBrandReferenceId,
  normalizeSlug,
  readCatalogCategory,
  readProductStatus,
  readKrwAmount,
  readOptionalAmount,
  readInventoryQuantity,
  readBooleanAlias,
  readOptionalText,
  readOptionalImage,
  readImageList,
  readTextList,
  readNameI18n,
  readDescriptionI18n,
  hasOwn,
} from "./admin-catalog-values.js";
import {
  readDeckSpec,
  readDeckSpecsBySize,
  readSizeChart,
  readSizeChartsBySize,
  sizeChartOutput,
} from "./admin-catalog-size-options.js";

type ProductInput = Omit<
  CatalogProductRecord,
  "productId" | "version" | "createdAt" | "updatedAt" | "createdBy" | "updatedBy"
>;

/** POST와 patch merge 이후 같은 형식으로 상품 입력값을 검증·정규화합니다. */
export function parseProductInput(body: unknown): ProductInput | null {
  if (!isRecord(body)) {
    return null;
  }

  const name = readBoundedString(body.name, 160);
  const brandName = readBoundedString(
    "brandName" in body ? body.brandName : body.brand,
    100,
  );
  const category = readCatalogCategory(body.category);
  const price = readKrwAmount(body.price);

  if (!name || !brandName || !category || price === undefined) {
    return null;
  }

  const brandId =
    readReferenceId(body.brandId, 100) ?? createBrandReferenceId(brandName);
  const suppliedSlug = "slug" in body ? readBoundedString(body.slug, 180) : undefined;
  const slug = normalizeSlug(suppliedSlug ?? name);

  if (!slug) {
    return null;
  }

  const sku = readOptionalText(body, "sku", 80);

  if (sku === null) {
    return null;
  }

  const compareAtPrice = readOptionalAmount(body, "compareAtPrice");

  if (
    compareAtPrice === null ||
    (compareAtPrice !== undefined && compareAtPrice <= price)
  ) {
    return null;
  }

  const inventoryQuantity = readInventoryQuantity(
    "inventoryQuantity" in body ? body.inventoryQuantity : body.stock,
  );

  if (inventoryQuantity === undefined) {
    return null;
  }

  const status = readProductStatus(body);

  if (!status) {
    return null;
  }

  const featured = readBooleanAlias(body, ["featured", "isFeatured"], false);

  if (featured === undefined) {
    return null;
  }

  const image = readOptionalImage(body, ["image", "imageUrl"]);

  if (image === null) {
    return null;
  }

  const images = readImageList(body.images, image);
  const description = readTextList(body.description, 20, 300, "newline");
  const sizes = readTextList(body.sizes, 20, 50, "comma");
  const nameI18n = readNameI18n(body.nameI18n);
  const descriptionI18n = readDescriptionI18n(body.descriptionI18n);
  const deckSpec = readDeckSpec(body.deckSpec);
  const deckSpecsBySize = sizes && readDeckSpecsBySize(body.deckSpecsBySize, sizes);
  const sizeChart = readSizeChart(body.sizeChart, category);
  // 기본값이 있으면 그 도면 종류로 고정하고, 없으면 kind PATCH나 옵션 저장에서 고른 종류를 씀.
  const sizeChartKind =
    sizeChart?.kind ?? allowedSizeChartKind(category, body.sizeChartKind);
  const sizeChartsBySize =
    sizes &&
    readSizeChartsBySize(
      body.sizeChartsBySize,
      sizes,
      sizeChartKind ?? defaultSizeChartKind(category),
    );

  if (
    !images ||
    !description ||
    !sizes ||
    nameI18n === null ||
    descriptionI18n === null ||
    deckSpec === null ||
    deckSpecsBySize === null ||
    sizeChart === null
  ) {
    return null;
  }

  if (status === "PUBLISHED" && (!image || sizes.length === 0)) {
    return null;
  }

  return {
    slug,
    name,
    ...(nameI18n ? { nameI18n } : {}),
    ...(sku ? { sku } : {}),
    brandId,
    brandName,
    category,
    price,
    ...(compareAtPrice ? { compareAtPrice } : {}),
    currency: "KRW",
    status,
    publicationStatus: status,
    inventoryQuantity,
    featured,
    ...(image ? { image } : {}),
    images,
    description,
    ...(descriptionI18n ? { descriptionI18n } : {}),
    sizes,
    ...(deckSpec ? { deckSpec } : {}),
    ...(deckSpecsBySize ? { deckSpecsBySize } : {}),
    ...(sizeChart ? { sizeChart } : {}),
    ...(sizeChartKind ? { sizeChartKind } : {}),
    ...(sizeChartsBySize ? { sizeChartsBySize } : {}),
  };
}

/** patch에 포함된 allowlist 필드만 현재 product 위에 덮어써 원본 audit 속성을 신뢰하지 않습니다. */
export function mergeProductPatch(
  product: CatalogProductRecord,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {
    name: product.name,
    ...(product.nameI18n ? { nameI18n: { ...product.nameI18n } } : {}),
    slug: product.slug,
    sku: product.sku ?? null,
    brandId: product.brandId,
    brandName: product.brandName,
    category: product.category,
    price: product.price,
    compareAtPrice: product.compareAtPrice ?? null,
    inventoryQuantity: product.inventoryQuantity,
    status: product.status,
    featured: product.featured,
    image: product.image ?? null,
    images: [...product.images],
    description: [...product.description],
    ...(product.descriptionI18n
      ? {
          descriptionI18n: {
            en: [...product.descriptionI18n.en],
            ko: [...product.descriptionI18n.ko],
          },
        }
      : {}),
    sizes: [...product.sizes],
    ...(product.deckSpec ? { deckSpec: { ...product.deckSpec } } : {}),
    ...(product.deckSpecsBySize
      ? { deckSpecsBySize: { ...product.deckSpecsBySize } }
      : {}),
    ...sizeChartOutput(product),
  };

  const directFields = [
    "name",
    "nameI18n",
    "slug",
    "sku",
    "brandId",
    "brandName",
    "category",
    "price",
    "compareAtPrice",
    "inventoryQuantity",
    "status",
    "featured",
    "image",
    "images",
    "description",
    "descriptionI18n",
    "sizes",
    "deckSpec",
    "sizeChart",
  ];

  for (const field of directFields) {
    if (hasOwn(patch, field)) {
      merged[field] = patch[field];
    }
  }

  if (hasOwn(patch, "brand") && !hasOwn(patch, "brandName")) {
    merged.brandName = patch.brand;
  }

  if (hasOwn(patch, "stock") && !hasOwn(patch, "inventoryQuantity")) {
    merged.inventoryQuantity = patch.stock;
  }

  if (hasOwn(patch, "imageUrl") && !hasOwn(patch, "image")) {
    merged.image = patch.imageUrl;
  }

  if (hasOwn(patch, "isVisible") && !hasOwn(patch, "status")) {
    merged.isVisible = patch.isVisible;
  }

  if (hasOwn(patch, "isFeatured") && !hasOwn(patch, "featured")) {
    merged.isFeatured = patch.isFeatured;
  }

  return merged;
}
