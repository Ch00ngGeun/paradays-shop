/**
 * 역할: 관리자만 상품 초안·공개 상품을 저장하고 관리하게 함.
 * 기능: 허용된 카탈로그 필드만 DynamoDB에 기록하고, 버전 조건식으로 동시 편집 덮어쓰기를 막음.
 */

import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { authorizeAdmin } from "./admin-auth.js";
import { getRequiredEnvironment } from "./dynamodb-client.js";
import { jsonResponse } from "./http-response.js";
import { isRecord } from "./request-helpers.js";
import {
  type CatalogSizeChart,
  type SizeChartKind,
  type SizeChartValues,
} from "./size-chart-rules.js";
import {
  type CatalogCategory,
  readProductId,
  isCatalogCategory,
  isCatalogProductStatus,
  isKrwAmount,
  isInventoryQuantity,
  isCatalogNameI18n,
  isCatalogDescriptionI18n,
  isStringArray,
} from "./admin-catalog-values.js";
import {
  listProducts,
  createProduct,
  getProduct,
  updateProduct,
  deleteProduct,
} from "./admin-catalog-products.js";
import {
  sizeChartOutput,
  deckSpecsBySizeOutput,
  isCatalogDeckSpec,
} from "./admin-catalog-size-options.js";

/** 옵션별 의류·휠 상세사이즈 값. 키는 sizes 값이고, 도면 종류는 상품의 sizeChartKind를 따릅니다. */
export type CatalogSizeChartsBySize = Readonly<Record<string, SizeChartValues>>;

/** 상품 상태는 공개 여부를 가리키는 두 값으로 고정합니다. */
export type CatalogProductStatus = "DRAFT" | "PUBLISHED";

/** 로케일별 상품명 쌍 (등록 시 클라이언트 자동 번역으로 채움). */
export type CatalogNameI18n = Readonly<{ en: string; ko: string }>;

/** 로케일별 스펙 줄 쌍. */
export type CatalogDescriptionI18n = Readonly<{
  en: readonly string[];
  ko: readonly string[];
}>;

/** 데크 상세사이즈(인치). 관리자 상세사이즈 모달이 PATCH로 단독 저장합니다. */
export type CatalogDeckSpec = Readonly<{
  nose: number | null;
  tail: number | null;
  width: number | null;
  length: number | null;
  wheelbase: number | null;
}>;

export type CatalogDeckSpecsBySize = Readonly<Record<string, CatalogDeckSpec>>;

/** DynamoDB catalog table에 저장하는 정규화된 상품 행입니다. */
export type CatalogProductRecord = Readonly<{
  productId: string;
  slug: string;
  name: string;
  nameI18n?: CatalogNameI18n;
  sku?: string;
  brandId: string;
  brandName: string;
  category: CatalogCategory;
  price: number;
  compareAtPrice?: number;
  currency: "KRW";
  status: CatalogProductStatus;
  /** 공개 상품 GSI가 사용할 고정 partition 값. status와 같은 값만 저장합니다. */
  publicationStatus: CatalogProductStatus;
  inventoryQuantity: number;
  /** 서버만 관리하는 예약 수량임. 값이 없는 기존 레코드는 0으로 보고, 관리자 요청 body에서는 받지 않음. */
  inventoryReserved?: number;
  /** 증명된 미반납 판매 수량이며, 실물 복원 전까지 상품 식별 정보를 유지하게 함. */
  inventoryCommitted?: number;
  featured: boolean;
  image?: string;
  images: readonly string[];
  description: readonly string[];
  descriptionI18n?: CatalogDescriptionI18n;
  sizes: readonly string[];
  deckSpec?: CatalogDeckSpec;
  /** 사이즈 옵션별 상세사이즈. 키는 sizes 값이며, 없는 옵션은 deckSpec(기본값)을 씁니다. */
  deckSpecsBySize?: CatalogDeckSpecsBySize;
  /** 데크 외(의류·휠) 상세사이즈 기본값. kind는 카테고리에서 고를 수 있는 도면 종류입니다. */
  sizeChart?: CatalogSizeChart;
  /** 고른 도면 종류. 기본값이 없어도 옵션별 값이 이 종류의 항목을 따릅니다. */
  sizeChartKind?: SizeChartKind;
  sizeChartsBySize?: CatalogSizeChartsBySize;
  version: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
}>;

