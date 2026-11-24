import { isRecord, readBoundedString } from "./request-helpers.js";
import {
  type StoredResource,
  type BaseOperationRecord,
  type OperationRecord,
  type BrandInput,
  type CouponInput,
  type CampaignInput,
  type OperationInput,
} from "./admin-operations-types.js";
import {
  MAX_USAGE_LIMIT,
  MAX_CAMPAIGN_MESSAGE_LENGTH,
  isBrandRecord,
  isCouponRecord,
  isCampaignRecord,
  isBrandInput,
  isCouponInput,
  isCampaignInput,
  normalizeSlug,
  normalizeCouponCode,
  readBrandStatus,
  readCouponStatus,
  readCouponDiscountType,
  readCampaignStatus,
  readCampaignChannels,
  readKrwOrPercentAmount,
  readOptionalAmount,
  readOptionalPositiveInteger,
  readOptionalText,
  readOptionalUrl,
  readOptionalDate,
  hasOwn,
} from "./admin-operations-values.js";

export function parseStoredRecord(
  resource: StoredResource,
  value: unknown,
): OperationRecord | null {
  if (resource === "brands") {
    return isBrandRecord(value) ? value : null;
  }

  if (resource === "coupons") {
    return isCouponRecord(value) ? value : null;
  }

  return isCampaignRecord(value) ? value : null;
}

/** body에서 resource별 고정 도메인 값을 읽습니다. unknown 속성은 저장하지 않습니다. */
export function parseOperationInput(
  resource: StoredResource,
  body: unknown,
): OperationInput | null {
  if (resource === "brands") {
    return parseBrandInput(body);
  }

  if (resource === "coupons") {
    return parseCouponInput(body);
  }

  return parseCampaignInput(body);
}

function parseBrandInput(body: unknown): BrandInput | null {
  if (!isRecord(body)) {
    return null;
  }

  const name = readBoundedString(body.name, 100);
  const suppliedSlug = hasOwn(body, "slug")
    ? readBoundedString(body.slug, 120)
    : undefined;
  const slug = normalizeSlug(suppliedSlug ?? name ?? "");
  const memo = readOptionalText(body, "memo", 1_000);
  const description = readOptionalText(body, "description", 1_000);
  const logoUrl = readOptionalUrl(body, "logoUrl");
  const status = hasOwn(body, "status") ? readBrandStatus(body.status) : "ACTIVE";

  if (
    !name ||
    !slug ||
    memo === null ||
    description === null ||
    logoUrl === null ||
    !status
  ) {
    return null;
  }

  return {
    name,
    slug,
    ...(memo ? { memo } : {}),
    ...(description ? { description } : {}),
    ...(logoUrl ? { logoUrl } : {}),
    status,
  };
}

function parseCouponInput(body: unknown): CouponInput | null {
  if (!isRecord(body)) {
    return null;
  }

  const name = readBoundedString(body.name, 120);
  const code = normalizeCouponCode(body.code);
  const discountType = readCouponDiscountType(
    hasOwn(body, "discountType") ? body.discountType : body.type,
  );
  const discountValue = readKrwOrPercentAmount(body.discountValue ?? body.value);
  const minimumOrderAmount = hasOwn(body, "minimumOrderAmount")
    ? readKrwOrPercentAmount(body.minimumOrderAmount)
    : 0;
  const maximumDiscountAmount = readOptionalAmount(body, "maximumDiscountAmount");
  const startsAt = readOptionalDate(body, "startsAt");
  const expiresAt = hasOwn(body, "expiresAt")
    ? readOptionalDate(body, "expiresAt")
    : readOptionalDate(body, "endsAt");
  const status = hasOwn(body, "status") ? readCouponStatus(body.status) : "DRAFT";
  const usageLimit = readOptionalPositiveInteger(body, "usageLimit", MAX_USAGE_LIMIT);
  const perMemberLimit = readOptionalPositiveInteger(body, "perMemberLimit", 100);

  if (
    !name ||
    !code ||
    !discountType ||
    discountValue === undefined ||
    minimumOrderAmount === undefined ||
    maximumDiscountAmount === null ||
    startsAt === null ||
    expiresAt === null ||
    !status ||
    usageLimit === null ||
    perMemberLimit === null
  ) {
    return null;
  }

  if (
    (discountType === "PERCENT" && (discountValue < 1 || discountValue > 100)) ||
    (discountType === "AMOUNT" && discountValue < 1) ||
    (startsAt && expiresAt && startsAt >= expiresAt)
  ) {
    return null;
  }

  return {
    name,
    code,
    discountType,
    discountValue,
    minimumOrderAmount,
    ...(maximumDiscountAmount ? { maximumDiscountAmount } : {}),
    ...(startsAt ? { startsAt } : {}),
    ...(expiresAt ? { expiresAt } : {}),
    status,
    ...(usageLimit ? { usageLimit } : {}),
    ...(perMemberLimit ? { perMemberLimit } : {}),
  };
}

