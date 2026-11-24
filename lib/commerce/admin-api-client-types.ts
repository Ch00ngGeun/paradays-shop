import type {
  AdminBrandDraft,
  AdminCampaignDraft,
  AdminCatalogListItem,
  AdminCouponDraft,
  AdminMember,
  AdminOcrRecognitionResult,
  AdminOcrRemapInput,
  AdminOcrRemapResult,
  AdminOcrReviewSaveInput,
  AdminOcrReviewSaveResult,
  AdminOcrIntakeInput,
  AdminOcrIntakeResult,
  AdminDashboardActions,
  AdminOverviewMetrics,
  AdminProductDraft,
} from "@/lib/admin-ui/types";
import type { DeckSpec } from "@/types/store";
import type {
  CheckoutApiConfig,
  CheckoutAuthorizationTokenProvider,
} from "@/lib/commerce/checkout-api-client";

export type AdminApiClientDependencies = Readonly<{
  config: CheckoutApiConfig;
  authorizationTokenProvider: CheckoutAuthorizationTokenProvider;
  fetchImplementation?: typeof fetch;
}>;

/** 대시보드 connector가 사용하는 실제 관리자 API 함수의 집합입니다. */
export type AdminApiClient = Readonly<{
  uploadProductImage: (file: File) => Promise<string>;
  loadOverviewMetrics: () => Promise<AdminOverviewMetrics>;
  listCatalogProducts: () => Promise<readonly AdminCatalogListItem[]>;
  saveProductDraft: (draft: AdminProductDraft) => Promise<void>;
  updateProductStock: (
    input: Readonly<{ id: string; version: number; stock: number }>,
  ) => Promise<AdminCatalogListItem>;
  updateProductDeckSpec: (
    input: Readonly<{
      id: string;
      version: number;
      deckSpec: DeckSpec | null;
      /** 있으면 그 사이즈 옵션의 상세사이즈만, 없으면 기본값을 저장합니다. */
      size?: string;
      /** size 옵션의 새 이름. 다르면 이름 변경과 상세사이즈를 한 번에 저장합니다. */
      sizeName?: string;
    }>,
  ) => Promise<AdminCatalogListItem>;
  updateProductSizeChart: NonNullable<AdminDashboardActions["updateProductSizeChart"]>;
  updateProductOptionSizeChart: NonNullable<
    AdminDashboardActions["updateProductOptionSizeChart"]
  >;
  updateProductSizeChartKind: NonNullable<
    AdminDashboardActions["updateProductSizeChartKind"]
  >;
  deleteCatalogProducts: (
    items: ReadonlyArray<Readonly<{ id: string; version: number }>>,
  ) => Promise<void>;
  saveBrandDraft: (draft: AdminBrandDraft) => Promise<void>;
  saveCouponDraft: (draft: AdminCouponDraft) => Promise<void>;
  saveCampaignDraft: (draft: AdminCampaignDraft) => Promise<void>;
  listMembers: () => Promise<readonly AdminMember[]>;
  updateMemberGroup: (
    input: Readonly<{
      username: string;
      group: "admin" | "support";
      add: boolean;
    }>,
  ) => Promise<void>;
  recognizeInventory: (
    input: Readonly<{ file: File }>,
  ) => Promise<AdminOcrRecognitionResult>;
  loadOcrReview: (jobId: string) => Promise<AdminOcrRecognitionResult>;
  saveOcrReview: (input: AdminOcrReviewSaveInput) => Promise<AdminOcrReviewSaveResult>;
  remapOcrReview: (input: AdminOcrRemapInput) => Promise<AdminOcrRemapResult>;
  applyOcrIntake: (input: AdminOcrIntakeInput) => Promise<AdminOcrIntakeResult>;
}>;