/** 스토어프론트가 공개 상품에만 쓸 수 있는 민감하지 않은 공통 상품 shape입니다. */
export type PublicCatalogProduct = Readonly<{
  id: string;
  slug: string;
  name: string;
  nameI18n?: CatalogNameI18n;
  category: CatalogCategory;
  brand: string;
  price: number;
  compareAtPrice?: number;
  image: string;
  images?: string[];
  description: string[];
  descriptionI18n?: CatalogDescriptionI18n;
  sizes: string[];
  /** soldout 정렬·표시용. SKU·원가 등 민감 값은 포함하지 않음 */
  inventoryQuantity: number;
  /** 신상품 New 배지 */
  featured: boolean;
  deckSpec?: CatalogDeckSpec;
  deckSpecsBySize?: CatalogDeckSpecsBySize;
  sizeChart?: CatalogSizeChart;
  sizeChartKind?: SizeChartKind;
  sizeChartsBySize?: CatalogSizeChartsBySize;
}>;

/** 관리자 UI에 반환하는 allowlist 기반 상품 shape입니다. audit subject 등 저장 원본은 제외합니다. */
export type AdminCatalogProduct = Readonly<{
  productId: string;
  slug: string;
  name: string;
  nameI18n?: CatalogNameI18n;
  sku?: string;
  brandId: string;
  brandName: string;
  category: CatalogCategory;
  price: number;
  compareAtPrice?: number;
  currency: "KRW";
  status: CatalogProductStatus;
  inventoryQuantity: number;
  featured: boolean;
  image?: string;
  images: readonly string[];
  description: readonly string[];
  descriptionI18n?: CatalogDescriptionI18n;
  sizes: readonly string[];
  deckSpec?: CatalogDeckSpec;
  deckSpecsBySize?: CatalogDeckSpecsBySize;
  sizeChart?: CatalogSizeChart;
  sizeChartKind?: SizeChartKind;
  sizeChartsBySize?: CatalogSizeChartsBySize;
  version: number;
  createdAt: string;
  updatedAt: string;
}>;

type CatalogRoute =
  | Readonly<{ kind: "collection" }>
  | Readonly<{ kind: "item"; productId: string }>;

/** /admin/catalog/products CRUD를 route·method별로 처리합니다. API Gateway JWT 외에 admin group도 반드시 확인합니다. */
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> {
  const authorization = await authorizeAdmin(event);

  if (!authorization.ok) {
    return jsonResponse(authorization.statusCode, { code: authorization.code });
  }

  const route = resolveCatalogRoute(event);

  if (!route) {
    return jsonResponse(404, { code: "ADMIN_CATALOG_ROUTE_NOT_FOUND" });
  }

  let catalogTableName: string;

  try {
    catalogTableName = getRequiredEnvironment("CATALOG_TABLE_NAME");
  } catch {
    return jsonResponse(503, { code: "CATALOG_CONFIGURATION_UNAVAILABLE" });
  }

  const method = event.requestContext.http.method;

  if (route.kind === "collection") {
    if (method === "GET") {
      return listProducts(catalogTableName, event);
    }

    if (method === "POST") {
      return createProduct(catalogTableName, event, authorization.userSub);
    }

    return jsonResponse(405, { code: "METHOD_NOT_ALLOWED" });
  }

  if (method === "GET") {
    return getProduct(catalogTableName, route.productId);
  }

  if (method === "PATCH") {
    return updateProduct(
      catalogTableName,
      route.productId,
      event,
      authorization.userSub,
    );
  }

  if (method === "DELETE") {
    return deleteProduct(catalogTableName, route.productId, event);
  }

  return jsonResponse(405, { code: "METHOD_NOT_ALLOWED" });
}

