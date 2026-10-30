// 역할: 정적 관리자 화면과 배포 후 관리자 API 어댑터가 공유하는 안전한 UI 계약을 정의합니다.
import type { SizeChartKind, SizeChartValues } from "@/lib/size-chart";
import type { DeckSpec } from "@/types/store";
import type {
  OcrMapping,
  OcrTableAnalysis,
} from "../../infra/lambda/ocr-table-parser.js";
export type {
  OcrColumnMapping,
  OcrRegionMapping,
  OcrRegionRect,
  OcrRegionAnalysis,
  OcrMapping,
  OcrTableAnalysis,
} from "../../infra/lambda/ocr-table-parser.js";

/** 관리자 상품 입력 폼이 다루는 공개 카탈로그 초안입니다. */
export type AdminProductDraft = Readonly<{
  name: string;
  brand: string;
  category: string;
  sku: string;
  price: string;
  compareAtPrice: string;
  stock: string;
  imageUrl: string;
  sizes: string;
  description: string;
  isVisible: boolean;
  isFeatured: boolean;
  /** 수정 시 기존 상품 id·version. 없으면 신규 */
  productId?: string;
  version?: number;
  /** 등록 UI 언어 — 자동 번역 소스 */
  sourceLocale?: "en" | "ko";
  nameI18n?: Readonly<{ en: string; ko: string }>;
  descriptionI18n?: Readonly<{ en: readonly string[]; ko: readonly string[] }>;
}>;

/** 관리자 상품 목록 한 행. 목록·필터·수정/삭제에 필요한 최소 필드입니다. */
export type AdminCatalogListItem = Readonly<{
  id: string;
  name: string;
  brand: string;
  category: string;
  price: number;
  stock: number;
  isVisible: boolean;
  version: number;
  sku?: string;
  imageUrl?: string;
  compareAtPrice?: number;
  sizes: string;
  description: string;
  isFeatured: boolean;
  nameI18n?: Readonly<{ en: string; ko: string }>;
  descriptionI18n?: Readonly<{ en: readonly string[]; ko: readonly string[] }>;
  deckSpec?: DeckSpec;
  /** 사이즈 옵션별 상세사이즈. 없는 옵션은 deckSpec(기본값)을 씁니다. */
  deckSpecsBySize?: Readonly<Record<string, DeckSpec>>;
  /** 의류·휠 상세사이즈 기본값(cm 또는 mm). */
  sizeChart?: Readonly<{ kind: SizeChartKind; values: SizeChartValues }>;
  /** 의류·휠 상세사이즈의 도면 종류. 옵션별 값도 이 종류의 항목을 따릅니다. */
  sizeChartKind?: SizeChartKind;
  /** 사이즈 옵션별 의류·휠 상세사이즈. 없는 옵션은 sizeChart(기본값)를 씁니다. */
  sizeChartsBySize?: Readonly<Record<string, SizeChartValues>>;
}>;

/** OCR provider가 반환하는 다각형 좌표입니다. 검토 UI에서는 읽기 전용 metadata로만 표시합니다. */
export type AdminOcrBoundingBox = readonly (readonly [number, number])[];

/** OCR이 읽은 한 줄을 운영자가 수정할 수 있는 형태로 정규화합니다. */
export type AdminOcrReviewRow = Readonly<{
  id: string;
  sourceText: string;
  /** provider가 준 confidence·bbox는 편집 payload에 넣지 않고 id 기준으로 서버가 보존합니다. */
  confidence?: number;
  box?: AdminOcrBoundingBox;
  productName: string;
  brand: string;
  option: string;
  quantity: string;
}>;

/** PaddleOCR 등 서버 측 인식기가 브라우저에 돌려줄 수 있는 최소 결과입니다. */
export type AdminOcrRecognitionResult = Readonly<{
  jobId: string;
  version: number;
  rawText: string;
  rows: readonly AdminOcrReviewRow[];
  analysis?: OcrTableAnalysis;
}>;

