/** 역할: 관리자 카탈로그 입력값(ID·slug·카테고리·금액·재고·이미지·다국어 문구·cursor)을 읽고 검증하는 공용 도우미임. */
import { isRecord, readBoundedString } from "./request-helpers.js";
import {
  type CatalogProductStatus,
  type CatalogNameI18n,
  type CatalogDescriptionI18n,
} from "./admin-catalog-handler.js";
import { isCatalogStorageKey } from "./admin-catalog-intake.js";

/** 관리자 화면에서 선택할 수 있는 카테고리를 고정해 임의 분류 값의 누적을 막습니다. */
const CATALOG_CATEGORIES = [
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

export type CatalogCategory = (typeof CATALOG_CATEGORIES)[number];

const PRODUCT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,96}$/;

const MAX_PRICE = 100_000_000;

const MAX_INVENTORY = 1_000_000;

export function readProductId(value: unknown) {
  return typeof value === "string" && PRODUCT_ID_PATTERN.test(value)
    ? value
    : undefined;
}

export function readReferenceId(value: unknown, maximumLength: number) {
  const normalized = readBoundedString(value, maximumLength);

  return normalized && /^[A-Za-z0-9][A-Za-z0-9._-]{1,99}$/.test(normalized)
    ? normalized
    : undefined;
}

export function createBrandReferenceId(brandName: string) {
  return `brand_${Buffer.from(brandName).toString("base64url").slice(0, 80)}`;
}

export function normalizeSlug(value: string) {
  const normalized = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 180);

  return normalized && /^[a-z0-9가-힣][a-z0-9가-힣-]*$/.test(normalized)
    ? normalized
    : undefined;
}

export function readCatalogCategory(value: unknown): CatalogCategory | undefined {
  return isCatalogCategory(value) ? value : undefined;
}

export function isCatalogCategory(value: unknown): value is CatalogCategory {
  return (
    typeof value === "string" &&
    (CATALOG_CATEGORIES as readonly string[]).includes(value)
  );
}

export function readProductStatus(
  body: Record<string, unknown>,
): CatalogProductStatus | undefined {
  if (hasOwn(body, "status")) {
    return isCatalogProductStatus(body.status) ? body.status : undefined;
  }

  if (hasOwn(body, "isVisible")) {
    return typeof body.isVisible === "boolean"
      ? body.isVisible
        ? "PUBLISHED"
        : "DRAFT"
      : undefined;
  }

  return "DRAFT";
}

export function isCatalogProductStatus(value: unknown): value is CatalogProductStatus {
  return value === "DRAFT" || value === "PUBLISHED";
}

export function readKrwAmount(value: unknown): number | undefined {
  if (typeof value === "number") {
    return isKrwAmount(value) ? value : undefined;
  }

  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());

    return isKrwAmount(parsed) ? parsed : undefined;
  }

  return undefined;
}

export function readOptionalAmount(
  body: Record<string, unknown>,
  field: string,
): number | undefined | null {
  if (!hasOwn(body, field) || body[field] === null || body[field] === "") {
    return undefined;
  }

  return readKrwAmount(body[field]) ?? null;
}

export function isKrwAmount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_PRICE
  );
}

export function readInventoryQuantity(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return 0;
  }

  if (typeof value === "number") {
    return isInventoryQuantity(value) ? value : undefined;
  }

  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());

    return isInventoryQuantity(parsed) ? parsed : undefined;
  }

  return undefined;
}

export function isInventoryQuantity(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_INVENTORY
  );
}

export function readBooleanAlias(
  body: Record<string, unknown>,
  fields: readonly string[],
  fallback: boolean,
): boolean | undefined {
  for (const field of fields) {
    if (hasOwn(body, field)) {
      return typeof body[field] === "boolean" ? body[field] : undefined;
    }
  }

  return fallback;
}

export function readOptionalText(
  body: Record<string, unknown>,
  field: string,
  maximumLength: number,
): string | undefined | null {
  if (!hasOwn(body, field) || body[field] === null || body[field] === "") {
    return undefined;
  }

  return readBoundedString(body[field], maximumLength) ?? null;
}

export function readOptionalImage(
  body: Record<string, unknown>,
  fields: readonly string[],
): string | undefined | null {
  for (const field of fields) {
    if (!hasOwn(body, field)) {
      continue;
    }

    if (body[field] === null || body[field] === "") {
      return undefined;
    }

    const image = readBoundedString(body[field], 2_048);

    return image && isSafeImageUrl(image) ? image : null;
  }

  return undefined;
}

