// 역할: 관리자 워크스페이스 context 타입(AdminWorkspaceContext). 현재 메뉴·언어·메뉴 서랍 상태와 각 메뉴의 상태값·처리 함수 묶음을 정의합니다.
"use client";
import { useAuth } from "@/contexts/auth-context";
import { useLocale } from "@/contexts/locale-context";
import { ProductEditorSessions, type AdminSection } from "@/lib/admin-ui/navigation";
import type {
  AdminCatalogListItem,
  AdminDashboardActions,
  AdminOcrRemapResult,
  AdminOcrReviewRow,
  AdminProductDraft,
  OcrMapping,
  OcrTableAnalysis,
} from "@/lib/admin-ui/types";
import { type SizeChartKind, type SizeChartValues } from "@/lib/size-chart";
import type { DeckSpec, Locale } from "@/types/store";
import {
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { LocalizedText, MarketingChannel, Notice, OcrState } from "./admin-shared";
import { OcrInventoryAttemptStore } from "./ocr-inventory-commit";

export type AdminWorkspaceContext = Readonly<{
  locale: Locale;
  activeSection:
    | "overview"
    | "products"
    | "inventory"
    | "sales"
    | "brands"
    | "members"
    | "coupons"
    | "marketing"
    | "ocr";
  setLocale: (locale: Locale) => void;
  languageLabels: { ko: string; en: string };
  storeReturnPath: string;
  copy: ReturnType<typeof useLocale>["copy"];
  adminName: string;
  isOpsMenuOpen: boolean;
  isMenuButtonHidden: boolean;
  setIsOpsMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
  menuButtonRef: RefObject<HTMLButtonElement | null>;
  isDesktopAdmin: boolean;
  isMenuVisible: boolean;
  menuDrawerRef: RefObject<HTMLDivElement | null>;
  selectSection: (
    section: AdminSection,
    options?: Readonly<{ productView?: "create"; keepMenuOpen?: boolean }>,
  ) => void;
  moveSectionFocus: (
    event: KeyboardEvent<HTMLButtonElement>,
    currentSection: AdminSection,
  ) => void;
  operationActivities: readonly Readonly<{
    key: string;
    section: AdminSection;
    status: "working" | "draft" | "complete" | "attention";
    detail: LocalizedText;
    at: number;
    editorId?: string;
  }>[];
  productEditors: ProductEditorSessions;
  actions: AdminDashboardActions | undefined;
  localBrands: string[];
  isDeletingProducts: boolean;
  productDraft: Readonly<{
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
    productId?: string;
    version?: number;
    sourceLocale?: "en" | "ko";
    nameI18n?: Readonly<{ en: string; ko: string }>;
    descriptionI18n?: Readonly<{ en: readonly string[]; ko: readonly string[] }>;
  }>;
  productEditor: ReturnType<ProductEditorSessions["getSnapshot"]>;
  isLoadingProducts: boolean;
  isSavingProduct: boolean;
  savingProductEditorId: string | null;
  productNotice: Notice;
  removePendingProductActivity: (editorId: string) => void;
  finishProductEditor: (id: string, productId?: string) => void;
  setProductNotice: React.Dispatch<React.SetStateAction<Notice>>;
  handleDeleteProducts: (
    items: ReadonlyArray<Readonly<{ id: string; version: number }>>,
  ) => Promise<void>;
  openProductEditor: (product: AdminCatalogListItem, mode: "create" | "edit") => void;
  handleProductImageChange: (event: ChangeEvent<HTMLInputElement>) => void;
  openNewProductEditor: () => void;
  resetProductDraft: () => void;
  handleProductSave: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  saveProductDeckSpec: (
    deckSpec: DeckSpec | null,
    size?: string,
    sizeName?: string,
  ) => Promise<void>;
  saveProductSizeChart: (
    kind: SizeChartKind,
    values: SizeChartValues | null,
    size?: string,
    sizeName?: string,
  ) => Promise<void>;
  changeProductSizeChartKind: (sizeChartKind: SizeChartKind) => Promise<void>;
  updateProductText: (
    field: Exclude<
      keyof AdminProductDraft,
      | "isVisible"
      | "isFeatured"
      | "nameI18n"
      | "descriptionI18n"
      | "sourceLocale"
      | "productId"
      | "version"
    >,
    value: string,
  ) => void;
  updateProductToggle: (field: "isVisible" | "isFeatured", value: boolean) => void;
  previewCompareAtPrice: number;
  previewName: string;
  previewPrice: number;
  previewSizes: string[];
  localProducts: readonly AdminCatalogListItem[];
  productView: "create" | "edit" | "list";
  catalogLoadFailed: boolean;
  inventoryNotice: Notice;
  handleInventoryStockChange: (
    productId: string,
    nextStock: number,
    expected: Readonly<{ version: number; stock: number }>,
  ) => Promise<AdminCatalogListItem | null>;
  refreshInventoryProducts: () => Promise<readonly AdminCatalogListItem[] | null>;
  inventorySavingIds: ReadonlySet<string>;
  brandMemo: string;
  brandName: string;
  brandNotice: Notice;
  setBrandMemo: React.Dispatch<React.SetStateAction<string>>;
  markActivityWorking: (section: "brands" | "coupons" | "marketing") => void;
  setBrandName: React.Dispatch<React.SetStateAction<string>>;
  handleBrandSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  isSavingBrand: boolean;
  currentAdmin: ReturnType<typeof useAuth>["user"];
  membersLoaded: boolean;
  memberLoadFailed: boolean;
  isLoadingMembers: boolean;
  members: readonly Readonly<{
    username: string;
    userSub?: string;
    email?: string;
    displayName?: string;
    enabled: boolean;
    groups: readonly string[];
  }>[];
  memberNotice: Notice;
  handleLoadMembers: () => Promise<void>;
  memberNeedsRefresh: boolean;
  handleMemberGroupUpdate: (
    username: string,
    group: "admin" | "support",
    add: boolean,
    expectedGroups: readonly string[],
  ) => Promise<void>;
  memberRevision: number;
  isSavingMemberGroup: boolean;
  couponCode: string;
  couponExpiresAt: string;
  couponName: string;
  couponType: "percent" | "amount";
  couponValue: string;
  couponNotice: Notice;
  setCouponCode: React.Dispatch<React.SetStateAction<string>>;
  setCouponNotice: React.Dispatch<React.SetStateAction<Notice>>;
  setCouponExpiresAt: React.Dispatch<React.SetStateAction<string>>;
  setCouponName: React.Dispatch<React.SetStateAction<string>>;
  handleCouponSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  setCouponType: React.Dispatch<React.SetStateAction<"percent" | "amount">>;
  setCouponValue: React.Dispatch<React.SetStateAction<string>>;
  isSavingCoupon: boolean;
  campaignBody: string;
  campaignChannels: Record<MarketingChannel, boolean>;
  campaignNotice: Notice;
  setCampaignBody: React.Dispatch<React.SetStateAction<string>>;
  setCampaignNotice: React.Dispatch<React.SetStateAction<Notice>>;
  setCampaignChannels: React.Dispatch<
    React.SetStateAction<Record<MarketingChannel, boolean>>
  >;
  handleCampaignSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  setCampaignTitle: React.Dispatch<React.SetStateAction<string>>;
  isSavingCampaign: boolean;
  campaignTitle: string;
  ocrRows: Readonly<{
    id: string;
    sourceText: string;
    confidence?: number;
    box?: import("@/lib/admin-ui/types").AdminOcrBoundingBox;
    productName: string;
    brand: string;
    option: string;
    quantity: string;
  }>[];
  ocrJobId: string | null;
  ocrVersion: number | null;
  ocrFile: File | null;
  isSavingOcr: boolean;
  isApplyingOcrInventory: boolean;
  ocrInventoryJob: Readonly<{
    jobId: string;
    version: number;
    rawText: string;
    rows: readonly AdminOcrReviewRow[];
    analysis?: OcrTableAnalysis;
  }> | null;
  ocrNotice: Notice;
  handleAddOcrRow: () => void;
  handleOcrFileChange: (event: ChangeEvent<HTMLInputElement>) => Promise<void>;
  handleRecognize: () => Promise<void>;
  handleRemoveOcrRow: (id: string) => void;
  handleOcrSave: () => Promise<void>;
  updateOcrRow: (
    id: string,
    field: Exclude<keyof AdminOcrReviewRow, "id">,
    value: string,
  ) => void;
  ocrRawText: string;
  ocrInventoryAttempts: OcrInventoryAttemptStore;
  setIsApplyingOcrInventory: React.Dispatch<React.SetStateAction<boolean>>;
  catalogMutationGenerationRef: RefObject<number>;
  setLocalProducts: React.Dispatch<
    React.SetStateAction<readonly AdminCatalogListItem[]>
  >;
  ocrAnalysis:
    | Readonly<{
        mode: "table" | "empty" | "unclassified";
        reason?: string;
        table?: import("@/infra/lambda/ocr-table-parser").OcrTableDescriptor;
        mapping?: OcrMapping;
        region?: import("@/infra/lambda/ocr-table-parser").OcrRegionAnalysis;
      }>
    | undefined;
  ocrState: OcrState;
  handleOcrRemap: (
    mapping: OcrMapping,
    preview: boolean,
  ) => Promise<AdminOcrRemapResult | null>;
}>;