export type AdminOcrRemapInput = Readonly<{
  jobId: string;
  version: number;
  mapping: OcrMapping;
  preview: boolean;
}>;
export type AdminOcrRemapPreview = Readonly<{
  jobId: string;
  version: number;
  rows: readonly AdminOcrReviewRow[];
  analysis: OcrTableAnalysis;
}>;
export type AdminOcrRemapResult =
  | AdminOcrReviewSaveResult
  | Readonly<{ kind: "preview"; preview: AdminOcrRemapPreview }>;

/** Omitted rawText preserves the stored text; empty text explicitly clears it. */
export type AdminOcrReviewSaveInput = Readonly<{
  jobId: string;
  version: number;
  rows: readonly AdminOcrReviewRow[];
  /** Exact text, including whitespace; at most 100,000 UTF-16 units, no NUL. */
  rawText?: string;
}>;

/** PATCH 결과는 서버의 canonical job만 신뢰하고, 동시 수정 충돌은 최신 검토본으로 복구합니다. */
export type AdminOcrReviewSaveResult =
  | Readonly<{ kind: "saved"; job: AdminOcrRecognitionResult }>
  | Readonly<{ kind: "conflict"; job: AdminOcrRecognitionResult }>;

/** OCR 초안 저장과 분리된 실제 입고 명령. operationId는 동일 행의 재반영을 차단합니다. */
export type AdminOcrIntakeInput = Readonly<{
  operationId: string;
  quantity: number;
  /** 원본 행별 영속 claim. 묶음을 바꿔도 같은 행을 다시 입고하지 못합니다. */
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
          category: string;
        }>;
      }>
  );

export type AdminOcrIntakeResult = Readonly<{
  product: AdminCatalogListItem;
  receipt: Readonly<{
    operationId: string;
    kind: "existing" | "new";
    quantity: number;
    beforeStock: number;
    afterStock: number;
    replayed: boolean;
  }>;
}>;

/** 관리자 화면이 저장할 브랜드 초안입니다. 외부 공급처 연락처 등 민감 정보는 포함하지 않습니다. */
export type AdminBrandDraft = Readonly<{
  name: string;
  memo?: string;
}>;

/** 쿠폰의 고객 노출·발급 규칙 초안입니다. 실제 할인 적용은 결제 서버가 별도 검증합니다. */
export type AdminCouponDraft = Readonly<{
  name: string;
  code: string;
  discountType: "PERCENT" | "AMOUNT";
  discountValue: number;
  expiresAt?: string;
}>;

/** 마케팅 메시지 초안입니다. 대상자 조회·실제 발송은 수신 동의를 서버에서 확인한 뒤에만 실행합니다. */
export type AdminCampaignDraft = Readonly<{
  title: string;
  body: string;
  channels: readonly ("EMAIL" | "SMS" | "PUSH")[];
}>;

/** 인증된 admin API가 반환할 수 있는 최소 회원 관리 행입니다. */
export type AdminMember = Readonly<{
  username: string;
  userSub?: string;
  email?: string;
  displayName?: string;
  enabled: boolean;
  groups: readonly string[];
}>;

/** 관리자 운영 현황 카드에 표시하는 집계입니다. */
export type AdminOverviewMetrics = Readonly<{
  asOf: string;
  timezone: string;
  todayOrderCount: number;
  /** 결제 시각이 오늘(KST)인 PAID 주문의 KRW 합계. 구형 API는 생략 가능함. */
  todayPaidRevenue?: number;
  /** 결제 시각이 오늘(KST)인 PAID 주문의 판매 수량 합계. 구형 API는 생략 가능함. */
  todaySoldItemCount?: number;
  /** 가입 원천이 연결된 뒤 제공할 오늘(KST) 신규 회원 수. */
  todayNewMemberCount?: number;
  lowStockCount: number;
  lowStockThreshold: number;
  activeCouponCount: number;
  marketingConsentCount: number;
}>;