/** DynamoDB storage item이 현재 catalog schema의 필수 타입을 갖는지 엄격하게 좁힙니다. */
export function isCatalogProductRecord(value: unknown): value is CatalogProductRecord {
  return (
    isRecord(value) &&
    typeof value.productId === "string" &&
    typeof value.slug === "string" &&
    typeof value.name === "string" &&
    (value.nameI18n === undefined || isCatalogNameI18n(value.nameI18n)) &&
    (value.sku === undefined || typeof value.sku === "string") &&
    typeof value.brandId === "string" &&
    typeof value.brandName === "string" &&
    isCatalogCategory(value.category) &&
    isKrwAmount(value.price) &&
    (value.compareAtPrice === undefined || isKrwAmount(value.compareAtPrice)) &&
    value.currency === "KRW" &&
    isCatalogProductStatus(value.status) &&
    value.publicationStatus === value.status &&
    isInventoryQuantity(value.inventoryQuantity) &&
    (value.inventoryReserved === undefined ||
      (isInventoryQuantity(value.inventoryReserved) &&
        value.inventoryReserved <= value.inventoryQuantity)) &&
    (value.inventoryCommitted === undefined ||
      (typeof value.inventoryCommitted === "number" &&
        Number.isSafeInteger(value.inventoryCommitted) &&
        value.inventoryCommitted >= 0)) &&
    typeof value.featured === "boolean" &&
    (value.image === undefined || typeof value.image === "string") &&
    isStringArray(value.images) &&
    isStringArray(value.description) &&
    (value.descriptionI18n === undefined ||
      isCatalogDescriptionI18n(value.descriptionI18n)) &&
    isStringArray(value.sizes) &&
    (value.deckSpec === undefined || isCatalogDeckSpec(value.deckSpec)) &&
    (value.deckSpecsBySize === undefined ||
      (isRecord(value.deckSpecsBySize) &&
        Object.values(value.deckSpecsBySize).every(isCatalogDeckSpec))) &&
    typeof value.version === "number" &&
    Number.isSafeInteger(value.version) &&
    value.version > 0 &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    typeof value.createdBy === "string" &&
    typeof value.updatedBy === "string"
  );
}

/** 공개된 상품만 storefront contract로 변환합니다. 초안은 null로 숨겨 caller 실수를 줄입니다. */
export function toPublicCatalogProduct(
  product: CatalogProductRecord,
): PublicCatalogProduct | null {
  if (product.status !== "PUBLISHED" || !product.image) {
    return null;
  }

  return {
    id: product.productId,
    slug: product.slug,
    name: product.name,
    ...(product.nameI18n ? { nameI18n: { ...product.nameI18n } } : {}),
    category: product.category,
    brand: product.brandName,
    price: product.price,
    ...(product.compareAtPrice ? { compareAtPrice: product.compareAtPrice } : {}),
    image: product.image,
    ...(product.images.length > 1 ? { images: [...product.images] } : {}),
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
    inventoryQuantity: product.inventoryQuantity - (product.inventoryReserved ?? 0),
    featured: product.featured,
    ...(product.deckSpec ? { deckSpec: { ...product.deckSpec } } : {}),
    ...deckSpecsBySizeOutput(product),
    ...sizeChartOutput(product),
  };
}

/** 관리자 응답은 변경에 필요한 필드만 선택하며 audit subject 등 raw Dynamo 속성은 노출하지 않습니다. */
export function toAdminCatalogProduct(
  product: CatalogProductRecord,
): AdminCatalogProduct {
  return {
    productId: product.productId,
    slug: product.slug,
    name: product.name,
    ...(product.nameI18n ? { nameI18n: { ...product.nameI18n } } : {}),
    ...(product.sku ? { sku: product.sku } : {}),
    brandId: product.brandId,
    brandName: product.brandName,
    category: product.category,
    price: product.price,
    ...(product.compareAtPrice ? { compareAtPrice: product.compareAtPrice } : {}),
    currency: product.currency,
    status: product.status,
    inventoryQuantity: product.inventoryQuantity,
    featured: product.featured,
    ...(product.image ? { image: product.image } : {}),
    images: product.images,
    description: product.description,
    ...(product.descriptionI18n
      ? {
          descriptionI18n: {
            en: [...product.descriptionI18n.en],
            ko: [...product.descriptionI18n.ko],
          },
        }
      : {}),
    sizes: product.sizes,
    ...(product.deckSpec ? { deckSpec: { ...product.deckSpec } } : {}),
    ...deckSpecsBySizeOutput(product),
    ...sizeChartOutput(product),
    version: product.version,
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
  };
}

/** rawPath를 우선으로 사용해 잘못 연결된 Lambda route가 다른 데이터를 조작하지 않게 합니다. */
function resolveCatalogRoute(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): CatalogRoute | null {
  const rawPath = event.rawPath.replace(/\/+$/, "") || "/";
  const match = rawPath.match(/^\/admin\/(?:catalog\/)?products(?:\/([^/]+))?$/);

  if (!match) {
    return null;
  }

  const encodedProductId = event.pathParameters?.productId ?? match[1];

  if (!encodedProductId) {
    return { kind: "collection" };
  }

  let productId: string;

  try {
    productId = decodeURIComponent(encodedProductId);
  } catch {
    return null;
  }

  return readProductId(productId) ? { kind: "item", productId } : null;
}
