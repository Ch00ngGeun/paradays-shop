/** 역할: 관리자 운영 레코드의 형식 판별, 리소스별 table·ID 규칙, 상태·할인 방식 등 입력값 읽기를 맡는 도우미임. */
import { isRecord, readBoundedString } from "./request-helpers.js";
import {
  type StoredResource,
  type BrandStatus,
  type CouponStatus,
  type CouponDiscountType,
  type CampaignStatus,
  type CampaignChannel,
  type BaseOperationRecord,
  type BrandRecord,
  type CouponRecord,
  type CampaignRecord,
  type BrandInput,
  type CouponInput,
  type CampaignInput,
  type OperationInput,
} from "./admin-operations-types.js";

const RECORD_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,96}$/;

const MAX_KRW_AMOUNT = 100_000_000;

export const MAX_USAGE_LIMIT = 1_000_000;

export const MAX_CAMPAIGN_MESSAGE_LENGTH = 8_000;

export function isBrandRecord(value: unknown): value is BrandRecord {
  return (
    isBaseOperationRecord(value) &&
    value.recordType === "BRAND" &&
    isRecordId(value.brandId) &&
    typeof value.name === "string" &&
    typeof value.slug === "string" &&
    (value.memo === undefined || typeof value.memo === "string") &&
    (value.description === undefined || typeof value.description === "string") &&
    (value.logoUrl === undefined || typeof value.logoUrl === "string") &&
    isBrandStatus(value.status)
  );
}

export function isCouponRecord(value: unknown): value is CouponRecord {
  return (
    isBaseOperationRecord(value) &&
    value.recordType === "COUPON" &&
    isRecordId(value.couponId) &&
    typeof value.name === "string" &&
    typeof value.code === "string" &&
    isCouponDiscountType(value.discountType) &&
    isKrwOrPercentAmount(value.discountValue) &&
    isKrwOrPercentAmount(value.minimumOrderAmount) &&
    (value.maximumDiscountAmount === undefined ||
      isKrwOrPercentAmount(value.maximumDiscountAmount)) &&
    (value.startsAt === undefined || typeof value.startsAt === "string") &&
    (value.expiresAt === undefined || typeof value.expiresAt === "string") &&
    isCouponStatus(value.status) &&
    (value.usageLimit === undefined ||
      isPositiveInteger(value.usageLimit, MAX_USAGE_LIMIT)) &&
    (value.perMemberLimit === undefined || isPositiveInteger(value.perMemberLimit, 100))
  );
}

export function isCampaignRecord(value: unknown): value is CampaignRecord {
  return (
    isBaseOperationRecord(value) &&
    value.recordType === "CAMPAIGN" &&
    isRecordId(value.campaignId) &&
    typeof value.title === "string" &&
    isCampaignChannelArray(value.channels) &&
    value.audience === "MARKETING_CONSENTED" &&
    (value.subject === undefined || typeof value.subject === "string") &&
    typeof value.body === "string" &&
    isCampaignStatus(value.status) &&
    (value.scheduledAt === undefined || typeof value.scheduledAt === "string")
  );
}

function isBaseOperationRecord(
  value: unknown,
): value is BaseOperationRecord & Record<string, unknown> {
  return (
    isRecord(value) &&
    typeof value.version === "number" &&
    Number.isSafeInteger(value.version) &&
    value.version > 0 &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    typeof value.createdBy === "string" &&
    typeof value.updatedBy === "string"
  );
}

export function isBrandInput(value: OperationInput): value is BrandInput {
  return "slug" in value && "name" in value && !("code" in value);
}

export function isCouponInput(value: OperationInput): value is CouponInput {
  return "code" in value && "discountType" in value;
}

export function isCampaignInput(value: OperationInput): value is CampaignInput {
  return "channels" in value && "body" in value;
}

export function getTableEnvironmentName(resource: StoredResource) {
  const names: Record<StoredResource, string> = {
    brands: "BRAND_TABLE_NAME",
    coupons: "COUPON_TABLE_NAME",
    campaigns: "CAMPAIGN_TABLE_NAME",
  };

  return names[resource];
}

export function getRecordIdField(resource: StoredResource) {
  const names: Record<StoredResource, string> = {
    brands: "brandId",
    coupons: "couponId",
    campaigns: "campaignId",
  };

  return names[resource];
}

export function getRecordIdPrefix(resource: StoredResource) {
  const prefixes: Record<StoredResource, string> = {
    brands: "brand",
    coupons: "coupon",
    campaigns: "campaign",
  };

  return prefixes[resource];
}

export function readRequestedRecordId(
  resource: StoredResource,
  body: Record<string, unknown>,
): string | undefined | null {
  const field = getRecordIdField(resource);

  if (!hasOwn(body, field)) {
    return undefined;
  }

  return isRecordId(body[field]) ? body[field] : null;
}

export function normalizeSlug(value: string) {
  const normalized = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);

  return normalized && /^[a-z0-9가-힣][a-z0-9가-힣-]*$/.test(normalized)
    ? normalized
    : undefined;
}