function parseCampaignInput(body: unknown): CampaignInput | null {
  if (!isRecord(body)) {
    return null;
  }

  const title = readBoundedString(hasOwn(body, "title") ? body.title : body.name, 160);
  const channels = readCampaignChannels(body.channels);
  const audience = hasOwn(body, "audience") ? body.audience : "MARKETING_CONSENTED";
  const subject = readOptionalText(body, "subject", 200);
  const bodyText = readBoundedString(
    hasOwn(body, "body")
      ? body.body
      : hasOwn(body, "message")
        ? body.message
        : body.content,
    MAX_CAMPAIGN_MESSAGE_LENGTH,
  );
  const status = hasOwn(body, "status") ? readCampaignStatus(body.status) : "DRAFT";
  const scheduledAt = readOptionalDate(body, "scheduledAt");

  if (
    !title ||
    !channels ||
    audience !== "MARKETING_CONSENTED" ||
    subject === null ||
    !bodyText ||
    !status ||
    scheduledAt === null
  ) {
    return null;
  }

  if (status === "SCHEDULED" && !scheduledAt) {
    return null;
  }

  return {
    title,
    channels,
    audience,
    ...(subject ? { subject } : {}),
    body: bodyText,
    status,
    ...(scheduledAt ? { scheduledAt } : {}),
  };
}

export function createStoredRecord(
  resource: StoredResource,
  input: OperationInput,
  resourceId: string,
  userSub: string,
  timestamp: string,
): OperationRecord {
  const auditFields: BaseOperationRecord = {
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    createdBy: userSub,
    updatedBy: userSub,
  };

  if (resource === "brands" && isBrandInput(input)) {
    return { recordType: "BRAND", brandId: resourceId, ...input, ...auditFields };
  }

  if (resource === "coupons" && isCouponInput(input)) {
    return { recordType: "COUPON", couponId: resourceId, ...input, ...auditFields };
  }

  if (resource === "campaigns" && isCampaignInput(input)) {
    return {
      recordType: "CAMPAIGN",
      campaignId: resourceId,
      ...input,
      ...auditFields,
    };
  }

  throw new Error("OPERATION_RESOURCE_INPUT_MISMATCH");
}

export function replaceStoredRecord(
  existingRecord: OperationRecord,
  input: OperationInput,
  userSub: string,
  timestamp: string,
): OperationRecord {
  const auditFields: BaseOperationRecord = {
    version: existingRecord.version + 1,
    createdAt: existingRecord.createdAt,
    updatedAt: timestamp,
    createdBy: existingRecord.createdBy,
    updatedBy: userSub,
  };

  if (existingRecord.recordType === "BRAND" && isBrandInput(input)) {
    return {
      recordType: "BRAND",
      brandId: existingRecord.brandId,
      ...input,
      ...auditFields,
    };
  }

  if (existingRecord.recordType === "COUPON" && isCouponInput(input)) {
    return {
      recordType: "COUPON",
      couponId: existingRecord.couponId,
      ...input,
      ...auditFields,
    };
  }

  if (existingRecord.recordType === "CAMPAIGN" && isCampaignInput(input)) {
    return {
      recordType: "CAMPAIGN",
      campaignId: existingRecord.campaignId,
      ...input,
      ...auditFields,
    };
  }

  throw new Error("OPERATION_RECORD_INPUT_MISMATCH");
}