export function readImageList(
  value: unknown,
  image?: string,
): readonly string[] | null {
  if (value === undefined || value === null || value === "") {
    return image ? [image] : [];
  }

  if (!Array.isArray(value) || value.length > 12) {
    return null;
  }

  const urls: string[] = [];

  for (const item of value) {
    const url = readBoundedString(item, 2_048);

    if (!url || !isSafeImageUrl(url)) {
      return null;
    }

    if (!urls.includes(url)) {
      urls.push(url);
    }
  }

  if (image && !urls.includes(image)) {
    urls.unshift(image);
  }

  return urls;
}

function isSafeImageUrl(value: string) {
  if (value.startsWith("/")) {
    return (
      !value.startsWith("//") && !value.includes("\\") && !value.includes("\u0000")
    );
  }

  try {
    const url = new URL(value);

    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function readTextList(
  value: unknown,
  maximumItems: number,
  maximumItemLength: number,
  separator: "newline" | "comma",
): readonly string[] | null {
  if (value === undefined || value === null || value === "") {
    return [];
  }

  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(separator === "newline" ? /\r?\n/ : ",")
      : null;

  if (!values) {
    return null;
  }

  const normalized: string[] = [];

  for (const item of values) {
    if (typeof item !== "string") {
      return null;
    }

    const trimmed = item.trim();

    if (!trimmed) {
      continue;
    }

    if (trimmed.length > maximumItemLength || normalized.length >= maximumItems) {
      return null;
    }

    normalized.push(trimmed);
  }

  return normalized;
}

/** 없으면 undefined, 형식이 틀리면 null. */
export function readNameI18n(value: unknown): CatalogNameI18n | undefined | null {
  if (value === undefined) {
    return undefined;
  }

  return isCatalogNameI18n(value) ? value : null;
}

/** 없으면 undefined, 형식이 틀리면 null. */
export function readDescriptionI18n(
  value: unknown,
): CatalogDescriptionI18n | undefined | null {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    return null;
  }

  const en = readTextList(value.en, 20, 300, "newline");
  const ko = readTextList(value.ko, 20, 300, "newline");

  if (!en || !ko) {
    return null;
  }

  return { en, ko };
}

export function isCatalogNameI18n(value: unknown): value is CatalogNameI18n {
  return (
    isRecord(value) &&
    typeof value.en === "string" &&
    value.en.trim().length > 0 &&
    value.en.length <= 160 &&
    typeof value.ko === "string" &&
    value.ko.trim().length > 0 &&
    value.ko.length <= 160
  );
}

export function isCatalogDescriptionI18n(
  value: unknown,
): value is CatalogDescriptionI18n {
  return (
    isRecord(value) &&
    isStringArray(value.en) &&
    value.en.length <= 20 &&
    value.en.every((line) => line.length > 0 && line.length <= 300) &&
    isStringArray(value.ko) &&
    value.ko.length <= 20 &&
    value.ko.every((line) => line.length > 0 && line.length <= 300)
  );
}

export function readVersion(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  }

  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());

    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
  }

  return undefined;
}

export function readStatusFilter(value: unknown): CatalogProductStatus | undefined {
  return isCatalogProductStatus(value) ? value : undefined;
}

export function readListLimit(value: unknown) {
  if (value === undefined) {
    return 50;
  }

  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;

  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 100
    ? parsed
    : undefined;
}

export function encodeCursor(value: unknown) {
  if (!isRecord(value) || !isCatalogStorageKey(value.productId)) {
    return undefined;
  }

  return Buffer.from(JSON.stringify({ productId: value.productId })).toString(
    "base64url",
  );
}

export function decodeCursor(value: unknown) {
  if (typeof value !== "string" || value.length > 512) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    );

    return isRecord(parsed) && isCatalogStorageKey(parsed.productId)
      ? { productId: parsed.productId }
      : undefined;
  } catch {
    return undefined;
  }
}

export function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function hasOwn(value: Record<string, unknown>, field: string) {
  return Object.prototype.hasOwnProperty.call(value, field);
}

export function isConditionalWriteError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error.name === "ConditionalCheckFailedException" ||
      (error.name === "TransactionCanceledException" &&
        "CancellationReasons" in error &&
        Array.isArray(error.CancellationReasons) &&
        error.CancellationReasons.some(
          (reason: unknown) =>
            isRecord(reason) && reason.Code === "ConditionalCheckFailed",
        )))
  );
}