export function normalizeCouponCode(value: unknown) {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().toUpperCase();

  return /^[A-Z0-9][A-Z0-9_-]{2,31}$/.test(normalized) ? normalized : undefined;
}

export function readBrandStatus(value: unknown): BrandStatus | undefined {
  return value === "ACTIVE" || value === "ARCHIVED" ? value : undefined;
}

function isBrandStatus(value: unknown): value is BrandStatus {
  return readBrandStatus(value) !== undefined;
}

export function readCouponStatus(value: unknown): CouponStatus | undefined {
  return value === "DRAFT" || value === "ACTIVE" || value === "PAUSED"
    ? value
    : undefined;
}

function isCouponStatus(value: unknown): value is CouponStatus {
  return readCouponStatus(value) !== undefined;
}

export function readCouponDiscountType(value: unknown): CouponDiscountType | undefined {
  if (value === "PERCENT" || value === "AMOUNT") {
    return value;
  }

  // 초기 내부 초안은 FIXED_AMOUNT를 썼음. 읽기 호환은 유지하되
  // 이제부터 저장은 공개 관리자 API의 AMOUNT 용어로 함.
  return value === "FIXED_AMOUNT" ? "AMOUNT" : undefined;
}

function isCouponDiscountType(value: unknown): value is CouponDiscountType {
  return readCouponDiscountType(value) !== undefined;
}

export function readCampaignStatus(value: unknown): CampaignStatus | undefined {
  return value === "DRAFT" || value === "SCHEDULED" || value === "PAUSED"
    ? value
    : undefined;
}

function isCampaignStatus(value: unknown): value is CampaignStatus {
  return readCampaignStatus(value) !== undefined;
}

export function readCampaignChannels(
  value: unknown,
): readonly CampaignChannel[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 3) {
    return undefined;
  }

  const channels = value.filter(
    (channel): channel is CampaignChannel =>
      channel === "EMAIL" || channel === "SMS" || channel === "PUSH",
  );

  return channels.length === value.length && new Set(channels).size === channels.length
    ? channels
    : undefined;
}

function isCampaignChannelArray(value: unknown): value is readonly CampaignChannel[] {
  return readCampaignChannels(value) !== undefined;
}

export function readKrwOrPercentAmount(value: unknown): number | undefined {
  if (typeof value === "number") {
    return isKrwOrPercentAmount(value) ? value : undefined;
  }

  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());

    return isKrwOrPercentAmount(parsed) ? parsed : undefined;
  }

  return undefined;
}

function isKrwOrPercentAmount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_KRW_AMOUNT
  );
}

export function readOptionalAmount(
  body: Record<string, unknown>,
  field: string,
): number | undefined | null {
  if (!hasOwn(body, field) || body[field] === null || body[field] === "") {
    return undefined;
  }

  return readKrwOrPercentAmount(body[field]) ?? null;
}

export function readOptionalPositiveInteger(
  body: Record<string, unknown>,
  field: string,
  maximum: number,
): number | undefined | null {
  if (!hasOwn(body, field) || body[field] === null || body[field] === "") {
    return undefined;
  }

  const value = readKrwOrPercentAmount(body[field]);

  return value !== undefined && isPositiveInteger(value, maximum) ? value : null;
}

function isPositiveInteger(value: unknown, maximum: number): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= maximum
  );
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

export function readOptionalUrl(
  body: Record<string, unknown>,
  field: string,
): string | undefined | null {
  if (!hasOwn(body, field) || body[field] === null || body[field] === "") {
    return undefined;
  }

  const value = readBoundedString(body[field], 2_048);

  return value && isSafeAssetUrl(value) ? value : null;
}

function isSafeAssetUrl(value: string) {
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

export function readOptionalDate(
  body: Record<string, unknown>,
  field: string,
): string | undefined | null {
  if (!hasOwn(body, field) || body[field] === null || body[field] === "") {
    return undefined;
  }

  const source = readBoundedString(body[field], 64);

  if (!source) {
    return null;
  }

  const timestamp = Date.parse(source);

  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

export function readVersion(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value.trim())
        ? Number(value.trim())
        : NaN;

  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
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

export function encodeCursor(resource: StoredResource, value: unknown) {
  const idField = getRecordIdField(resource);

  if (!isRecord(value) || !isRecordId(value[idField])) {
    return undefined;
  }

  return Buffer.from(JSON.stringify({ [idField]: value[idField] })).toString(
    "base64url",
  );
}

export function decodeCursor(resource: StoredResource, value: unknown) {
  if (typeof value !== "string" || value.length > 512) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    );
    const idField = getRecordIdField(resource);

    return isRecord(parsed) && isRecordId(parsed[idField])
      ? { [idField]: parsed[idField] }
      : undefined;
  } catch {
    return undefined;
  }
}

export function isRecordId(value: unknown): value is string {
  return typeof value === "string" && RECORD_ID_PATTERN.test(value);
}

export function hasOwn(value: Record<string, unknown>, field: string) {
  return Object.prototype.hasOwnProperty.call(value, field);
}

export function isConditionalWriteError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "ConditionalCheckFailedException"
  );
}