/** 기존 record를 request aliases가 통하는 완전한 input 객체로 바꾼 뒤 patch allowlist만 반영합니다. */
export function mergeOperationPatch(
  record: OperationRecord,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  if (record.recordType === "BRAND") {
    return mergeAllowlistedPatch(
      {
        name: record.name,
        slug: record.slug,
        memo: record.memo ?? null,
        description: record.description ?? null,
        logoUrl: record.logoUrl ?? null,
        status: record.status,
      },
      patch,
      ["name", "slug", "memo", "description", "logoUrl", "status"],
    );
  }

  if (record.recordType === "COUPON") {
    return mergeAllowlistedPatch(
      {
        name: record.name,
        code: record.code,
        discountType: record.discountType,
        discountValue: record.discountValue,
        minimumOrderAmount: record.minimumOrderAmount,
        maximumDiscountAmount: record.maximumDiscountAmount ?? null,
        startsAt: record.startsAt ?? null,
        expiresAt: record.expiresAt ?? null,
        status: record.status,
        usageLimit: record.usageLimit ?? null,
        perMemberLimit: record.perMemberLimit ?? null,
      },
      patch,
      [
        "name",
        "code",
        "discountType",
        "discountValue",
        "minimumOrderAmount",
        "maximumDiscountAmount",
        "startsAt",
        "expiresAt",
        "status",
        "usageLimit",
        "perMemberLimit",
      ],
      {
        type: "discountType",
        value: "discountValue",
        endsAt: "expiresAt",
      },
    );
  }

  return mergeAllowlistedPatch(
    {
      title: record.title,
      channels: record.channels,
      audience: record.audience,
      subject: record.subject ?? null,
      body: record.body,
      status: record.status,
      scheduledAt: record.scheduledAt ?? null,
    },
    patch,
    ["title", "channels", "audience", "subject", "body", "status", "scheduledAt"],
    { name: "title", message: "body", content: "body" },
  );
}

function mergeAllowlistedPatch(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
  fields: readonly string[],
  aliases: Record<string, string> = {},
) {
  const merged = { ...base };

  for (const field of fields) {
    if (hasOwn(patch, field)) {
      merged[field] = patch[field];
    }
  }

  for (const [alias, field] of Object.entries(aliases)) {
    if (hasOwn(patch, alias) && !hasOwn(patch, field)) {
      merged[field] = patch[alias];
    }
  }

  return merged;
}

/** 저장 record에는 recordType별 safe response를 만들며 작성자 subject 등은 항상 빼고 반환합니다. */
export function toAdminOperationRecord(
  record: OperationRecord,
): Record<string, unknown> {
  if (record.recordType === "BRAND") {
    return {
      brandId: record.brandId,
      name: record.name,
      slug: record.slug,
      ...(record.memo ? { memo: record.memo } : {}),
      ...(record.description ? { description: record.description } : {}),
      ...(record.logoUrl ? { logoUrl: record.logoUrl } : {}),
      status: record.status,
      version: record.version,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  if (record.recordType === "COUPON") {
    return {
      couponId: record.couponId,
      name: record.name,
      code: record.code,
      discountType: record.discountType,
      discountValue: record.discountValue,
      minimumOrderAmount: record.minimumOrderAmount,
      ...(record.maximumDiscountAmount
        ? { maximumDiscountAmount: record.maximumDiscountAmount }
        : {}),
      ...(record.startsAt ? { startsAt: record.startsAt } : {}),
      ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}),
      status: record.status,
      ...(record.usageLimit ? { usageLimit: record.usageLimit } : {}),
      ...(record.perMemberLimit ? { perMemberLimit: record.perMemberLimit } : {}),
      version: record.version,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  return {
    campaignId: record.campaignId,
    title: record.title,
    channels: [...record.channels],
    audience: record.audience,
    ...(record.subject ? { subject: record.subject } : {}),
    body: record.body,
    status: record.status,
    ...(record.scheduledAt ? { scheduledAt: record.scheduledAt } : {}),
    version: record.version,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
