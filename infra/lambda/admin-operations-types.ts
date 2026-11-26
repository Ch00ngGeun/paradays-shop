/** 역할: 관리자 운영 API의 리소스 이름과 브랜드·쿠폰·캠페인 레코드·상태 타입을 정의함. */
export type OperationResource = "brands" | "coupons" | "campaigns" | "members";

export type StoredResource = Exclude<OperationResource, "members">;

export type BrandStatus = "ACTIVE" | "ARCHIVED";

export type CouponStatus = "DRAFT" | "ACTIVE" | "PAUSED";

export type CouponDiscountType = "PERCENT" | "AMOUNT";

export type CampaignStatus = "DRAFT" | "SCHEDULED" | "PAUSED";

export type CampaignChannel = "EMAIL" | "SMS" | "PUSH";

export type BaseOperationRecord = Readonly<{
  version: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
}>;

export type BrandRecord = BaseOperationRecord &
  Readonly<{
    recordType: "BRAND";
    brandId: string;
    name: string;
    slug: string;
    memo?: string;
    description?: string;
    logoUrl?: string;
    status: BrandStatus;
  }>;

export type CouponRecord = BaseOperationRecord &
  Readonly<{
    recordType: "COUPON";
    couponId: string;
    name: string;
    code: string;
    discountType: CouponDiscountType;
    discountValue: number;
    minimumOrderAmount: number;
    maximumDiscountAmount?: number;
    startsAt?: string;
    expiresAt?: string;
    status: CouponStatus;
    usageLimit?: number;
    perMemberLimit?: number;
  }>;

export type CampaignRecord = BaseOperationRecord &
  Readonly<{
    recordType: "CAMPAIGN";
    campaignId: string;
    title: string;
    channels: readonly CampaignChannel[];
    audience: "MARKETING_CONSENTED";
    subject?: string;
    body: string;
    status: CampaignStatus;
    scheduledAt?: string;
  }>;

export type OperationRecord = BrandRecord | CouponRecord | CampaignRecord;

export type BrandInput = Omit<
  BrandRecord,
  "brandId" | "recordType" | keyof BaseOperationRecord
>;

export type CouponInput = Omit<
  CouponRecord,
  "couponId" | "recordType" | keyof BaseOperationRecord
>;

export type CampaignInput = Omit<
  CampaignRecord,
  "campaignId" | "recordType" | keyof BaseOperationRecord
>;

export type OperationInput = BrandInput | CouponInput | CampaignInput;

export type OperationRoute = Readonly<{
  resource: OperationResource;
  resourceId?: string;
}>;