/**
 * 이미지 파일은 관리자 API에만 전달합니다.
 * 이 인터페이스는 브라우저에 OCR 키나 PaddleOCR 토큰을 넣지 않도록 경계를 유지합니다.
 */
export type AdminOcrRecognizer = (
  input: Readonly<{ file: File }>,
) => Promise<AdminOcrRecognitionResult>;

/** 관리자 UI가 배포된 API에 연결될 때 선택적으로 주입할 수 있는 액션입니다. */
export type AdminDashboardActions = Readonly<{
  recognizeInventory?: AdminOcrRecognizer;
  uploadProductImage?: (file: File) => Promise<string>;
  loadOverviewMetrics?: () => Promise<AdminOverviewMetrics>;
  listCatalogProducts?: () => Promise<readonly AdminCatalogListItem[]>;
  saveProductDraft?: (draft: AdminProductDraft) => Promise<void>;
  /** 재고만 부분 갱신. 성공 시 최신 version·stock이 반영된 목록 행을 반환합니다. */
  updateProductStock?: (
    input: Readonly<{ id: string; version: number; stock: number }>,
  ) => Promise<AdminCatalogListItem>;
  /** 상세사이즈만 즉시 저장(null이면 삭제). 성공 시 최신 version이 반영된 목록 행을 반환합니다. */
  updateProductDeckSpec?: (
    input: Readonly<{
      id: string;
      version: number;
      deckSpec: DeckSpec | null;
      /** 있으면 그 사이즈 옵션만, 없으면 기본값을 저장(null이면 삭제)합니다. */
      size?: string;
      /** size 옵션의 새 이름. 다르면 이름 변경과 상세사이즈를 함께 저장합니다. */
      sizeName?: string;
    }>,
  ) => Promise<AdminCatalogListItem>;
  /** 의류·휠 상세사이즈 기본값만 즉시 저장(null이면 삭제)합니다. */
  updateProductSizeChart?: (
    input: Readonly<{
      id: string;
      version: number;
      sizeChart: Readonly<{ kind: SizeChartKind; values: SizeChartValues }> | null;
    }>,
  ) => Promise<AdminCatalogListItem>;
  /** 사이즈 옵션 하나의 의류·휠 상세사이즈를 저장(null이면 삭제)하고, sizeName이 다르면 이름도 바꿉니다. */
  updateProductOptionSizeChart?: (
    input: Readonly<{
      id: string;
      version: number;
      size: string;
      sizeName?: string;
      sizeChartValues: SizeChartValues | null;
    }>,
  ) => Promise<AdminCatalogListItem>;
  /** 도면 종류를 바꿉니다. 다른 종류면 서버가 기본값과 옵션별 값을 모두 지웁니다. */
  updateProductSizeChartKind?: (
    input: Readonly<{ id: string; version: number; sizeChartKind: SizeChartKind }>,
  ) => Promise<AdminCatalogListItem>;
  deleteCatalogProducts?: (
    items: ReadonlyArray<Readonly<{ id: string; version: number }>>,
  ) => Promise<void>;
  saveBrandDraft?: (draft: AdminBrandDraft) => Promise<void>;
  saveCouponDraft?: (draft: AdminCouponDraft) => Promise<void>;
  saveCampaignDraft?: (draft: AdminCampaignDraft) => Promise<void>;
  listMembers?: () => Promise<readonly AdminMember[]>;
  updateMemberGroup?: (
    input: Readonly<{
      username: string;
      group: "admin" | "support";
      add: boolean;
    }>,
  ) => Promise<void>;
  loadOcrReview?: (jobId: string) => Promise<AdminOcrRecognitionResult>;
  saveOcrReview?: (input: AdminOcrReviewSaveInput) => Promise<AdminOcrReviewSaveResult>;
  remapOcrReview?: (input: AdminOcrRemapInput) => Promise<AdminOcrRemapResult>;
  applyOcrIntake?: (input: AdminOcrIntakeInput) => Promise<AdminOcrIntakeResult>;
}>;
