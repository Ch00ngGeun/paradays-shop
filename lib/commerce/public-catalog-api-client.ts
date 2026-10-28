// 역할: 정적 스토어프론트가 배포된 관리자 카탈로그의 발행 상품만 읽도록 하는 공개 API 어댑터입니다.
import type { DeckSpec, Product } from "@/types/store";

/** public catalog API가 없거나 실패했을 때 정적 초기 카탈로그를 유지하게 하는 오류입니다. */
export class PublicCatalogApiError extends Error {
  constructor(readonly status: number | null = null) {
    super("PUBLIC_CATALOG_API_ERROR");
    this.name = "PublicCatalogApiError";
  }
}

/** `NEXT_PUBLIC_` API base URL은 공개 상품 조회에만 쓰며, 실패해도 빈 화면으로 바꾸지 않습니다. */
export function readPublicCatalogApiBaseUrl(): string | null {
  const rawValue = process.env.NEXT_PUBLIC_COMMERCE_API_BASE_URL?.trim();

  if (!rawValue) {
    return null;
  }

  try {
    const url = new URL(rawValue);

    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return null;
    }

    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/** API가 구성된 경우에만 발행 상품 목록을 읽고, 미구성 상태는 null로 구분합니다. */
export async function listPublishedCatalogProducts(
  fetchImplementation: typeof fetch = fetch,
): Promise<Product[] | null> {
  const apiBaseUrl = readPublicCatalogApiBaseUrl();

  if (!apiBaseUrl) {
    return null;
  }

  const response = await fetchImplementation(buildCatalogUrl(apiBaseUrl), {
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    throw new PublicCatalogApiError(response.status);
  }

  let body: unknown;

  try {
    body = await response.json();
  } catch {
    throw new PublicCatalogApiError(response.status);
  }

  if (!isRecord(body) || !Array.isArray(body.products)) {
    throw new PublicCatalogApiError(response.status);
  }

  return body.products.map(parseProduct);
}

/** 정적 상세 페이지 밖에서 발행된 상품을 한 건만 읽습니다. */
export async function getPublishedCatalogProduct(
  slug: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<Product | null> {
  const normalizedSlug = slug.trim();
  const apiBaseUrl = readPublicCatalogApiBaseUrl();

  if (!apiBaseUrl || !normalizedSlug || normalizedSlug.length > 120) {
    return null;
  }

  const response = await fetchImplementation(
    buildCatalogUrl(apiBaseUrl, { slug: normalizedSlug }),
    { headers: { Accept: "application/json" } },
  );

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new PublicCatalogApiError(response.status);
  }

  let body: unknown;

  try {
    body = await response.json();
  } catch {
    throw new PublicCatalogApiError(response.status);
  }

  if (!isRecord(body) || !isRecord(body.product)) {
    throw new PublicCatalogApiError(response.status);
  }

  return parseProduct(body.product);
}

/** API Gateway base path를 유지하며 slug는 query parameter로 안전하게 조합합니다. */
function buildCatalogUrl(apiBaseUrl: string, query?: Readonly<{ slug: string }>) {
  const url = new URL("catalog/products", `${apiBaseUrl}/`);

  if (query?.slug) {
    url.searchParams.set("slug", query.slug);
  }

  return url.toString();
}

/** 서버가 공개 계약으로 반환한 상품만 UI Product로 좁힙니다. */
function parseProduct(value: unknown): Product {
  if (
    !isRecord(value) ||
    !isSafeText(value.id, 80) ||
    !isSafeSlug(value.slug) ||
    !isSafeText(value.name, 160) ||
    !isSafeText(value.category, 80) ||
    !isSafeText(value.brand, 100) ||
    !isSafeMoney(value.price) ||
    !isSafeImageReference(value.image) ||
    !Array.isArray(value.description) ||
    !value.description.every((item) => isSafeText(item, 500)) ||
    !Array.isArray(value.sizes) ||
    !value.sizes.every((item) => isSafeText(item, 80)) ||
    (value.compareAtPrice !== undefined && !isSafeMoney(value.compareAtPrice)) ||
    (value.images !== undefined &&
      (!Array.isArray(value.images) ||
        !value.images.every((item) => isSafeImageReference(item)))) ||
    (value.inventoryQuantity !== undefined &&
      !isSafeInventoryQuantity(value.inventoryQuantity)) ||
    (value.featured !== undefined && typeof value.featured !== "boolean")
  ) {
    throw new PublicCatalogApiError();
  }

  const nameI18n = parseNameI18n(value.nameI18n);
  const descriptionI18n = parseDescriptionI18n(value.descriptionI18n);
  const deckSpec = parseDeckSpec(value.deckSpec);

  return {
    id: value.id,
    slug: value.slug,
    name: value.name,
    ...(nameI18n ? { nameI18n } : {}),
    category: value.category,
    brand: value.brand,
    price: value.price,
    ...(typeof value.compareAtPrice === "number"
      ? { compareAtPrice: value.compareAtPrice }
      : {}),
    image: value.image,
    ...(Array.isArray(value.images) ? { images: value.images } : {}),
    description: value.description,
    ...(descriptionI18n ? { descriptionI18n } : {}),
    sizes: value.sizes,
    ...(typeof value.inventoryQuantity === "number"
      ? { inventoryQuantity: value.inventoryQuantity }
      : {}),
    ...(typeof value.featured === "boolean" ? { featured: value.featured } : {}),
    ...(deckSpec ? { deckSpec } : {}),
  };
}

const DECK_SPEC_FIELDS = ["nose", "tail", "width", "length", "wheelbase"] as const;

/** 상세사이즈는 부가 정보라 형식이 어긋나면 상품 전체를 버리지 않고 이 필드만 숨깁니다. */
function parseDeckSpec(value: unknown): DeckSpec | undefined {
  if (
    !isRecord(value) ||
    !DECK_SPEC_FIELDS.every((field) => isSafeInches(value[field]))
  ) {
    return undefined;
  }

  return {
    nose: value.nose as number,
    tail: value.tail as number,
    width: value.width as number,
    length: value.length as number,
    wheelbase: value.wheelbase as number,
  };
}

function isSafeInches(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 100
  );
}

function parseNameI18n(
  value: unknown,
): Readonly<{ en: string; ko: string }> | undefined {
  if (!isRecord(value) || !isSafeText(value.en, 160) || !isSafeText(value.ko, 160)) {
    return undefined;
  }

  return { en: value.en, ko: value.ko };
}

function parseDescriptionI18n(
  value: unknown,
): Readonly<{ en: string[]; ko: string[] }> | undefined {
  if (
    !isRecord(value) ||
    !Array.isArray(value.en) ||
    !Array.isArray(value.ko) ||
    !value.en.every((item) => isSafeText(item, 500)) ||
    !value.ko.every((item) => isSafeText(item, 500))
  ) {
    return undefined;
  }

  return { en: value.en, ko: value.ko };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSafeText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" && Boolean(value.trim()) && value.length <= maxLength
  );
}

function isSafeSlug(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-z0-9가-힣]+(?:-[a-z0-9가-힣]+)*$/.test(value) &&
    value.length <= 180
  );
}

function isSafeMoney(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 100_000_000
  );
}

function isSafeInventoryQuantity(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 1_000_000
  );
}

/** static CDN path와 HTTPS CDN image URL만 허용합니다. */
function isSafeImageReference(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 2048) {
    return false;
  }

  if (value.startsWith("/")) {
    return !value.startsWith("//") && !value.includes("\\");
  }

  try {
    const url = new URL(value);

    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}
