// 역할: Cognito admin 그룹 사용자에게만 노출되는 정적 관리자 워크스페이스 UI를 제공합니다.
"use client";

import Image from "next/image";
import Link from "next/link";
import {
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { useAuth } from "@/contexts/auth-context";
import { useLocale } from "@/contexts/locale-context";
import { useHeaderScroll } from "@/hooks/use-header-scroll";
import { CAMPAIGN_LOGO, campaignChannelSupport } from "@/lib/admin-ui/campaign-message";
import requiredStyles from "./admin-required.module.css";
import { AdminStepper, type AdminStep } from "./admin-stepper";
import { rememberAuthReturnPath } from "@/lib/auth/return-path";
import {
  type AdminSection,
  getAdminProductEditorId,
  getAdminSectionSnapshot,
  getServerAdminSectionSnapshot,
  navigateToAdminSection,
  navigateToAdminProductEditor,
  ProductEditorSessions,
  subscribeToAdminSection,
} from "@/lib/admin-ui/navigation";
import {
  getAdminStoreResumeSnapshot,
  getAdminStoreReturnSnapshot,
  getServerAdminStoreReturnSnapshot,
} from "@/lib/admin-ui/store-return";
import type {
  AdminBrandDraft,
  AdminCampaignDraft,
  AdminCatalogListItem,
  AdminCouponDraft,
  AdminDashboardActions,
  AdminMember,
  AdminOcrRecognitionResult,
  AdminOcrRemapResult,
  AdminOcrReviewRow,
  OcrMapping,
  OcrTableAnalysis,
  AdminOverviewMetrics,
  AdminProductDraft,
} from "@/lib/admin-ui/types";
import type { DeckSpec, Locale } from "@/types/store";
import {
  appendProductOption,
  createProductSku,
  formatProductDeckOption,
  formatProductWheelOption,
  mergeProductBrandNames,
  PRODUCT_DECK_WIDTHS,
  PRODUCT_WHEEL_DIAMETERS,
  PRODUCT_WHEEL_HARDNESSES,
  validateProductOptions,
} from "@/lib/admin-ui/product-form";
import {
  getOcrInputErrorMessage,
  getOcrReviewRowValidationMessage,
  OCR_INPUT_LIMITS,
  validateOcrImageFile,
} from "@/lib/admin-ui/ocr-input-validation";
import {
  AdminApiRequestError,
  getOcrRequestErrorMessage,
  isLocalOcrDevelopmentMode,
  isRemoteOcrDemoMode,
} from "@/lib/commerce/admin-api-client";
import { buildProductI18nFields, TranslateError } from "@/lib/commerce/translate-text";

import styles from "./admin-dashboard.module.css";
import { OcrRegionMappingPanel } from "./ocr-region-mapping";
import { AdminOrderInventoryPanel } from "./admin-order-inventory";
import { AdminOrderSimulationPanel } from "./admin-order-simulation";
import { AdminSalesLedgerPanel } from "./admin-sales-ledger";
import { AdminNotice, AdminStatusBadge, StockStatusBadge } from "./admin-status";
import { AdminDeckSpecModal } from "./admin-deck-spec-modal";
import { formatDeckInches } from "./deck-size-diagram";
import {
  OcrInventoryCommitPanel,
  OcrInventoryAttemptStore,
} from "./ocr-inventory-commit";

/** 비동기 결과 문구는 두 언어를 함께 저장하고 화면에 그릴 때 현재 언어로 고릅니다. */
type LocalizedText = string | Readonly<Record<Locale, string>>;

function localizedText(text: LocalizedText, locale: Locale) {
  return typeof text === "string" ? text : text[locale];
}

function localizedOcrRequestError(error: unknown): LocalizedText | undefined {
  const ko = getOcrRequestErrorMessage(error, "ko");
  const en = getOcrRequestErrorMessage(error, "en");
  return ko && en ? { ko, en } : undefined;
}

type Notice =
  | Readonly<{ kind: "error"; message: LocalizedText }>
  | Readonly<{ kind: "success"; message: LocalizedText }>
  | null;

type MarketingChannel = "email" | "sms" | "push";

type OcrState = "idle" | "connection-needed" | "recognizing" | "review";

type OperationActivity = Readonly<{
  key: string;
  section: AdminSection;
  status: "working" | "draft" | "complete" | "attention";
  detail: LocalizedText;
  at: number;
  editorId?: string;
}>;

const operationStatusLabels = {
  ko: {
    working: "작업 중",
    draft: "임시저장",
    complete: "완료",
    attention: "확인 필요",
  },
  en: {
    working: "In progress",
    draft: "Draft",
    complete: "Done",
    attention: "Needs review",
  },
} as const;

/** Capture wall-clock time only when an administrator event is handled, never in render. */
function operationEventTime() {
  return Date.now();
}

const operationIconTone: Record<AdminSection, string> = {
  overview: "blue",
  products: "purple",
  inventory: "blue",
  sales: "green",
  brands: "purple",
  members: "purple",
  coupons: "amber",
  marketing: "blue",
  ocr: "green",
};

const ADMIN_GROUP = "admin";
const subscribeToLocalOcrMode = () => () => {};
const serverLocalOcrMode = () => false;
const desktopAdminQuery = "(min-width: 1024px)";
const subscribeToAdminViewport = (onChange: () => void) => {
  const query = window.matchMedia(desktopAdminQuery);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
};
const getDesktopAdminSnapshot = () => window.matchMedia(desktopAdminQuery).matches;
const getServerDesktopAdminSnapshot = () => false;

const sectionShortLabels: Record<Locale, Record<AdminSection, string>> = {
  ko: {
    overview: "홈",
    products: "상품",
    inventory: "재고",
    sales: "매출·일마감",
    brands: "브랜드",
    members: "회원",
    coupons: "쿠폰",
    marketing: "마케팅",
    ocr: "입고 OCR",
  },
  en: {
    overview: "Home",
    products: "Products",
    inventory: "Inventory",
    sales: "Sales & close",
    brands: "Brands",
    members: "Members",
    coupons: "Coupons",
    marketing: "Marketing",
    ocr: "Stock-in OCR",
  },
};

const sectionItems: ReadonlyArray<
  Readonly<{ id: AdminSection; label: Readonly<Record<Locale, string>> }>
> = [
  { id: "overview", label: { ko: "운영 현황", en: "Operations overview" } },
  { id: "products", label: { ko: "상품 등록", en: "Product registration" } },
  { id: "inventory", label: { ko: "재고 수정", en: "Stock editing" } },
  { id: "sales", label: { ko: "매출·일마감", en: "Sales & daily close" } },
  { id: "brands", label: { ko: "브랜드", en: "Brands" } },
  { id: "members", label: { ko: "회원", en: "Members" } },
  { id: "coupons", label: { ko: "쿠폰", en: "Coupons" } },
  { id: "marketing", label: { ko: "마케팅", en: "Marketing" } },
  { id: "ocr", label: { ko: "입고 OCR", en: "Stock-in OCR" } },
];

function AdminMenuIcon({
  section,
  cart = false,
}: Readonly<{ section: AdminSection; cart?: boolean }>) {
  const paths: Record<AdminSection, string> = {
    overview: "M3 10 12 3l9 7v11h-6v-7H9v7H3Z",
    products: "M3 4h9l9 9-9 9-9-9V4Zm4 4h.01",
    inventory: "m12 2 10 5v10l-10 5-10-5V7l10-5Zm-10 5 10 5 10-5M12 12v10M7 4.5l10 5",
    sales: "M4 21V13h4v8m4 0V7h4v14m4 0V3",
    brands:
      "m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9Z",
    members:
      "M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 21v-3a5 5 0 0 1 5-5h6a5 5 0 0 1 5 5v3Z",
    coupons: "M3 5h18v5a3 3 0 0 0 0 6v4H3v-4a3 3 0 0 0 0-6V5Zm11 1v3m0 3v2m0 3v2",
    marketing: "M3 10v5h4l11 5V4L7 10H3Zm4 5 2 7h4l-2-5M22 9v6",
    ocr: "M5 3h10l4 4v14H5V3Zm10 0v5h4M8 12h8m-8 4h8",
  };
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path
        d={
          cart
            ? "M2 3h3l3 13h11l3-10H6M10 21a1 1 0 1 0 0-2 1 1 0 0 0 0 2Zm8 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z"
            : paths[section]
        }
      />
    </svg>
  );
}

/** Display-only fallback: never write the example URL into an editor or API draft. */
function AdminProductImage({
  alt,
  className = "",
  compact = false,
  src,
}: Readonly<{ alt: string; className?: string; compact?: boolean; src?: string }>) {
  const { locale } = useLocale();
  const isKorean = locale === "ko";
  const original = src?.trim() ?? "";
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const [failedExampleFor, setFailedExampleFor] = useState<string | null>(null);
  const isExample =
    !original ||
    original === "/images/product-placeholder.svg" ||
    original === "/images/admin-board-example.png" ||
    failedSrc === original;
  const exampleFailed = isExample && failedExampleFor === original;
  return (
    <span
      className={`${styles.adminProductImage} ${className}`}
      data-example={isExample || undefined}
      data-compact={compact || undefined}
    >
      {!exampleFailed ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          alt={
            isExample
              ? isKorean
                ? "상품 이미지 없음 · 보드 예시 이미지"
                : "No product image · example board image"
              : alt
          }
          onError={() => {
            if (isExample) setFailedExampleFor(original);
            else setFailedSrc(original);
          }}
          src={isExample ? "/images/admin-board-example.png" : original}
        />
      ) : null}
      {isExample ? (
        <span
          className={styles.exampleImageLabel}
          title={isKorean ? "이미지 없음 · 예시 이미지" : "No image · example image"}
        >
          {compact
            ? isKorean
              ? "예시"
              : "Example"
            : isKorean
              ? "이미지 없음 · 예시 이미지"
              : "No image · example image"}
        </span>
      ) : null}
    </span>
  );
}

const emptyProductDraft: AdminProductDraft = {
  name: "",
  brand: "",
  category: "Deck",
  sku: "",
  price: "",
  compareAtPrice: "",
  stock: "",
  imageUrl: "/images/product-placeholder.svg",
  sizes: "",
  description: "",
  // 실수로 미검토 상품이 고객에게 노출되지 않도록 새 상품은 초안으로 시작합니다.
  isVisible: false,
  isFeatured: false,
};

const moneyFormatter = new Intl.NumberFormat("ko-KR", {
  style: "currency",
  currency: "KRW",
  maximumFractionDigits: 0,
});

/** API 어댑터는 상위에서 주입하며, 이 파일은 브라우저 UI·임시 초안만 책임집니다. */
export function AdminDashboard({
  actions,
}: Readonly<{ actions?: AdminDashboardActions }>) {
  const { isAuthenticated, isAvailable, status, user } = useAuth();
  const { copy } = useLocale();

  if (!isAvailable) {
    return (
      <AdminAccessPanel
        eyebrow={copy.adminAccessEyebrow}
        title={copy.adminAuthSetupRequired}
        description={copy.adminAuthSetupDescription}
        loadingLabel={copy.adminCheckingPermissionsLoading}
      />
    );
  }

  if (status === "initializing") {
    return (
      <AdminAccessPanel
        eyebrow={copy.adminAccessEyebrow}
        title={copy.adminCheckingPermissions}
        description={copy.adminCheckingPermissionsDescription}
        loading
        loadingLabel={copy.adminCheckingPermissionsLoading}
      />
    );
  }

  if (!isAuthenticated || !user) {
    return (
      <AdminAccessPanel
        action={
          <Link href="/login" onClick={() => rememberAuthReturnPath()}>
            {copy.adminLoginAction}
          </Link>
        }
        eyebrow={copy.adminAccessEyebrow}
        title={copy.adminLoginRequired}
        description={copy.adminLoginRequiredDescription}
        loadingLabel={copy.adminCheckingPermissionsLoading}
      />
    );
  }

  if (!user.groups.includes(ADMIN_GROUP)) {
    return (
      <AdminAccessPanel
        action={<Link href="/account">{copy.adminGoToAccount}</Link>}
        eyebrow={copy.adminAccessDeniedEyebrow}
        title={copy.adminAccessDenied}
        description={copy.adminAccessDeniedDescription}
        loadingLabel={copy.adminCheckingPermissionsLoading}
      />
    );
  }

  return (
    <AdminWorkspace
      actions={actions}
      adminName={user.displayName ?? user.email ?? user.username}
      key={user.sub}
    />
  );
}

/** 정적 export에서 노출 가능한 UX 가드입니다. 실제 데이터 API도 admin group을 별도 검증해야 합니다. */
function AdminAccessPanel({
  action,
  description,
  eyebrow,
  loading = false,
  loadingLabel,
  title,
}: Readonly<{
  action?: React.ReactNode;
  description: string;
  eyebrow: string;
  loading?: boolean;
  loadingLabel: string;
  title: string;
}>) {
  const { copy } = useLocale();
  const storeReturnPath = useSyncExternalStore(
    subscribeToAdminSection,
    getAdminStoreReturnSnapshot,
    getServerAdminStoreReturnSnapshot,
  );

  return (
    <section className={styles.accessPage} aria-live="polite">
      <div className={styles.accessTopBar}>
        <Link className={styles.homeLink} href={storeReturnPath}>
          {copy.adminBackToStore}
        </Link>
      </div>
      <section className={styles.accessPanel}>
        <p className={styles.eyebrow}>{eyebrow}</p>
        <h1>{title}</h1>
        <p>{description}</p>
        {loading ? <span className={styles.loadingLine}>{loadingLabel}</span> : null}
        {action ? <div className={styles.accessAction}>{action}</div> : null}
      </section>
    </section>
  );
}

/** admin 그룹 확인 뒤에만 마운트되는 인터랙티브 운영 워크스페이스입니다. */
function AdminWorkspace({
  actions,
  adminName,
}: Readonly<{
  actions?: AdminDashboardActions;
  adminName: string;
}>) {
  const { copy, locale, setLocale } = useLocale();
  const isKorean = locale === "ko";
  const { user: currentAdmin } = useAuth();
  const storeReturnPath = useSyncExternalStore(
    subscribeToAdminSection,
    getAdminStoreResumeSnapshot,
    getServerAdminStoreReturnSnapshot,
  );
  const languageLabels =
    locale === "en" ? { ko: "KOR", en: "ENG" } : { ko: "한국어", en: "영어" };
  const activeSection = useSyncExternalStore(
    subscribeToAdminSection,
    getAdminSectionSnapshot,
    getServerAdminSectionSnapshot,
  );
  const [isOpsMenuOpen, setIsOpsMenuOpen] = useState(false);
  const isDesktopAdmin = useSyncExternalStore(
    subscribeToAdminViewport,
    getDesktopAdminSnapshot,
    getServerDesktopAdminSnapshot,
  );
  const isMenuVisible = isDesktopAdmin || isOpsMenuOpen;
  const isMenuButtonHidden = useHeaderScroll(isDesktopAdmin || isOpsMenuOpen);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const menuDrawerRef = useRef<HTMLDivElement>(null);
  const [productEditors] = useState(() => new ProductEditorSessions());
  const productEditor = useSyncExternalStore(
    productEditors.subscribe,
    productEditors.getSnapshot,
    productEditors.getServerSnapshot,
  );
  const productView = productEditor?.mode ?? "list";
  const productDraft = productEditor?.draft ?? emptyProductDraft;
  const [localProducts, setLocalProducts] = useState<readonly AdminCatalogListItem[]>(
    [],
  );
  const [isLoadingProducts, setIsLoadingProducts] = useState(false);
  const [catalogLoadFailed, setCatalogLoadFailed] = useState(false);
  const [isDeletingProducts, setIsDeletingProducts] = useState(false);
  const [productNotice, setProductNotice] = useState<Notice>(null);
  const [isSavingProduct, setIsSavingProduct] = useState(false);
  const [savingProductEditorId, setSavingProductEditorId] = useState<string | null>(
    null,
  );
  const [inventoryNotice, setInventoryNotice] = useState<Notice>(null);
  const [inventorySavingIds, setInventorySavingIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const inventoryBusyRef = useRef(new Set<string>());
  const [brandName, setBrandName] = useState("");
  const [brandMemo, setBrandMemo] = useState("");
  const [localBrands, setLocalBrands] = useState<string[]>([]);
  const [brandNotice, setBrandNotice] = useState<Notice>(null);
  const [isSavingBrand, setIsSavingBrand] = useState(false);
  const brandBusyRef = useRef(false);
  const [couponName, setCouponName] = useState("");
  const [couponCode, setCouponCode] = useState("");
  const [couponType, setCouponType] = useState<"percent" | "amount">("percent");
  const [couponValue, setCouponValue] = useState("");
  const [couponExpiresAt, setCouponExpiresAt] = useState("");
  const [couponNotice, setCouponNotice] = useState<Notice>(null);
  const [isSavingCoupon, setIsSavingCoupon] = useState(false);
  const couponBusyRef = useRef(false);
  const [campaignTitle, setCampaignTitle] = useState("");
  const [campaignBody, setCampaignBody] = useState("");
  const [campaignChannels, setCampaignChannels] = useState<
    Record<MarketingChannel, boolean>
  >({ email: true, sms: false, push: false });
  const [campaignNotice, setCampaignNotice] = useState<Notice>(null);
  const [isSavingCampaign, setIsSavingCampaign] = useState(false);
  const campaignBusyRef = useRef(false);
  const [members, setMembers] = useState<readonly AdminMember[]>([]);
  const [memberNotice, setMemberNotice] = useState<Notice>(null);
  const [isLoadingMembers, setIsLoadingMembers] = useState(false);
  const [membersLoaded, setMembersLoaded] = useState(false);
  const [memberLoadFailed, setMemberLoadFailed] = useState(false);
  const [memberNeedsRefresh, setMemberNeedsRefresh] = useState(false);
  const [isSavingMemberGroup, setIsSavingMemberGroup] = useState(false);
  const [memberRevision, setMemberRevision] = useState(0);
  const memberBusyRef = useRef(false);
  const [ocrFile, setOcrFile] = useState<File | null>(null);
  const [ocrState, setOcrState] = useState<OcrState>("idle");
  const [ocrRawText, setOcrRawText] = useState("");
  const [ocrRows, setOcrRows] = useState<AdminOcrReviewRow[]>([]);
  const [ocrNotice, setOcrNotice] = useState<Notice>(null);
  const [isSavingOcr, setIsSavingOcr] = useState(false);
  const [isApplyingOcrInventory, setIsApplyingOcrInventory] = useState(false);
  const [ocrJobId, setOcrJobId] = useState<string | null>(null);
  const [ocrVersion, setOcrVersion] = useState<number | null>(null);
  const [ocrAnalysis, setOcrAnalysis] = useState<OcrTableAnalysis | undefined>();
  const [ocrInventoryJob, setOcrInventoryJob] =
    useState<AdminOcrRecognitionResult | null>(null);
  const ocrInventoryAttempts = useMemo(() => new OcrInventoryAttemptStore(), []);
  const ocrFileSelectionRef = useRef(0);
  const ocrRequestGenerationRef = useRef(0);
  const ocrCurrentJobRef = useRef<{ jobId: string; version: number } | null>(null);
  const catalogRequestGenerationRef = useRef(0);
  const catalogMutationGenerationRef = useRef(0);
  const productWorkspaceActiveRef = useRef(true);
  const [operationActivities, setOperationActivities] = useState<
    readonly OperationActivity[]
  >([]);
  const recordActivity = (activity: Omit<OperationActivity, "at">) => {
    if (!productWorkspaceActiveRef.current) return;
    const next = { ...activity, at: operationEventTime() };
    setOperationActivities((current) =>
      [next, ...current.filter((item) => item.key !== next.key)].slice(0, 12),
    );
  };
  const recordProductActivity = (
    editorId: string,
    status: OperationActivity["status"],
    detail: LocalizedText = {
      ko: "입력한 상품 정보가 아직 저장되지 않았습니다.",
      en: "The product details you entered are not saved yet.",
    },
  ) =>
    recordActivity({
      key: `product:${editorId}`,
      section: "products",
      status,
      detail,
      ...(status === "working" || status === "attention" ? { editorId } : {}),
    });
  const removePendingProductActivity = (editorId: string) =>
    setOperationActivities((current) =>
      current.filter(
        (item) =>
          item.editorId !== editorId ||
          (item.status !== "working" && item.status !== "attention"),
      ),
    );
  const markActivityWorking = (section: "brands" | "coupons" | "marketing") =>
    recordActivity({
      key: section,
      section,
      status: "working",
      detail: {
        ko: "입력 내용을 작성 중입니다. 변경 내용은 아직 저장되지 않았습니다.",
        en: "Editing in progress. Changes are not saved yet.",
      },
    });

  useEffect(() => {
    productWorkspaceActiveRef.current = true;
    return () => {
      productWorkspaceActiveRef.current = false;
      ocrRequestGenerationRef.current += 1;
      productEditors.dispose();
    };
  }, [productEditors]);

  const refreshCatalogProducts = async () => {
    if (!actions?.listCatalogProducts) {
      return null;
    }

    const requestGeneration = ++catalogRequestGenerationRef.current;
    const mutationGeneration = catalogMutationGenerationRef.current;
    const current = () =>
      requestGeneration === catalogRequestGenerationRef.current &&
      mutationGeneration === catalogMutationGenerationRef.current;
    setIsLoadingProducts(true);
    setCatalogLoadFailed(false);

    try {
      const products = await actions.listCatalogProducts();
      if (!current()) return null;
      setLocalProducts(products);
      return products;
    } catch {
      if (!current()) return null;
      setCatalogLoadFailed(true);
      setProductNotice({
        kind: "error",
        message: {
          ko: "상품 목록을 불러오지 못했습니다. 관리자 권한과 API를 확인해 주세요.",
          en: "Could not load the product list. Check admin access and the API.",
        },
      });
      return null;
    } finally {
      if (requestGeneration === catalogRequestGenerationRef.current)
        setIsLoadingProducts(false);
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mount fetch; generation refs discard stale responses.
    void refreshCatalogProducts();
    // actions 객체는 getAccessToken 참조로 바뀌므로 listCatalogProducts 존재 여부만 의존합니다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Boolean(actions?.listCatalogProducts)]);

  useEffect(() => {
    if (!isOpsMenuOpen || isDesktopAdmin) {
      return;
    }

    const focusFrame = window.requestAnimationFrame(() => {
      menuDrawerRef.current
        ?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')
        ?.focus();
    });
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setIsOpsMenuOpen(false);
        menuButtonRef.current?.focus();
      } else if (event.key === "Tab") {
        const focusable = menuDrawerRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled):not([tabindex="-1"]), a[href]:not([tabindex="-1"]), [tabindex="0"]',
        );
        if (!focusable?.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [isOpsMenuOpen, isDesktopAdmin]);

  const previewPrice = parsePositiveNumber(productDraft.price);
  const previewCompareAtPrice = parsePositiveNumber(productDraft.compareAtPrice);
  const previewSizes = productDraft.sizes
    .split(",")
    .map((size) => size.trim())
    .filter(Boolean);
  const previewName =
    productDraft.name.trim() ||
    (isKorean ? "상품명을 입력하세요" : "Enter a product name");

  const selectedChannelLabels = useMemo(
    () =>
      (Object.entries(campaignChannels) as Array<[MarketingChannel, boolean]>)
        .filter(([, selected]) => selected)
        .map(([channel]) => channelLabel(channel)),
    [campaignChannels],
  );

  const moveSectionFocus = (
    event: KeyboardEvent<HTMLButtonElement>,
    currentSection: AdminSection,
  ) => {
    const currentIndex = sectionItems.findIndex(
      (section) => section.id === currentSection,
    );
    let nextIndex: number | null = null;

    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      nextIndex = (currentIndex + 1) % sectionItems.length;
    } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
      nextIndex = (currentIndex - 1 + sectionItems.length) % sectionItems.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = sectionItems.length - 1;
    }

    if (nextIndex === null) {
      return;
    }

    event.preventDefault();
    const nextSection = sectionItems[nextIndex];
    selectSection(nextSection.id, { keepMenuOpen: true });
    window.requestAnimationFrame(() => {
      document.getElementById(`admin-tab-${nextSection.id}`)?.focus();
    });
  };

  const selectSection = (
    section: AdminSection,
    options?: Readonly<{ productView?: "create"; keepMenuOpen?: boolean }>,
  ) => {
    if (section === "products" && options?.productView === "create") {
      openNewProductEditor();
    } else {
      navigateToAdminSection(section);
    }
    if (!options?.keepMenuOpen) {
      setIsOpsMenuOpen(false);
      if (!isDesktopAdmin) {
        window.requestAnimationFrame(() => {
          document.getElementById(`admin-panel-${section}`)?.focus();
        });
      }
    }
  };

  const openNewProductEditor = () => {
    const id = productEditors.open("create", {
      ...emptyProductDraft,
      sku: createProductSku(),
    });
    setProductNotice(null);
    recordProductActivity(id, "working");
    navigateToAdminProductEditor(id);
  };

  const finishProductEditor = (id: string, productId?: string) => {
    const isCurrentEditor = getAdminProductEditorId() === id;
    if (productId) productEditors.invalidateProducts(new Set([productId]));
    productEditors.remove(id);
    if (isCurrentEditor) navigateToAdminSection("products", { replace: true });
  };

  const rememberLocalProduct = (productDraft: AdminProductDraft, name: string) => {
    const previewPrice = parsePositiveNumber(productDraft.price);
    const previewCompareAtPrice = parsePositiveNumber(productDraft.compareAtPrice);
    const stockValue = Number.parseInt(productDraft.stock, 10);
    const nextItem: AdminCatalogListItem = {
      id: productDraft.productId ?? `local_${operationEventTime()}`,
      name,
      brand: productDraft.brand.trim() || "—",
      category: productDraft.category,
      price: previewPrice,
      stock: Number.isFinite(stockValue) && stockValue >= 0 ? stockValue : 0,
      isVisible: productDraft.isVisible,
      version: productDraft.version ?? 0,
      sizes: productDraft.sizes,
      description: productDraft.description,
      isFeatured: productDraft.isFeatured,
      ...(productDraft.sku.trim() ? { sku: productDraft.sku.trim() } : {}),
      ...(productDraft.imageUrl ? { imageUrl: productDraft.imageUrl } : {}),
      ...(previewCompareAtPrice > 0 ? { compareAtPrice: previewCompareAtPrice } : {}),
      ...(productDraft.nameI18n ? { nameI18n: productDraft.nameI18n } : {}),
      ...(productDraft.descriptionI18n
        ? { descriptionI18n: productDraft.descriptionI18n }
        : {}),
    };

    setLocalProducts((current) => [
      nextItem,
      ...current.filter((product) => product.id !== nextItem.id),
    ]);
  };

  const openProductEditor = (
    product: AdminCatalogListItem,
    mode: "create" | "edit",
  ) => {
    const id = productEditors.open(mode, {
      name: product.name,
      brand: product.brand === "—" ? "" : product.brand,
      category: product.category,
      sku: product.sku ?? "",
      price: String(product.price || ""),
      compareAtPrice:
        typeof product.compareAtPrice === "number"
          ? String(product.compareAtPrice)
          : "",
      stock: String(product.stock),
      imageUrl: product.imageUrl ?? "/images/product-placeholder.svg",
      sizes: product.sizes,
      description: product.description,
      isVisible: product.isVisible,
      isFeatured: product.isFeatured,
      ...(mode === "edit" && product.version > 0
        ? { productId: product.id, version: product.version }
        : mode === "edit"
          ? { productId: product.id }
          : {}),
      ...(product.nameI18n ? { nameI18n: product.nameI18n } : {}),
      ...(product.descriptionI18n ? { descriptionI18n: product.descriptionI18n } : {}),
    });
    setProductNotice(null);
    navigateToAdminProductEditor(id);
  };

  const updateProductText = (
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
  ) => {
    if (productEditor) {
      productEditors.updateDraft(productEditor.id, (current) => ({
        ...current,
        [field]: value,
      }));
      recordProductActivity(productEditor.id, "working");
    }
  };

  const updateProductToggle = (field: "isVisible" | "isFeatured", value: boolean) => {
    if (productEditor) {
      productEditors.updateDraft(productEditor.id, (current) => ({
        ...current,
        [field]: value,
      }));
      recordProductActivity(productEditor.id, "working");
    }
  };

  const handleProductImageChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];

    if (!file || !productEditor) {
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    productEditors.setImage(productEditor.id, file, objectUrl);
    recordProductActivity(productEditor.id, "working");
    setProductNotice({
      kind: "success",
      message: {
        ko: "이미지가 미리보기에 반영되었습니다. 아직 저장되지 않았습니다.",
        en: "The image is shown in the preview. It is not saved yet.",
      },
    });
  };

  const handleProductSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const savingEditor = productEditors.getSnapshot();
    if (!savingEditor || isSavingProduct) return;
    const setEditorNotice = (notice: Notice) => {
      if (
        notice?.kind === "error" &&
        productWorkspaceActiveRef.current &&
        productEditors.has(savingEditor.id)
      )
        recordProductActivity(savingEditor.id, "attention", {
          ko: "저장 결과 또는 입력 내용을 확인해야 합니다. 완료로 처리하지 않았습니다.",
          en: "Check the save result or your input. This was not marked as done.",
        });
      if (
        productWorkspaceActiveRef.current &&
        getAdminProductEditorId() === savingEditor.id &&
        productEditors.has(savingEditor.id)
      )
        setProductNotice(notice);
    };
    const productDraft = savingEditor.draft;
    const previewPrice = parsePositiveNumber(productDraft.price);
    const previewCompareAtPrice = parsePositiveNumber(productDraft.compareAtPrice);
    const previewSizes = productDraft.sizes
      .split(",")
      .map((size) => size.trim())
      .filter(Boolean);
    const name = productDraft.name.trim();

    if (!name || !productDraft.brand.trim() || previewPrice <= 0) {
      setEditorNotice({
        kind: "error",
        message: {
          ko: "상품명, 브랜드, 판매가를 입력한 뒤 저장해 주세요.",
          en: "Enter the product name, brand and price, then save.",
        },
      });
      return;
    }

    if (productDraft.isVisible && previewSizes.length === 0) {
      setEditorNotice({
        kind: "error",
        message: {
          ko: "스토어 공개 준비 상품은 최소 한 개의 옵션/사이즈가 필요합니다.",
          en: "A product ready for the store needs at least one option or size.",
        },
      });
      return;
    }

    const optionError = validateProductOptions(productDraft.sizes);
    if (optionError) {
      setEditorNotice({
        kind: "error",
        message:
          optionError === "too-many-options"
            ? {
                ko: "옵션은 최대 20개까지 저장할 수 있습니다.",
                en: "You can save up to 20 options.",
              }
            : {
                ko: "각 옵션은 50자 이하로 입력해 주세요.",
                en: "Keep each option to 50 characters or fewer.",
              },
      });
      return;
    }

    if (previewCompareAtPrice > 0 && previewCompareAtPrice <= previewPrice) {
      setEditorNotice({
        kind: "error",
        message: {
          ko: "기존 정가는 판매가보다 커야 합니다. 판매가를 낮추거나 ‘기존 정가 제거’로 삭제를 확인한 뒤 저장해 주세요.",
          en: "The original price must be higher than the sale price. Lower the sale price, or confirm removal with ‘Remove original price’, then save.",
        },
      });
      return;
    }

    if (productDraft.imageUrl.startsWith("blob:")) {
      if (!actions?.uploadProductImage || !savingEditor.imageFile) {
        setEditorNotice({
          kind: "error",
          message: {
            ko: "상품 이미지 저장소 API가 아직 연결되지 않았습니다. CDK 배포 후 다시 시도해 주세요.",
            en: "The product image storage API is not connected yet. Try again after the CDK deploy.",
          },
        });
        return;
      }
    }

    if (
      productDraft.isVisible &&
      actions?.saveProductDraft &&
      !window.confirm(
        isKorean
          ? `“${name}”을 공개 상태로 저장할까요? 저장하면 상품 정보가 스토어에 표시됩니다.`
          : `Save “${name}” as public? Once saved, the product appears in the store.`,
      )
    ) {
      return;
    }

    const descriptionLines = productDraft.description
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    setSavingProductEditorId(savingEditor.id);
    setIsSavingProduct(true);

    let imageUrlForSave = productDraft.imageUrl;

    try {
      if (imageUrlForSave.startsWith("blob:") && savingEditor.imageFile) {
        imageUrlForSave = await actions!.uploadProductImage!(savingEditor.imageFile);
        productEditors.finishImageUpload(savingEditor.id, imageUrlForSave);
      }
    } catch {
      setIsSavingProduct(false);
      setEditorNotice({
        kind: "error",
        message: {
          ko: "상품 이미지를 저장소에 올리지 못했습니다. 파일 형식(JPEG/PNG/WebP/GIF)과 6MB 이하인지 확인해 주세요.",
          en: "Could not upload the product image. Check that it is JPEG/PNG/WebP/GIF and 6MB or smaller.",
        },
      });
      return;
    }

    let translatedDraft: AdminProductDraft;

    if (!productEditors.has(savingEditor.id)) {
      setIsSavingProduct(false);
      return;
    }

    try {
      const i18nFields = await buildProductI18nFields({
        name,
        descriptionLines,
        sourceLocale: locale,
      });

      translatedDraft = {
        ...productDraft,
        name: i18nFields.name,
        description: i18nFields.description.join("\n"),
        imageUrl: imageUrlForSave,
        nameI18n: i18nFields.nameI18n,
        descriptionI18n: i18nFields.descriptionI18n,
        sourceLocale: locale,
      };
    } catch (error) {
      setIsSavingProduct(false);
      setEditorNotice({
        kind: "error",
        message:
          error instanceof TranslateError
            ? {
                ko: error.message,
                en:
                  error.code === "TRANSLATE_NETWORK"
                    ? "Could not reach the translation server. Try again shortly."
                    : "Could not auto-translate the product name and description. Try again shortly.",
              }
            : {
                ko: "상품명·설명을 자동 번역하지 못했습니다. 잠시 후 다시 시도해 주세요.",
                en: "Could not auto-translate the product name and description. Try again shortly.",
              },
      });
      return;
    }

    if (!productEditors.has(savingEditor.id)) {
      setIsSavingProduct(false);
      return;
    }

    if (!actions?.saveProductDraft) {
      rememberLocalProduct({ ...productDraft, imageUrl: imageUrlForSave }, name);
      recordProductActivity(savingEditor.id, "draft", {
        ko: "이 화면에만 임시 보관했습니다. 서버 미저장 · 스토어 미공개",
        en: "Kept on this screen only. Not saved to the server · Not in the store",
      });
      setEditorNotice({
        kind: "success",
        message: {
          ko: `“${name}”을 이 브라우저의 임시 목록에만 보관했습니다. 서버에 저장하거나 스토어에 공개하지 않았으며 새로고침하면 사라집니다.`,
          en: `Kept “${name}” only in this browser’s temporary list. It was not saved to the server or published, and it disappears on refresh.`,
        },
      });
      finishProductEditor(savingEditor.id, productDraft.productId);
      setIsSavingProduct(false);
      return;
    }

    try {
      await actions.saveProductDraft(translatedDraft);

      if (!productWorkspaceActiveRef.current) return;

      if (actions.listCatalogProducts) {
        await refreshCatalogProducts();
      } else {
        rememberLocalProduct({ ...productDraft, imageUrl: imageUrlForSave }, name);
      }

      if (!productWorkspaceActiveRef.current) return;

      recordProductActivity(
        savingEditor.id,
        productDraft.isVisible ? "complete" : "draft",
        productDraft.isVisible
          ? {
              ko: "서버가 상품 공개 저장을 확인했습니다.",
              en: "The server confirmed the public product save.",
            }
          : {
              ko: "상품을 비공개로 서버에 저장했습니다. 스토어 미공개",
              en: "Saved the product to the server as private. Not in the store",
            },
      );
      setEditorNotice({
        kind: "success",
        message: productDraft.isVisible
          ? {
              ko: "상품을 공개 상태로 저장했습니다. 이미지와 한/영 문구가 함께 반영되었습니다.",
              en: "Saved the product as public. The image and Korean/English text were applied.",
            }
          : {
              ko: "상품을 비공개로 저장했습니다. 고객에게는 표시되지 않습니다.",
              en: "Saved the product as private. Customers will not see it.",
            },
      });
      finishProductEditor(savingEditor.id, productDraft.productId);
    } catch {
      setEditorNotice({
        kind: "error",
        message: {
          ko: "상품을 저장하지 못했습니다. 네트워크와 관리자 권한을 확인해 주세요.",
          en: "Could not save the product. Check the network and admin access.",
        },
      });
    } finally {
      setIsSavingProduct(false);
    }
  };

  const handleDeleteProducts = async (
    items: ReadonlyArray<Readonly<{ id: string; version: number }>>,
  ) => {
    if (items.length === 0 || isDeletingProducts) {
      return;
    }

    const confirmed = window.confirm(
      items.length === 1
        ? isKorean
          ? "선택한 상품을 삭제할까요? 이 작업은 되돌릴 수 없습니다."
          : "Delete the selected product? This cannot be undone."
        : isKorean
          ? `선택한 ${items.length}개 상품을 삭제할까요? 이 작업은 되돌릴 수 없습니다.`
          : `Delete the ${items.length} selected products? This cannot be undone.`,
    );

    if (!confirmed) {
      return;
    }

    const apiItems = items.filter((item) => item.version > 0);
    const localOnlyIds = new Set(
      items.filter((item) => item.version <= 0).map((item) => item.id),
    );

    setIsDeletingProducts(true);

    try {
      if (apiItems.length > 0) {
        if (!actions?.deleteCatalogProducts) {
          setProductNotice({
            kind: "error",
            message: {
              ko: "상품 삭제 API가 아직 연결되지 않았습니다.",
              en: "The product delete API is not connected yet.",
            },
          });
          return;
        }

        await actions.deleteCatalogProducts(apiItems);

        if (actions.listCatalogProducts) {
          await refreshCatalogProducts();
        }
      }

      if (localOnlyIds.size > 0) {
        setLocalProducts((current) =>
          current.filter((product) => !localOnlyIds.has(product.id)),
        );
      }

      productEditors.invalidateProducts(new Set(items.map((item) => item.id)));

      setProductNotice({
        kind: "success",
        message:
          items.length === 1
            ? { ko: "상품을 삭제했습니다.", en: "Deleted the product." }
            : {
                ko: `${items.length}개 상품을 삭제했습니다.`,
                en: `Deleted ${items.length} products.`,
              },
      });
    } catch {
      setProductNotice({
        kind: "error",
        message: {
          ko: "상품을 삭제하지 못했습니다. 관리자 권한과 API를 확인해 주세요.",
          en: "Could not delete the products. Check admin access and the API.",
        },
      });
    } finally {
      setIsDeletingProducts(false);
    }
  };

  const refreshInventoryProducts = async () => {
    setInventoryNotice(null);
    const products = await refreshCatalogProducts();
    if (!products) {
      setInventoryNotice({
        kind: "error",
        message: {
          ko: "최신 재고를 불러오지 못했습니다. 연결을 확인하고 다시 조회해 주세요.",
          en: "Could not load the latest stock. Check the connection and load it again.",
        },
      });
    }
    return products;
  };

  const handleInventoryStockChange = async (
    productId: string,
    nextStock: number,
    expected: Readonly<{ version: number; stock: number }>,
  ): Promise<AdminCatalogListItem | null> => {
    const product = localProducts.find((item) => item.id === productId);

    if (!product || inventoryBusyRef.current.has(productId)) {
      return null;
    }
    if (product.version !== expected.version || product.stock !== expected.stock) {
      setInventoryNotice({
        kind: "error",
        message: {
          ko: "상품 재고가 변경되었습니다. 최신 수량을 다시 확인해 주세요.",
          en: "The product stock has changed. Check the latest quantity again.",
        },
      });
      return null;
    }
    if (!Number.isInteger(nextStock) || nextStock < 0 || nextStock > 1_000_000) {
      setInventoryNotice({
        kind: "error",
        message: {
          ko: "재고는 0~1,000,000 사이의 정수로 입력해 주세요.",
          en: "Enter stock as a whole number from 0 to 1,000,000.",
        },
      });
      return null;
    }

    const clamped = Math.max(0, Math.min(1_000_000, Math.trunc(nextStock)));

    if (clamped === product.stock) {
      return product;
    }

    if (!actions?.updateProductStock || product.version < 1) {
      const updated = { ...product, stock: clamped };
      catalogMutationGenerationRef.current += 1;
      setLocalProducts((current) =>
        current.map((item) => (item.id === productId ? updated : item)),
      );
      setInventoryNotice({
        kind: "success",
        message: {
          ko: `${product.name} 수량을 이 화면에서만 ${clamped}개로 변경했습니다. 서버 재고에는 반영되지 않았습니다.`,
          en: `Changed ${product.name} to ${clamped} on this screen only. Server stock was not updated.`,
        },
      });
      recordActivity({
        key: `inventory:${productId}`,
        section: "inventory",
        status: "draft",
        detail: {
          ko: "이 화면의 수량만 변경했습니다. 서버 재고 미반영",
          en: "Changed the quantity on this screen only. Server stock not updated",
        },
      });
      return updated;
    }

    inventoryBusyRef.current.add(productId);
    setInventorySavingIds((current) => new Set(current).add(productId));
    setInventoryNotice(null);

    try {
      const updated = await actions.updateProductStock({
        id: product.id,
        version: product.version,
        stock: clamped,
      });
      catalogMutationGenerationRef.current += 1;

      setLocalProducts((current) =>
        current.map((item) =>
          item.id === productId && item.version <= updated.version ? updated : item,
        ),
      );
      setInventoryNotice({
        kind: "success",
        message: {
          ko: `${updated.name} 재고를 ${updated.stock}개로 저장했습니다.`,
          en: `Saved ${updated.name} stock as ${updated.stock}.`,
        },
      });
      recordActivity({
        key: `inventory:${productId}`,
        section: "inventory",
        status: "complete",
        detail: {
          ko: "서버가 재고 수량 변경을 확인했습니다.",
          en: "The server confirmed the stock change.",
        },
      });
      return updated;
    } catch {
      const products = await refreshCatalogProducts();
      recordActivity({
        key: `inventory:${productId}`,
        section: "inventory",
        status: "attention",
        detail: {
          ko: "재고 변경 결과를 확인해야 합니다. 중복 반영하지 마세요.",
          en: "Check the stock change result. Do not apply it twice.",
        },
      });
      setInventoryNotice({
        kind: "error",
        message: products
          ? {
              ko: "재고 변경 결과를 다시 확인해야 합니다. 최신 목록을 불러왔으니 수량을 검토한 뒤 다시 시작해 주세요.",
              en: "Check the stock change result again. The latest list is loaded, so review the quantity and start again.",
            }
          : {
              ko: "재고 변경 결과와 최신 수량을 확인하지 못했습니다. 중복 저장하지 말고 새로고침으로 결과를 확인해 주세요.",
              en: "Could not confirm the stock change or the latest quantity. Do not save again; refresh to check the result.",
            },
      });
      return null;
    } finally {
      inventoryBusyRef.current.delete(productId);
      setInventorySavingIds((current) => {
        const next = new Set(current);
        next.delete(productId);
        return next;
      });
    }
  };

  /**
   * 상세사이즈 모달 저장: 상품 저장과 별도로 즉시 서버에 반영합니다.
   * 폼이 기준으로 삼은 version으로만 보내므로, 그 사이 다른 곳에서 바뀌었으면 409로 멈추고 덮어쓰지 않습니다.
   * 직접 받은 성공 응답일 때만 폼 version을 올려 이후 상품 저장이 409가 나지 않게 합니다.
   */
  const saveProductDeckSpec = async (deckSpec: DeckSpec | null) => {
    const editor = productEditor;
    const productId = editor?.draft.productId;
    const version = editor?.draft.version;

    if (!actions?.updateProductDeckSpec || !editor || !productId || !version) {
      throw new Error("DECK_SPEC_UNAVAILABLE");
    }

    let updated: AdminCatalogListItem;
    try {
      updated = await actions.updateProductDeckSpec({
        id: productId,
        version,
        deckSpec,
      });
    } catch (error) {
      // Success is never guessed from a re-read; a conflict only refreshes the list and asks to reopen.
      if (error instanceof AdminApiRequestError && error.status === 409) {
        void refreshCatalogProducts();
        if (getAdminProductEditorId() === editor.id)
          setProductNotice({
            kind: "error",
            message: {
              ko: "다른 곳에서 이 상품이 바뀌었거나 이전 상세사이즈 저장이 이미 반영됐습니다. 편집을 닫고 다시 열어 최신 값을 확인한 뒤 저장해 주세요.",
              en: "This product changed elsewhere, or an earlier size spec save was already applied. Close and reopen the editor, check the latest values, then save.",
            },
          });
      }
      throw error;
    }
    catalogMutationGenerationRef.current += 1;
    setLocalProducts((current) =>
      current.map((item) =>
        item.id === updated.id && item.version <= updated.version ? updated : item,
      ),
    );
    // 버튼 옆 요약이 바뀌는 것으로 저장을 알립니다. 상품 저장 완료 알림(productSaved)과 섞지 않습니다.
    productEditors.updateDraft(editor.id, (current) =>
      current.productId === updated.id && current.version === version
        ? { ...current, version: updated.version }
        : current,
    );
  };

  const resetProductDraft = () => {
    if (productEditor) {
      removePendingProductActivity(productEditor.id);
      const original = localProducts.find(
        (product) => product.id === productEditor.draft.productId,
      );
      productEditors.reset(productEditor.id, {
        ...emptyProductDraft,
        sku:
          productEditor.mode === "create"
            ? createProductSku()
            : productEditor.draft.sku,
        compareAtPrice:
          productEditor.mode === "edit"
            ? original
              ? typeof original.compareAtPrice === "number"
                ? String(original.compareAtPrice)
                : ""
              : productEditor.draft.compareAtPrice
            : "",
      });
    }
    setProductNotice(null);
  };

  const handleBrandSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (brandBusyRef.current) return;
    const normalizedBrand = brandName.trim();

    if (!normalizedBrand) {
      setBrandNotice({
        kind: "error",
        message: { ko: "브랜드명을 입력해 주세요.", en: "Enter a brand name." },
      });
      return;
    }

    if (normalizedBrand.length > 100 || brandMemo.trim().length > 1_000) {
      setBrandNotice({
        kind: "error",
        message: {
          ko: "브랜드명은 100자, 운영 메모는 1,000자까지 입력해 주세요.",
          en: "Keep the brand name to 100 characters and the note to 1,000.",
        },
      });
      return;
    }

    if (
      [...localBrands, ...localProducts.map((product) => product.brand)].some(
        (brand) => brand.trim().toLowerCase() === normalizedBrand.toLowerCase(),
      )
    ) {
      setBrandNotice({
        kind: "error",
        message: {
          ko: "이미 이 화면의 목록에 있는 브랜드명입니다. 목록에서 확인해 주세요.",
          en: "This brand name is already in the list on this screen. Check the list.",
        },
      });
      return;
    }

    const draft: AdminBrandDraft = {
      name: normalizedBrand,
      ...(brandMemo.trim() ? { memo: brandMemo.trim() } : {}),
    };

    const saveToServer = actions?.saveBrandDraft;
    brandBusyRef.current = true;
    try {
      setIsSavingBrand(true);
      if (saveToServer) await saveToServer(draft);
      setLocalBrands((current) => [...current, normalizedBrand]);
      recordActivity({
        key: "brands",
        section: "brands",
        status: saveToServer ? "complete" : "draft",
        detail: saveToServer
          ? {
              ko: "서버가 브랜드 등록을 확인했습니다.",
              en: "The server confirmed the brand registration.",
            }
          : {
              ko: "브랜드를 이 화면에만 추가했습니다. 서버 미저장",
              en: "Added the brand on this screen only. Not saved to the server",
            },
      });
      setBrandNotice({
        kind: "success",
        message: saveToServer
          ? {
              ko: `“${normalizedBrand}” 브랜드를 서버에 등록했습니다.`,
              en: `Registered the brand “${normalizedBrand}” on the server.`,
            }
          : {
              ko: `“${normalizedBrand}” 브랜드명을 이 화면에만 임시 추가했습니다. 서버에는 저장되지 않습니다.`,
              en: `Temporarily added the brand “${normalizedBrand}” on this screen only. It is not saved to the server.`,
            },
      });
      setBrandName("");
      setBrandMemo("");
    } catch {
      recordActivity({
        key: "brands",
        section: "brands",
        status: "attention",
        detail: {
          ko: "브랜드 등록 결과를 확인해야 합니다. 입력은 유지됩니다.",
          en: "Check the brand registration result. Your input is kept.",
        },
      });
      setBrandNotice({
        kind: "error",
        message: {
          ko: "브랜드 등록 결과를 확인하지 못했습니다. 입력은 유지했습니다. 중복 등록하지 않도록 관리자 권한·연결과 서버의 처리 결과를 확인해 주세요.",
          en: "Could not confirm the brand registration. Your input is kept. To avoid a duplicate, check admin access, the connection and the server result.",
        },
      });
    } finally {
      brandBusyRef.current = false;
      setIsSavingBrand(false);
    }
  };

  const handleCouponSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (couponBusyRef.current) return;
    const validationMessage = couponDraftValidation(
      couponName,
      couponCode,
      couponType,
      couponValue,
      couponExpiresAt,
    );
    if (validationMessage) {
      setCouponNotice({
        kind: "error",
        message: validationMessage,
      });
      return;
    }

    const formattedBenefit =
      couponType === "percent"
        ? { ko: `${Number(couponValue)}% 할인`, en: `${Number(couponValue)}% off` }
        : {
            ko: `${moneyFormatter.format(Number(couponValue))} 할인`,
            en: `${moneyFormatter.format(Number(couponValue))} off`,
          };
    const expiresAt = couponExpiryIso(couponExpiresAt);
    const draft: AdminCouponDraft = {
      name: couponName.trim(),
      code: couponCode.trim().toUpperCase(),
      discountType: couponType === "percent" ? "PERCENT" : "AMOUNT",
      discountValue: Number(couponValue),
      ...(expiresAt ? { expiresAt } : {}),
    };

    const saveToServer = actions?.saveCouponDraft;
    couponBusyRef.current = true;
    try {
      setIsSavingCoupon(true);
      setCouponNotice(null);
      if (saveToServer) await saveToServer(draft);
      recordActivity({
        key: "coupons",
        section: "coupons",
        status: "draft",
        detail: saveToServer
          ? {
              ko: "쿠폰 초안을 서버에 저장했습니다. 고객 미발급",
              en: "Saved the coupon draft to the server. Not issued to customers",
            }
          : {
              ko: "쿠폰 초안을 이 화면에만 준비했습니다. 서버 미저장 · 고객 미발급",
              en: "Prepared the coupon draft on this screen only. Not saved to the server · Not issued to customers",
            },
      });
      setCouponNotice({
        kind: "success",
        message: saveToServer
          ? {
              ko: `${draft.code} · ${formattedBenefit.ko} 초안을 서버에 저장했습니다. 아직 고객에게 발급되지 않았습니다.`,
              en: `Saved the ${draft.code} · ${formattedBenefit.en} draft to the server. It has not been issued to customers yet.`,
            }
          : {
              ko: `${draft.code} · ${formattedBenefit.ko} 초안을 이 화면에만 준비했습니다. 서버 저장·고객 발급은 하지 않았습니다.`,
              en: `Prepared the ${draft.code} · ${formattedBenefit.en} draft on this screen only. It was not saved to the server or issued to customers.`,
            },
      });
    } catch {
      recordActivity({
        key: "coupons",
        section: "coupons",
        status: "attention",
        detail: {
          ko: "쿠폰 초안 저장 결과를 확인해야 합니다. 고객 발급 완료가 아닙니다.",
          en: "Check the coupon draft save result. It has not been issued to customers.",
        },
      });
      setCouponNotice({
        kind: "error",
        message: {
          ko: "쿠폰 초안 저장 결과를 확인하지 못했습니다. 입력은 유지했습니다. 중복 저장하지 않도록 서버 처리 결과와 연결을 확인해 주세요.",
          en: "Could not confirm the coupon draft save. Your input is kept. To avoid a duplicate, check the server result and the connection.",
        },
      });
    } finally {
      couponBusyRef.current = false;
      setIsSavingCoupon(false);
    }
  };

  const handleCampaignSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (campaignBusyRef.current) return;
    const validationMessage = campaignDraftValidation(
      campaignTitle,
      campaignBody,
      selectedChannelLabels.length,
    );
    if (validationMessage) {
      setCampaignNotice({
        kind: "error",
        message: validationMessage,
      });
      return;
    }

    const draft: AdminCampaignDraft = {
      title: campaignTitle.trim(),
      body: campaignBody.trim(),
      channels: (Object.entries(campaignChannels) as Array<[MarketingChannel, boolean]>)
        .filter(([, selected]) => selected)
        .map(([channel]) =>
          channel === "email" ? "EMAIL" : channel === "sms" ? "SMS" : "PUSH",
        ),
    };

    const saveToServer = actions?.saveCampaignDraft;
    campaignBusyRef.current = true;
    try {
      setIsSavingCampaign(true);
      setCampaignNotice(null);
      if (saveToServer) await saveToServer(draft);
      recordActivity({
        key: "marketing",
        section: "marketing",
        status: "draft",
        detail: saveToServer
          ? {
              ko: "캠페인 초안을 서버에 저장했습니다. 고객 미발송",
              en: "Saved the campaign draft to the server. Not sent to customers",
            }
          : {
              ko: "캠페인 초안을 이 화면에만 준비했습니다. 서버 미저장 · 고객 미발송",
              en: "Prepared the campaign draft on this screen only. Not saved to the server · Not sent to customers",
            },
      });
      setCampaignNotice({
        kind: "success",
        message: saveToServer
          ? {
              ko: `${selectedChannelLabels.join(" · ")} 캠페인 초안을 서버에 저장했습니다. 고객에게 발송하지 않았습니다.`,
              en: `Saved the ${selectedChannelLabels.join(" · ")} campaign draft to the server. It was not sent to customers.`,
            }
          : {
              ko: `${selectedChannelLabels.join(" · ")} 캠페인 초안을 이 화면에만 준비했습니다. 서버 저장·고객 발송은 하지 않았습니다.`,
              en: `Prepared the ${selectedChannelLabels.join(" · ")} campaign draft on this screen only. It was not saved to the server or sent to customers.`,
            },
      });
    } catch {
      recordActivity({
        key: "marketing",
        section: "marketing",
        status: "attention",
        detail: {
          ko: "캠페인 초안 저장 결과를 확인해야 합니다. 고객 발송 완료가 아닙니다.",
          en: "Check the campaign draft save result. It has not been sent to customers.",
        },
      });
      setCampaignNotice({
        kind: "error",
        message: {
          ko: "캠페인 초안 저장 결과를 확인하지 못했습니다. 입력은 유지했습니다. 중복 저장하지 않도록 서버 처리 결과와 연결을 확인해 주세요.",
          en: "Could not confirm the campaign draft save. Your input is kept. To avoid a duplicate, check the server result and the connection.",
        },
      });
    } finally {
      campaignBusyRef.current = false;
      setIsSavingCampaign(false);
    }
  };

  /** 회원 개인정보는 자동 렌더링하지 않고 admin이 명시적으로 조회할 때만 API에서 읽습니다. */
  const handleLoadMembers = async () => {
    if (memberBusyRef.current) return;
    if (!actions?.listMembers) {
      setMemberLoadFailed(true);
      setMemberNotice({
        kind: "error",
        message: {
          ko: "회원 목록 API가 아직 연결되지 않았습니다.",
          en: "The member list API is not connected yet.",
        },
      });
      return;
    }

    memberBusyRef.current = true;
    try {
      setIsLoadingMembers(true);
      setMemberNotice(null);
      const nextMembers = await actions.listMembers();
      setMembers(nextMembers);
      setMembersLoaded(true);
      setMemberLoadFailed(false);
      setMemberNeedsRefresh(false);
      setMemberRevision((current) => current + 1);
      setMemberNotice({
        kind: "success",
        message: {
          ko: `이번 조회에서 회원 ${nextMembers.length}명을 불러왔습니다. 전체 회원 수가 아닌 이번 API 응답 범위입니다.`,
          en: `Loaded ${nextMembers.length} members in this query. This is the range of this API response, not the total member count.`,
        },
      });
    } catch {
      setMemberLoadFailed(true);
      setMemberNotice({
        kind: "error",
        message: {
          ko: "회원 목록을 불러오지 못했습니다. 기존 목록이 있다면 이전 조회 결과이며 최신 상태가 아닐 수 있습니다. 관리자 권한·연결을 확인한 뒤 다시 조회해 주세요.",
          en: "Could not load the member list. Any list shown is from an earlier query and may be out of date. Check admin access and the connection, then load it again.",
        },
      });
    } finally {
      memberBusyRef.current = false;
      setIsLoadingMembers(false);
    }
  };

  const handleMemberGroupUpdate = async (
    username: string,
    group: "admin" | "support",
    add: boolean,
    expectedGroups: readonly string[],
  ) => {
    if (memberBusyRef.current || memberNeedsRefresh || memberLoadFailed) return;
    const member = members.find((item) => item.username === username);
    if (
      !member ||
      JSON.stringify([...member.groups].sort()) !==
        JSON.stringify([...expectedGroups].sort()) ||
      member.groups.includes(group) === add
    ) {
      setMemberNeedsRefresh(true);
      setMemberNotice({
        kind: "error",
        message: {
          ko: "확인한 회원 권한과 현재 목록이 다릅니다. 회원 목록을 다시 조회하고 변경 내용을 검토해 주세요.",
          en: "The confirmed member permissions differ from the current list. Load the member list again and review the change.",
        },
      });
      return;
    }
    if (
      group === "admin" &&
      !add &&
      member.userSub &&
      member.userSub === currentAdmin?.sub
    ) {
      setMemberNotice({
        kind: "error",
        message: {
          ko: "자기 자신의 admin 권한은 해제할 수 없습니다.",
          en: "You cannot remove your own admin permission.",
        },
      });
      return;
    }
    if (!actions?.updateMemberGroup) {
      setMemberNotice({
        kind: "error",
        message: {
          ko: "회원 그룹 API가 아직 연결되지 않았습니다.",
          en: "The member group API is not connected yet.",
        },
      });
      return;
    }

    const changeLabel = {
      ko: `${username} 계정의 ${group} 그룹 ${add ? "부여" : "해제"}`,
      en: `${add ? "Granting" : "Removing"} the ${group} group ${add ? "to" : "from"} ${username}`,
    };
    memberBusyRef.current = true;
    setIsSavingMemberGroup(true);
    setMemberNotice(null);
    try {
      await actions.updateMemberGroup({ username, group, add });
      try {
        if (!actions.listMembers) throw new Error("Member list unavailable");
        setIsLoadingMembers(true);
        const nextMembers = await actions.listMembers();
        setMembers(nextMembers);
        setMembersLoaded(true);
        setMemberLoadFailed(false);
        setMemberNeedsRefresh(false);
        setMemberRevision((current) => current + 1);
      } catch {
        setMemberLoadFailed(true);
        setMemberNeedsRefresh(true);
        setMemberNotice({
          kind: "error",
          message: {
            ko: `${changeLabel.ko} 요청은 성공했습니다. 최신 회원 목록을 확인하지 못했으므로 이전 권한 표시를 신뢰하지 말고 다시 조회해 주세요. 재조회 전에는 권한을 다시 변경할 수 없습니다.`,
            en: `${changeLabel.en} succeeded. The latest member list could not be confirmed, so do not trust the earlier permissions shown; load the list again. You cannot change permissions again until you do.`,
          },
        });
        return;
      }
      setMemberNotice({
        kind: "success",
        message: {
          ko: `${changeLabel.ko} 요청이 성공했고 목록을 다시 불러왔습니다. 새 권한은 다음 로그인부터 적용됩니다.`,
          en: `${changeLabel.en} succeeded and the list was reloaded. The new permission applies from the next sign-in.`,
        },
      });
    } catch {
      setMemberNeedsRefresh(true);
      setMemberNotice({
        kind: "error",
        message: {
          ko: `${changeLabel.ko} 결과를 확인하지 못했습니다. 실제로 반영됐을 수 있으므로 재전송하지 말고 회원 목록을 다시 조회해 주세요. 자기 자신의 admin 해제는 서버에서 금지합니다.`,
          en: `Could not confirm the result of ${changeLabel.en}. It may have been applied, so do not resend; load the member list again. The server blocks removing your own admin permission.`,
        },
      });
    } finally {
      memberBusyRef.current = false;
      setIsSavingMemberGroup(false);
      setIsLoadingMembers(false);
    }
  };

  const applyOcrJob = (job: AdminOcrRecognitionResult) => {
    setOcrInventoryJob(null);
    ocrCurrentJobRef.current = { jobId: job.jobId, version: job.version };
    setOcrJobId(job.jobId);
    setOcrVersion(job.version);
    setOcrRawText(job.rawText);
    setOcrRows([...job.rows]);
    setOcrAnalysis(job.analysis);
    setOcrState("review");
  };

  const resetOcrReview = () => {
    setOcrInventoryJob(null);
    ocrRequestGenerationRef.current += 1;
    ocrCurrentJobRef.current = null;
    setIsSavingOcr(false);
    setOcrState("idle");
    setOcrJobId(null);
    setOcrVersion(null);
    setOcrRows([]);
    setOcrRawText("");
    setOcrAnalysis(undefined);
  };

  const invalidateOcrRequest = () => {
    setOcrInventoryJob(null);
    recordActivity({
      key: "ocr",
      section: "ocr",
      status: "working",
      detail: {
        ko: "입고 검토 내용을 수정했습니다. 초안 저장·재고 반영은 별도 확인이 필요합니다.",
        en: "Edited the stock-in review. Saving the draft and applying stock need separate confirmation.",
      },
    });
    // Draft edits and file/job changes supersede every earlier response, including
    // a PATCH conflict's subsequent GET. An old finally must not clear a new save.
    ocrRequestGenerationRef.current += 1;
    setIsSavingOcr(false);
    setOcrState((current) =>
      current === "recognizing"
        ? ocrCurrentJobRef.current
          ? "review"
          : "idle"
        : current,
    );
  };

  const handleOcrFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0] ?? null;
    const selectionId = ++ocrFileSelectionRef.current;

    setOcrFile(null);
    resetOcrReview();
    setOcrNotice(null);

    if (!file) {
      return;
    }

    try {
      await validateOcrImageFile(file);

      if (selectionId !== ocrFileSelectionRef.current) {
        return;
      }

      setOcrFile(file);
      recordActivity({
        key: "ocr",
        section: "ocr",
        status: "working",
        detail: {
          ko: "입고 이미지를 선택했습니다. 인식·검토·재고 반영은 아직 완료되지 않았습니다.",
          en: "Selected the stock-in image. Recognition, review and stock update are not done yet.",
        },
      });
      setOcrNotice({
        kind: "success",
        message: {
          ko: `“${file.name}” 파일의 이름·MIME·매직 바이트·4MiB 직접 전송 한도를 확인했습니다.`,
          en: `Checked the name, MIME type, magic bytes and 4MiB direct upload limit of “${file.name}”.`,
        },
      });
    } catch (error) {
      if (selectionId !== ocrFileSelectionRef.current) {
        return;
      }

      event.target.value = "";
      setOcrNotice({
        kind: "error",
        message: getOcrInputErrorMessage(error) ?? {
          ko: "이미지 파일을 검증하지 못했습니다. 파일을 다시 선택해 주세요.",
          en: "Could not validate the image file. Choose the file again.",
        },
      });
    }
  };

  const createOcrRow = (sourceText = ""): AdminOcrReviewRow => ({
    id: `ocr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    sourceText,
    productName: "",
    brand: "",
    option: "",
    quantity: "",
  });

  const handleRecognize = async () => {
    if (!ocrFile) {
      setOcrNotice({
        kind: "error",
        message: {
          ko: "먼저 입고 목록 이미지 파일을 선택해 주세요.",
          en: "Choose a stock-in list image file first.",
        },
      });
      return;
    }

    if (!actions?.recognizeInventory) {
      setOcrState("connection-needed");
      setOcrNotice({
        kind: "error",
        message: {
          ko: "OCR API 연결을 기다리고 있습니다. 이미지나 OCR 키를 브라우저에 직접 노출하지 않습니다.",
          en: "Waiting for the OCR API connection. Images and OCR keys are never exposed directly in the browser.",
        },
      });
      return;
    }

    const requestGeneration = ++ocrRequestGenerationRef.current;
    const selectionId = ocrFileSelectionRef.current;
    setIsSavingOcr(false);

    try {
      setOcrState("recognizing");
      setOcrNotice(null);
      const result = await actions.recognizeInventory({ file: ocrFile });

      if (
        requestGeneration !== ocrRequestGenerationRef.current ||
        selectionId !== ocrFileSelectionRef.current
      ) {
        return;
      }

      applyOcrJob(result);
      const hasTableFields = result.analysis?.mode === "table";
      setOcrNotice({
        kind: result.rows.length > 0 && !hasTableFields ? "error" : "success",
        message:
          result.rows.length === 0
            ? {
                ko: "인식된 텍스트가 없습니다. 더 선명한 이미지를 선택하거나 행 추가로 직접 입력해 주세요.",
                en: "No text was recognized. Choose a sharper image or add rows manually.",
              }
            : hasTableFields
              ? {
                  ko:
                    result.rows.length +
                    "개 상품 행을 인식했습니다. 저장 전에 상품명·브랜드·옵션·수량을 반드시 검토해 주세요.",
                  en: `Recognized ${result.rows.length} product rows. Review the product name, brand, option and quantity before saving.`,
                }
              : {
                  ko:
                    "표의 열을 확정하지 못해 미분류 원문 " +
                    result.rows.length +
                    "개를 그대로 표시합니다. 열 지정 또는 직접 입력으로 상품 필드를 확인해 주세요. 분류 사유: " +
                    (result.analysis?.reason ?? "이전 응답에 분류 정보 없음"),
                  en: `Could not determine the table columns, so ${result.rows.length} unclassified source lines are shown as is. Check the product fields with column mapping or manual input. Reason: ${result.analysis?.reason ?? "no classification in the earlier response"}`,
                },
      });
    } catch (error) {
      if (
        requestGeneration !== ocrRequestGenerationRef.current ||
        selectionId !== ocrFileSelectionRef.current
      ) {
        return;
      }
      setOcrState("idle");
      recordActivity({
        key: "ocr",
        section: "ocr",
        status: "attention",
        detail: {
          ko: "OCR 인식 결과를 확인하지 못했습니다. 연결과 이미지를 확인해야 합니다.",
          en: "Could not confirm the OCR result. Check the connection and the image.",
        },
      });
      setOcrNotice({
        kind: "error",
        message: getOcrInputErrorMessage(error) ??
          localizedOcrRequestError(error) ?? {
            ko: "OCR 요청에 실패했습니다. 이미지 형식과 관리자 API·PaddleOCR 연결을 확인해 주세요.",
            en: "The OCR request failed. Check the image format and the admin API and PaddleOCR connections.",
          },
      });
    }
  };

  const updateOcrRow = (
    id: string,
    field: Exclude<keyof AdminOcrReviewRow, "id">,
    value: string,
  ) => {
    invalidateOcrRequest();
    setOcrRows((current) =>
      current.map((row) => (row.id === id ? { ...row, [field]: value } : row)),
    );
  };

  const handleAddOcrRow = () => {
    if (ocrRows.length >= OCR_INPUT_LIMITS.maxReviewRows) {
      setOcrNotice({
        kind: "error",
        message: {
          ko: `검토 행은 최대 ${OCR_INPUT_LIMITS.maxReviewRows}개까지 추가할 수 있습니다.`,
          en: `You can add up to ${OCR_INPUT_LIMITS.maxReviewRows} review rows.`,
        },
      });
      return;
    }

    invalidateOcrRequest();
    setOcrRows((current) => [...current, createOcrRow()]);
  };

  const handleRemoveOcrRow = (id: string) => {
    invalidateOcrRequest();
    setOcrRows((current) => current.filter((row) => row.id !== id));
  };

  const handleOcrSave = async () => {
    if (ocrRows.length === 0) {
      setOcrNotice({
        kind: "error",
        message: {
          ko: "저장할 입고 행이 없습니다.",
          en: "There are no stock-in rows to save.",
        },
      });
      return;
    }

    const validationMessage = getOcrReviewRowValidationMessage(ocrRows);

    if (validationMessage) {
      setOcrNotice({ kind: "error", message: validationMessage });
      return;
    }

    if (!actions?.saveOcrReview || !ocrJobId || ocrVersion === null) {
      setOcrState("connection-needed");
      recordActivity({
        key: "ocr",
        section: "ocr",
        status: "attention",
        detail: {
          ko: "입고 검토 저장 연결이 필요합니다. 서버 미저장 · 재고 미반영",
          en: "The stock-in review save needs a connection. Not saved to the server · Stock not updated",
        },
      });
      setOcrNotice({
        kind: "error",
        message: {
          ko: "OCR 검토 저장 API가 연결되지 않았습니다. 현재 화면의 초안은 서버에 저장되지 않았습니다.",
          en: "The OCR review save API is not connected. The draft on this screen was not saved to the server.",
        },
      });
      return;
    }

    const requestGeneration = ++ocrRequestGenerationRef.current;
    const jobId = ocrJobId;
    const version = ocrVersion;
    const isCurrentRequest = () =>
      requestGeneration === ocrRequestGenerationRef.current &&
      ocrCurrentJobRef.current?.jobId === jobId &&
      ocrCurrentJobRef.current?.version === version;

    try {
      setIsSavingOcr(true);
      const result = await actions.saveOcrReview({
        jobId: ocrJobId,
        version: ocrVersion,
        rows: ocrRows,
        rawText: ocrRawText,
      });

      if (!isCurrentRequest()) {
        return;
      }

      applyOcrJob(result.job);

      if (result.kind === "conflict") {
        recordActivity({
          key: "ocr",
          section: "ocr",
          status: "attention",
          detail: {
            ko: "검토본이 변경되어 최신 내용을 다시 확인해야 합니다.",
            en: "The review changed. Check the latest content again.",
          },
        });
        setOcrNotice({
          kind: "error",
          message: {
            ko: "다른 관리자의 수정이 먼저 저장되어 최신 OCR 검토본을 다시 불러왔습니다. 내용을 다시 확인한 뒤 저장해 주세요.",
            en: "Another admin saved changes first, so the latest OCR review was reloaded. Check the content again, then save.",
          },
        });
        return;
      }

      setOcrNotice({
        kind: "success",
        message: {
          ko: `검토한 입고 행을 관리자 API에 저장했습니다. 서버 버전 ${result.job.version}을 적용했습니다. 실제 재고를 변경하려면 아래 재고 반영에서 상품과 수량을 확인해 주세요.`,
          en: `Saved the reviewed stock-in rows to the admin API as server version ${result.job.version}. To change actual stock, check the products and quantities in the stock update below.`,
        },
      });
      recordActivity({
        key: "ocr",
        section: "ocr",
        status: "draft",
        detail: {
          ko: "입고 검토 초안을 서버에 저장했습니다. 실제 재고 반영은 별도입니다.",
          en: "Saved the stock-in review draft to the server. Updating actual stock is a separate step.",
        },
      });
      setOcrInventoryJob(result.job);
    } catch {
      if (!isCurrentRequest()) {
        return;
      }
      setOcrNotice({
        kind: "error",
        message: {
          ko: "입고 행을 저장하지 못했습니다. 내용을 확인한 뒤 다시 시도해 주세요.",
          en: "Could not save the stock-in rows. Check the content, then try again.",
        },
      });
      recordActivity({
        key: "ocr",
        section: "ocr",
        status: "attention",
        detail: {
          ko: "입고 검토 초안의 저장 결과를 확인해야 합니다. 재고 반영 완료가 아닙니다.",
          en: "Check the save result of the stock-in review draft. Stock has not been updated.",
        },
      });
    } finally {
      if (requestGeneration === ocrRequestGenerationRef.current) {
        setIsSavingOcr(false);
      }
    }
  };

  const handleOcrRemap = async (
    mapping: OcrMapping,
    preview: boolean,
  ): Promise<AdminOcrRemapResult | null> => {
    if (!actions?.remapOcrReview || !ocrJobId || ocrVersion === null) return null;
    const generation = ++ocrRequestGenerationRef.current;
    const jobId = ocrJobId,
      version = ocrVersion;
    const current = () =>
      generation === ocrRequestGenerationRef.current &&
      ocrCurrentJobRef.current?.jobId === jobId &&
      ocrCurrentJobRef.current?.version === version;
    try {
      setIsSavingOcr(true);
      const result = await actions.remapOcrReview({ jobId, version, mapping, preview });
      if (!current()) return null;
      if (result.kind !== "preview") {
        applyOcrJob(result.job);
        recordActivity({
          key: "ocr",
          section: "ocr",
          status: result.kind === "conflict" ? "attention" : "working",
          detail:
            result.kind === "conflict"
              ? {
                  ko: "검토본이 변경되어 최신 내용을 다시 확인해야 합니다.",
                  en: "The review changed. Check the latest content again.",
                }
              : {
                  ko: "열 지정이 변경되었습니다. 상품 필드를 다시 검토하고 초안을 저장하세요.",
                  en: "The column mapping changed. Review the product fields again and save the draft.",
                },
        });
        setOcrNotice({
          kind: result.kind === "conflict" ? "error" : "success",
          message:
            result.kind === "conflict"
              ? {
                  ko: "다른 수정이 먼저 저장되어 최신 OCR 검토본을 불러왔습니다. 열 지정을 다시 미리보기해 주세요.",
                  en: "Another change was saved first, so the latest OCR review was loaded. Preview the column mapping again.",
                }
              : {
                  ko: `열 지정을 원본 OCR에 적용했습니다. 서버 버전 ${result.job.version}의 상품 필드를 검토한 뒤 초안을 저장해 주세요.`,
                  en: `Applied the column mapping to the original OCR. Review the product fields of server version ${result.job.version}, then save the draft.`,
                },
        });
      }
      return result;
    } catch (error) {
      if (current()) {
        recordActivity({
          key: "ocr",
          section: "ocr",
          status: "attention",
          detail: {
            ko: "열 지정 결과를 확인하지 못했습니다. 기존 검토본은 유지됩니다.",
            en: "Could not confirm the column mapping result. The existing review is kept.",
          },
        });
        setOcrNotice({
          kind: "error",
          message: localizedOcrRequestError(error) ?? {
            ko: "열 지정에 실패했습니다. 현재 검토본은 유지됩니다.",
            en: "The column mapping failed. The current review is kept.",
          },
        });
      }
      return null;
    } finally {
      if (generation === ocrRequestGenerationRef.current) setIsSavingOcr(false);
    }
  };

  return (
    <section
      className={styles.adminPage}
      aria-label={locale === "ko" ? "PARADAYS 관리자 화면" : "PARADAYS admin"}
    >
      <header className={styles.adminHeader}>
        <div>
          <p className={styles.adminBreadcrumb}>
            {locale === "ko" ? "관리자" : "Admin"}
            <span aria-hidden="true">/</span>
            {activeSection === "overview"
              ? locale === "ko"
                ? "홈"
                : "Home"
              : sectionShortLabels[locale][activeSection]}
          </p>
          <h1 className={styles.srOnly}>
            {locale === "ko" ? "스토어 운영" : "Store operations"}
          </h1>
        </div>
        <div className={styles.headerActions}>
          <div className={styles.languageSwitch} aria-label="Language">
            <button
              aria-pressed={locale === "ko"}
              onClick={() => setLocale("ko")}
              type="button"
            >
              {languageLabels.ko}
            </button>
            <span aria-hidden="true" className={styles.languageSep}>
              /
            </span>
            <button
              aria-pressed={locale === "en"}
              onClick={() => setLocale("en")}
              type="button"
            >
              {languageLabels.en}
            </button>
          </div>
          <div className={styles.headerStatusRow}>
            <Link
              className={`${styles.homeLink} ${styles.mobileStoreLink}`}
              href={storeReturnPath}
            >
              {copy.adminBackToStore}
            </Link>
            <div className={styles.securityBadge} title={adminName}>
              <AdminMenuIcon section="members" />
              {locale === "ko" ? "관리자" : "Administrator"}
            </div>
          </div>
        </div>
      </header>

      <nav
        aria-label={locale === "ko" ? "관리자 메뉴" : "Admin menu"}
        className={styles.sidebar}
      >
        <div className={styles.sidebarIntro}>
          <strong>PARADAYS</strong>
          <span>{locale === "ko" ? "관리자" : "Admin"}</span>
        </div>
        <button
          aria-controls="ops-menu-drawer"
          aria-expanded={isOpsMenuOpen}
          className={
            isMenuButtonHidden
              ? `${styles.opsMenuButton} ${styles.opsMenuButtonHidden}`
              : styles.opsMenuButton
          }
          onClick={() => setIsOpsMenuOpen((open) => !open)}
          ref={menuButtonRef}
          type="button"
        >
          <span className="srOnly">
            {locale === "ko"
              ? `운영 메뉴 ${isOpsMenuOpen ? "닫기" : "열기"}`
              : `${isOpsMenuOpen ? "Close" : "Open"} operations menu`}
          </span>
          <span aria-hidden="true" />
          <span aria-hidden="true" />
          <span aria-hidden="true" />
        </button>
      </nav>

      {isOpsMenuOpen && !isDesktopAdmin ? (
        <button
          aria-label={locale === "ko" ? "메뉴 닫기" : "Close menu"}
          className={styles.opsMenuScrim}
          onClick={() => {
            setIsOpsMenuOpen(false);
            menuButtonRef.current?.focus();
          }}
          type="button"
        />
      ) : null}

      <div
        aria-hidden={!isMenuVisible}
        aria-label={locale === "ko" ? "관리자 메뉴" : "Admin menu"}
        aria-modal={isOpsMenuOpen && !isDesktopAdmin ? true : undefined}
        className={
          isOpsMenuOpen
            ? `${styles.opsMenuDrawer} ${styles.opsMenuDrawerOpen}`
            : styles.opsMenuDrawer
        }
        id="ops-menu-drawer"
        inert={!isMenuVisible}
        ref={menuDrawerRef}
        role={isDesktopAdmin ? "navigation" : "dialog"}
      >
        <div className={styles.opsMenuDrawerHeader}>
          <div className={styles.sidebarBrand}>
            <strong>PARADAYS</strong>
            <span>{locale === "ko" ? "관리자" : "Admin"}</span>
          </div>
          <button
            aria-label={locale === "ko" ? "메뉴 닫기" : "Close menu"}
            className={styles.opsMenuClose}
            onClick={() => {
              setIsOpsMenuOpen(false);
              menuButtonRef.current?.focus();
            }}
            tabIndex={isMenuVisible ? undefined : -1}
            type="button"
          >
            ×
          </button>
        </div>
        <div className={styles.tabList} role="tablist" aria-orientation="vertical">
          {sectionItems.map((section) => (
            <button
              aria-label={
                section.id === "overview"
                  ? copy.adminOverviewMenu
                  : section.label[locale]
              }
              aria-controls={`admin-panel-${section.id}`}
              aria-selected={activeSection === section.id}
              className={activeSection === section.id ? styles.tabActive : styles.tab}
              id={`admin-tab-${section.id}`}
              key={section.id}
              onClick={() => selectSection(section.id)}
              onKeyDown={(event) => moveSectionFocus(event, section.id)}
              role="tab"
              tabIndex={isMenuVisible && activeSection === section.id ? 0 : -1}
              type="button"
            >
              <AdminMenuIcon section={section.id} />
              <span>{sectionShortLabels[locale][section.id]}</span>
            </button>
          ))}
        </div>
        <Link
          className={styles.sidebarStoreLink}
          href={storeReturnPath}
          tabIndex={isMenuVisible ? undefined : -1}
        >
          <span aria-hidden="true">↗</span>
          {copy.adminBackToStore}
        </Link>
      </div>

      <section
        aria-labelledby={`admin-tab-${activeSection}`}
        className={`${styles.workspace} ${requiredStyles.requiredScope}`}
        id={`admin-panel-${activeSection}`}
        role="tabpanel"
        tabIndex={-1}
      >
        {activeSection === "overview" ? (
          <>
            <OverviewSection
              activities={operationActivities}
              canResumeActivity={(activity) =>
                Boolean(activity.editorId && productEditors.has(activity.editorId))
              }
              loadOverviewMetrics={actions?.loadOverviewMetrics}
              onOpenActivity={(activity) => {
                if (activity.editorId && productEditors.has(activity.editorId)) {
                  navigateToAdminProductEditor(activity.editorId);
                  setIsOpsMenuOpen(false);
                } else selectSection(activity.section);
              }}
              onGoTo={selectSection}
              onOpenCreate={() => selectSection("products", { productView: "create" })}
            />
            <AdminOrderInventoryPanel />
            <AdminOrderSimulationPanel />
          </>
        ) : null}
        {activeSection === "products" ? (
          <ProductSection
            brands={localBrands}
            canSaveToServer={Boolean(actions?.saveProductDraft)}
            canUploadImages={Boolean(actions?.uploadProductImage)}
            deleting={isDeletingProducts}
            draft={productDraft}
            editorId={productEditor?.id ?? ""}
            loading={isLoadingProducts}
            lockInputs={isSavingProduct && savingProductEditorId === productEditor?.id}
            notice={productNotice}
            onCloseEditor={() => {
              if (productEditor) {
                removePendingProductActivity(productEditor.id);
                finishProductEditor(productEditor.id);
              }
              setProductNotice(null);
            }}
            onDeleteProducts={(items) => void handleDeleteProducts(items)}
            onEditProduct={(product) => openProductEditor(product, "edit")}
            onImageChange={handleProductImageChange}
            onOpenCreate={openNewProductEditor}
            onReset={resetProductDraft}
            onSave={(event) => void handleProductSave(event)}
            onSaveDeckSpec={
              actions?.updateProductDeckSpec ? saveProductDeckSpec : undefined
            }
            onTextChange={updateProductText}
            onToggleChange={updateProductToggle}
            previewCompareAtPrice={previewCompareAtPrice}
            previewName={previewName}
            previewPrice={previewPrice}
            previewSizes={previewSizes}
            products={localProducts}
            saving={isSavingProduct}
            view={productView}
          />
        ) : null}
        <div hidden={activeSection !== "sales"}>
          <AdminSalesLedgerPanel products={localProducts} />
        </div>
        {activeSection === "inventory" ? (
          <InventorySection
            canUpdateStock={Boolean(actions?.updateProductStock)}
            loadFailed={catalogLoadFailed}
            loading={isLoadingProducts}
            notice={inventoryNotice}
            onChangeStock={handleInventoryStockChange}
            onRefresh={refreshInventoryProducts}
            products={localProducts}
            savingIds={inventorySavingIds}
          />
        ) : null}
        {activeSection === "brands" ? (
          <BrandSection
            brandMemo={brandMemo}
            brandName={brandName}
            brands={localBrands}
            canSaveToServer={Boolean(actions?.saveBrandDraft)}
            loadFailed={catalogLoadFailed}
            loading={isLoadingProducts}
            notice={brandNotice}
            onMemoChange={(value) => {
              setBrandMemo(value);
              markActivityWorking("brands");
            }}
            onNameChange={(value) => {
              setBrandName(value);
              markActivityWorking("brands");
            }}
            onSubmit={(event) => void handleBrandSubmit(event)}
            products={localProducts}
            saving={isSavingBrand}
          />
        ) : null}
        {activeSection === "members" ? (
          <MembersSection
            canLoad={Boolean(actions?.listMembers)}
            canUpdate={Boolean(actions?.updateMemberGroup)}
            currentUserSub={currentAdmin?.sub}
            loaded={membersLoaded}
            loadFailed={memberLoadFailed}
            loading={isLoadingMembers}
            members={members}
            notice={memberNotice}
            onLoad={() => void handleLoadMembers()}
            needsRefresh={memberNeedsRefresh}
            onUpdateGroup={(username, group, add, expectedGroups) =>
              void handleMemberGroupUpdate(username, group, add, expectedGroups)
            }
            revision={memberRevision}
            saving={isSavingMemberGroup}
          />
        ) : null}
        {activeSection === "coupons" ? (
          <CouponSection
            canSaveToServer={Boolean(actions?.saveCouponDraft)}
            couponCode={couponCode}
            couponExpiresAt={couponExpiresAt}
            couponName={couponName}
            couponType={couponType}
            couponValue={couponValue}
            notice={couponNotice}
            onCodeChange={(value) => {
              setCouponCode(value);
              setCouponNotice(null);
              markActivityWorking("coupons");
            }}
            onExpiresAtChange={(value) => {
              setCouponExpiresAt(value);
              setCouponNotice(null);
              markActivityWorking("coupons");
            }}
            onNameChange={(value) => {
              setCouponName(value);
              setCouponNotice(null);
              markActivityWorking("coupons");
            }}
            onSubmit={(event) => void handleCouponSubmit(event)}
            onTypeChange={(value) => {
              setCouponType(value);
              setCouponNotice(null);
              markActivityWorking("coupons");
            }}
            onValueChange={(value) => {
              setCouponValue(value);
              setCouponNotice(null);
              markActivityWorking("coupons");
            }}
            saving={isSavingCoupon}
          />
        ) : null}
        {activeSection === "marketing" ? (
          <MarketingSection
            body={campaignBody}
            canSaveToServer={Boolean(actions?.saveCampaignDraft)}
            channels={campaignChannels}
            notice={campaignNotice}
            onBodyChange={(value) => {
              setCampaignBody(value);
              setCampaignNotice(null);
              markActivityWorking("marketing");
            }}
            onChannelChange={(channel, selected) => {
              setCampaignChannels((current) => ({ ...current, [channel]: selected }));
              setCampaignNotice(null);
              markActivityWorking("marketing");
            }}
            onSubmit={(event) => void handleCampaignSubmit(event)}
            onTitleChange={(value) => {
              setCampaignTitle(value);
              setCampaignNotice(null);
              markActivityWorking("marketing");
            }}
            saving={isSavingCampaign}
            title={campaignTitle}
          />
        ) : null}
        {activeSection === "ocr" ? (
          <OcrSection
            canAddRow={ocrRows.length < OCR_INPUT_LIMITS.maxReviewRows}
            canSave={Boolean(
              actions?.saveOcrReview &&
                ocrJobId &&
                ocrVersion !== null &&
                ocrRows.length > 0,
            )}
            file={ocrFile}
            isSaving={isSavingOcr || isApplyingOcrInventory}
            jobVersion={ocrVersion}
            reviewSaved={Boolean(
              ocrInventoryJob &&
                ocrInventoryJob.jobId === ocrJobId &&
                ocrInventoryJob.version === ocrVersion,
            )}
            notice={ocrNotice}
            onAddRow={handleAddOcrRow}
            onFileChange={handleOcrFileChange}
            onRecognize={() => void handleRecognize()}
            onRemoveRow={handleRemoveOcrRow}
            onSave={() => void handleOcrSave()}
            onRowChange={updateOcrRow}
            rows={ocrRows}
            rawText={ocrRawText}
            inventoryPanel={
              ocrInventoryJob ? (
                <OcrInventoryCommitPanel
                  key={`${ocrInventoryJob.jobId}:${ocrInventoryJob.version}`}
                  job={ocrInventoryJob}
                  actions={actions}
                  attempts={ocrInventoryAttempts}
                  onBusyChange={setIsApplyingOcrInventory}
                  onProductUpdated={(product) => {
                    catalogMutationGenerationRef.current += 1;
                    setLocalProducts((current) =>
                      current.some((item) => item.id === product.id)
                        ? current.map((item) =>
                            item.id === product.id && item.version <= product.version
                              ? product
                              : item,
                          )
                        : [...current, product],
                    );
                  }}
                />
              ) : undefined
            }
            mappingPanel={
              ocrJobId && ocrVersion !== null ? (
                <div
                  key={`${ocrJobId}:${ocrVersion}`}
                  className={`${styles.sectionStack} ${styles.ocrSectionStack}`}
                >
                  <OcrRegionMappingPanel
                    file={ocrFile}
                    jobId={ocrJobId}
                    version={ocrVersion}
                    analysis={ocrAnalysis}
                    disabled={
                      isSavingOcr ||
                      isApplyingOcrInventory ||
                      ocrState === "recognizing" ||
                      !actions?.remapOcrReview
                    }
                    onRemap={handleOcrRemap}
                  />
                </div>
              ) : undefined
            }
            state={ocrState}
          />
        ) : null}
      </section>
    </section>
  );
}

function OverviewSection({
  activities,
  canResumeActivity,
  loadOverviewMetrics,
  onOpenActivity,
  onGoTo,
  onOpenCreate,
}: Readonly<{
  activities: readonly OperationActivity[];
  canResumeActivity: (activity: OperationActivity) => boolean;
  loadOverviewMetrics?: () => Promise<AdminOverviewMetrics>;
  onOpenActivity: (activity: OperationActivity) => void;
  onGoTo: (section: AdminSection) => void;
  onOpenCreate: () => void;
}>) {
  const { copy, locale } = useLocale();
  const [showAllActivities, setShowAllActivities] = useState(false);
  const isKorean = locale === "ko";
  const [metrics, setMetrics] = useState<AdminOverviewMetrics | null>(null);
  const [metricsState, setMetricsState] = useState<
    "loading" | "ready" | "unavailable" | "error"
  >(loadOverviewMetrics ? "loading" : "unavailable");

  useEffect(() => {
    if (!loadOverviewMetrics) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- resets when the loader is removed; isCurrent guards async results.
      setMetrics(null);
      setMetricsState("unavailable");
      return;
    }

    let isCurrent = true;
    setMetricsState("loading");

    void loadOverviewMetrics()
      .then((nextMetrics) => {
        if (!isCurrent) {
          return;
        }

        setMetrics(nextMetrics);
        setMetricsState("ready");
      })
      .catch(() => {
        if (!isCurrent) {
          return;
        }

        setMetrics(null);
        setMetricsState("error");
      });

    return () => {
      isCurrent = false;
    };
  }, [loadOverviewMetrics]);

  const formatCount = (value: number | undefined) =>
    metricsState === "loading" ? "…" : value === undefined ? "—" : String(value);
  const revenueFormatter = useMemo(
    () =>
      new Intl.NumberFormat(locale === "ko" ? "ko-KR" : "en-US", {
        style: "currency",
        currency: "KRW",
        maximumFractionDigits: 0,
      }),
    [locale],
  );
  const formatRevenue = (value: number | undefined) =>
    metricsState === "loading"
      ? "…"
      : value === undefined
        ? "—"
        : revenueFormatter.format(value);
  const metricNote = (value: number | undefined, readyNote: string) => {
    if (metricsState === "loading") {
      return copy.adminOverviewMetricLoading;
    }

    if (metricsState === "unavailable") {
      return copy.adminOverviewApiUnavailable;
    }
    if (metricsState === "error") {
      return isKorean
        ? "지표 조회 실패 · 연결·권한 확인 필요"
        : "Metrics request failed · Check connection and permissions";
    }

    return value === undefined ? copy.adminOverviewAggregationPending : readyNote;
  };
  const overviewDescription =
    metricsState === "ready"
      ? copy.adminOverviewLiveDescription.replace("{asOf}", metrics?.asOf ?? "—")
      : metricsState === "loading"
        ? copy.adminOverviewLoadingDescription
        : metricsState === "error"
          ? isKorean
            ? "운영 지표를 불러오지 못했습니다. 연결과 관리자 권한을 확인해 주세요."
            : "Could not load operational metrics. Check the connection and administrator permissions."
          : copy.adminOverviewUnavailableDescription;
  const metricAsOf = metrics?.asOf ? new Date(metrics.asOf) : null;
  const formattedAsOf =
    metricsState === "ready" && metricAsOf && Number.isFinite(metricAsOf.getTime())
      ? new Intl.DateTimeFormat(isKorean ? "ko-KR" : "en-US", {
          timeZone: "Asia/Seoul",
          dateStyle: "medium",
          timeStyle: "short",
        }).format(metricAsOf)
      : null;

  const lowStockReady =
    metricsState === "ready" && metrics?.lowStockCount !== undefined;
  const homeSteps: AdminStep[] = [
    {
      label: isKorean ? "운영 지표 조회" : "Load metrics",
      state:
        metricsState === "ready"
          ? "complete"
          : metricsState === "unavailable"
            ? "unavailable"
            : "current",
    },
    {
      label: isKorean ? "재고 확인" : "Check stock",
      state: !lowStockReady
        ? "upcoming"
        : (metrics?.lowStockCount ?? 0) > 0
          ? "current"
          : "complete",
    },
    {
      // 일마감 결과는 홈에서 조회하지 않으므로 완료로 표시하지 않습니다.
      label: isKorean ? "매출·일마감" : "Sales & day close",
      state: lowStockReady && metrics?.lowStockCount === 0 ? "current" : "upcoming",
    },
  ];
  return (
    <div className={`${styles.sectionStack} ${styles.overviewStack}`}>
      <AdminStepper
        className={styles.screenStepper}
        label={isKorean ? "홈 작업 흐름" : "Home workflow"}
        locale={locale}
        steps={homeSteps}
      />
      <header className={styles.overviewHeader}>
        <div>
          <h2>{copy.adminOverviewTitle}</h2>
          <p
            className={styles.overviewTimestamp}
            role={metricsState === "error" ? "alert" : "status"}
          >
            {formattedAsOf
              ? `${isKorean ? "집계 기준" : "As of"} ${formattedAsOf} · KST`
              : overviewDescription}
          </p>
        </div>
        <button className={styles.secondaryButton} onClick={onOpenCreate} type="button">
          <span aria-hidden="true">＋</span> {isKorean ? "새 상품" : "New product"}
        </button>
      </header>
      <div className={styles.overviewMetricGrid} aria-busy={metricsState === "loading"}>
        <MetricCard
          icon="sales"
          label={copy.adminOverviewTodayRevenue}
          value={formatRevenue(metrics?.todayPaidRevenue)}
          note={metricNote(
            metrics?.todayPaidRevenue,
            isKorean
              ? "오늘 온라인 결제완료 주문 · KST"
              : "Today's paid online orders · KST",
          )}
        />
        <MetricCard
          icon="overview"
          label={copy.adminOverviewTodayOrders}
          value={formatCount(metrics?.todayOrderCount)}
          note={metricNote(metrics?.todayOrderCount, copy.adminOverviewTodayOrdersNote)}
        />
        <MetricCard
          icon="inventory"
          label={copy.adminOverviewItemsSold}
          value={formatCount(metrics?.todaySoldItemCount)}
          note={metricNote(
            metrics?.todaySoldItemCount,
            copy.adminOverviewItemsSoldNote,
          )}
        />
      </div>
      <section className={styles.overviewTasks} aria-labelledby="quick-actions-title">
        <h2 id="quick-actions-title">
          {isKorean ? "운영 바로가기" : "Operations shortcuts"}
        </h2>
        <div className={styles.overviewTaskList}>
          <QuickAction
            icon="ocr"
            label={isKorean ? "입고 검토" : "Intake review"}
            note={
              isKorean
                ? "이미지에서 상품과 수량 확인"
                : "Review products and quantities from an image"
            }
            actionLabel={isKorean ? "입고 검토 시작" : "Start intake review"}
            primary
            onClick={() => onGoTo("ocr")}
          />
          <QuickAction
            icon="inventory"
            label={copy.adminOverviewLowStock}
            value={formatCount(metrics?.lowStockCount)}
            note={metricNote(
              metrics?.lowStockCount,
              copy.adminOverviewLowStockNote.replace(
                "{threshold}",
                String(metrics?.lowStockThreshold ?? 5),
              ),
            )}
            actionLabel={isKorean ? "재고 확인" : "Check stock"}
            needsAttention={
              metricsState === "ready" && (metrics?.lowStockCount ?? 0) > 0
            }
            onClick={() => onGoTo("inventory")}
          />
          <QuickAction
            icon="sales"
            label={isKorean ? "매출·일마감" : "Sales & day close"}
            note={
              isKorean
                ? "판매 전표와 하루 매출 대조"
                : "Review sales entries and reconcile the day"
            }
            actionLabel={isKorean ? "매출·마감 확인" : "Review sales & close"}
            onClick={() => onGoTo("sales")}
          />
        </div>
      </section>
      <section
        className={styles.recentOperations}
        aria-labelledby="recent-operations-title"
      >
        <header>
          <h2 id="recent-operations-title">
            {isKorean ? "최근 운영 기록" : "Recent activity"}
          </h2>
          {activities.length > 5 ? (
            <button
              aria-expanded={showAllActivities}
              className={styles.secondaryButton}
              onClick={() => setShowAllActivities((current) => !current)}
              type="button"
            >
              {showAllActivities
                ? isKorean
                  ? "최근 5건"
                  : "Latest 5"
                : isKorean
                  ? "전체보기"
                  : "Show all"}
            </button>
          ) : null}
        </header>
        <p className={styles.operationScope}>
          {isKorean
            ? "이번 관리자 화면에서 수행한 작업별 최근 상태만 표시합니다(최대 12개). 새로고침하면 초기화되며, 서버 전체 운영 이력이 아닙니다."
            : "Shows only the latest status of each task done on this admin screen (up to 12). It resets on refresh and is not the full server activity history."}
        </p>
        {activities.length === 0 ? (
          <p className={styles.operationEmpty}>
            {isKorean
              ? "아직 이 화면에서 수행한 작업이 없습니다."
              : "No tasks done on this screen yet."}
          </p>
        ) : (
          <ul className={styles.operationList}>
            {activities.slice(0, showAllActivities ? 12 : 5).map((activity) => {
              const resume = canResumeActivity(activity);
              if (activity.status === "attention") {
                return (
                  <li data-status={activity.status} key={activity.key}>
                    <AdminNotice
                      locale={locale}
                      status="attention"
                      title={
                        isKorean
                          ? `${sectionShortLabels[locale][activity.section]} 작업`
                          : `${sectionShortLabels[locale][activity.section]} task`
                      }
                    >
                      <time dateTime={new Date(activity.at).toISOString()}>
                        {new Intl.DateTimeFormat(isKorean ? "ko-KR" : "en-US", {
                          timeZone: "Asia/Seoul",
                          hour: "2-digit",
                          minute: "2-digit",
                          hour12: false,
                        }).format(activity.at)}{" "}
                        KST
                      </time>
                      <p>{localizedText(activity.detail, locale)}</p>
                      {activity.editorId && !resume ? (
                        <small>
                          {isKorean
                            ? "편집 초안은 더 이상 열려 있지 않습니다. 상품 목록에서 확인하세요."
                            : "The edit draft is no longer open. Check the product list."}
                        </small>
                      ) : null}
                      <button
                        className={styles.secondaryButton}
                        onClick={() => onOpenActivity(activity)}
                        type="button"
                      >
                        {resume
                          ? isKorean
                            ? "이어서 수정"
                            : "Continue editing"
                          : isKorean
                            ? "메뉴 보기"
                            : "Open menu"}
                        <span className={styles.srOnly}>
                          {" "}
                          · {sectionShortLabels[locale][activity.section]}
                        </span>
                      </button>
                    </AdminNotice>
                  </li>
                );
              }
              return (
                <li
                  className={styles.operationRow}
                  data-status={activity.status}
                  key={activity.key}
                >
                  <time dateTime={new Date(activity.at).toISOString()}>
                    {new Intl.DateTimeFormat(isKorean ? "ko-KR" : "en-US", {
                      timeZone: "Asia/Seoul",
                      hour: "2-digit",
                      minute: "2-digit",
                      hour12: false,
                    }).format(activity.at)}
                    <small>KST</small>
                  </time>
                  <div
                    className={styles.operationIcon}
                    data-tone={operationIconTone[activity.section]}
                  >
                    <AdminMenuIcon section={activity.section} />
                  </div>
                  <div className={styles.operationDescription}>
                    <strong>
                      {sectionShortLabels[locale][activity.section]}{" "}
                      {isKorean ? "작업" : "task"}
                    </strong>
                    <span className={styles.operationStatus}>
                      {operationStatusLabels[locale][activity.status]}
                    </span>
                    <p>{localizedText(activity.detail, locale)}</p>
                    {activity.editorId && !resume ? (
                      <small>
                        {isKorean
                          ? "편집 초안은 더 이상 열려 있지 않습니다. 상품 목록에서 확인하세요."
                          : "The edit draft is no longer open. Check the product list."}
                      </small>
                    ) : null}
                  </div>
                  <button
                    className={styles.secondaryButton}
                    onClick={() => onOpenActivity(activity)}
                    type="button"
                  >
                    {resume
                      ? isKorean
                        ? "이어서 수정"
                        : "Continue editing"
                      : isKorean
                        ? "메뉴 보기"
                        : "Open menu"}
                    <span className={styles.srOnly}>
                      {" "}
                      · {sectionShortLabels[locale][activity.section]}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <div className={styles.overviewSecondaryGrid}>
        <MetricCard
          icon="members"
          label={copy.adminOverviewNewMembers}
          value={formatCount(metrics?.todayNewMemberCount)}
          note={metricNote(
            metrics?.todayNewMemberCount,
            copy.adminOverviewNewMembersNote,
          )}
        />
        <MetricCard
          icon="coupons"
          label={isKorean ? "등록 쿠폰" : "Registered coupons"}
          value={formatCount(metrics?.activeCouponCount)}
          note={metricNote(
            metrics?.activeCouponCount,
            copy.adminOverviewIssuedCouponsNote,
          )}
        />
        <MetricCard
          icon="marketing"
          label={copy.adminOverviewMarketingAudience}
          value={formatCount(metrics?.marketingConsentCount)}
          note={metricNote(
            metrics?.marketingConsentCount,
            copy.adminOverviewMarketingAudienceNote,
          )}
        />
      </div>
      <details className={styles.overviewHelp}>
        <summary>{isKorean ? "집계 기준·개인정보 안내" : "Metrics & privacy"}</summary>
        <p>
          {isKorean
            ? "오늘 주문은 오늘(KST) 생성된 주문 건수로 결제 여부와 무관합니다. 오늘 매출과 판매 수량은 현재 결제완료(PAID) 상태이며 오늘(KST) 결제된 온라인 주문 기준입니다. 오프라인을 포함한 매출은 매출·일마감에서 확인하세요. 등록 쿠폰에는 초안과 일시중지 쿠폰도 포함됩니다. 제공되지 않은 지표는 0이 아닌 집계 준비 중으로 표시합니다."
            : "Today's orders count orders created today (KST), regardless of payment status. Revenue and units cover online orders currently PAID and paid today (KST). Open Sales & day close for totals including offline sales. Registered coupons include drafts and paused coupons. Unavailable metrics are not shown as zero."}
        </p>
        <p>
          {isKorean
            ? "회원 정보와 수신 동의는 관리자 권한을 확인한 API에서만 조회합니다. 마케팅 대상은 수신 동의 프로필 집계이며 채널별 발송 가능 수신자 수가 아닙니다."
            : "Member information and consent are loaded only through the administrator-authorized API. The marketing audience counts opted-in profiles, not recipients verified for delivery on each channel."}
        </p>
      </details>
    </div>
  );
}

function ProductOptionControls({
  category,
  editorId,
  onChange,
  value,
}: Readonly<{
  category: string;
  editorId: string;
  onChange: (value: string) => void;
  value: string;
}>) {
  const { locale } = useLocale();
  const isKorean = locale === "ko";
  const inputRef = useRef<HTMLInputElement>(null);
  const [deckWidth, setDeckWidth] = useState("");
  const [wheelDiameter, setWheelDiameter] = useState("");
  const [wheelHardness, setWheelHardness] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const option =
    category === "Deck"
      ? formatProductDeckOption(deckWidth)
      : category === "Wheels"
        ? formatProductWheelOption(wheelDiameter, wheelHardness)
        : null;
  const addOption = () => {
    if (!option) return;
    const result = appendProductOption(value, option);
    if (!result.ok) {
      setNotice({
        kind: "error",
        message:
          result.reason === "too-many-options"
            ? {
                ko: "옵션은 최대 20개까지 추가할 수 있습니다.",
                en: "You can add up to 20 options.",
              }
            : {
                ko: "각 옵션은 쉼표·줄바꿈 없이 50자 이하로 추가해 주세요.",
                en: "Add each option in 50 characters or fewer, without commas or line breaks.",
              },
      });
      return;
    }
    if (result.added) onChange(result.value);
    setNotice({
      kind: "success",
      message: result.added
        ? { ko: `${option} 옵션을 추가했습니다.`, en: `Added the ${option} option.` }
        : { ko: "이미 있는 옵션입니다.", en: "This option already exists." },
    });
    setDeckWidth("");
    setWheelDiameter("");
    setWheelHardness("");
  };

  return (
    <div
      className={`${styles.productOptionField} ${category === "Deck" ? styles.productDeckField : ""}`}
    >
      <label htmlFor={`product-options-${editorId}`}>
        <span>{isKorean ? "사이즈 / 옵션" : "Size / options"}</span>
        <input
          id={`product-options-${editorId}`}
          onChange={(event) => {
            setNotice(null);
            onChange(event.target.value);
          }}
          placeholder={category === "Wheels" ? "54mm / 99a" : "8.25”, 8.5”"}
          ref={inputRef}
          value={value}
        />
      </label>
      {category === "Deck" ? (
        <div className={styles.productOptionPicker}>
          <select
            aria-label={isKorean ? "데크 규격 선택" : "Choose deck width"}
            onChange={(event) => {
              setDeckWidth(event.target.value);
              setNotice(null);
              if (event.target.value === "manual") inputRef.current?.focus();
            }}
            value={deckWidth}
          >
            <option value="">{isKorean ? "규격 선택" : "Choose width"}</option>
            {PRODUCT_DECK_WIDTHS.map((width) => (
              <option key={width} value={width}>
                {width}”
              </option>
            ))}
            <option value="manual">{isKorean ? "직접 입력" : "Enter manually"}</option>
          </select>
          <button
            className={styles.secondaryButton}
            disabled={!option}
            onClick={addOption}
            type="button"
          >
            {isKorean ? "옵션 추가" : "Add option"}
          </button>
        </div>
      ) : category === "Wheels" ? (
        <>
          <div className={styles.productWheelPicker}>
            <select
              aria-label={isKorean ? "바퀴 크기 선택" : "Choose wheel size"}
              onChange={(event) => {
                setWheelDiameter(event.target.value);
                setNotice(null);
              }}
              value={wheelDiameter}
            >
              <option value="">{isKorean ? "크기 선택" : "Choose size"}</option>
              {PRODUCT_WHEEL_DIAMETERS.map((diameter) => (
                <option key={diameter} value={diameter}>
                  {diameter}mm
                </option>
              ))}
            </select>
            <select
              aria-label={isKorean ? "경도 선택" : "Choose hardness"}
              onChange={(event) => {
                setWheelHardness(event.target.value);
                setNotice(null);
              }}
              value={wheelHardness}
            >
              <option value="">{isKorean ? "경도 선택" : "Choose hardness"}</option>
              {PRODUCT_WHEEL_HARDNESSES.map((hardness) => (
                <option key={hardness} value={hardness}>
                  {hardness}a
                </option>
              ))}
            </select>
          </div>
          <button
            className={styles.secondaryButton}
            disabled={!option}
            onClick={addOption}
            type="button"
          >
            {isKorean ? "옵션 추가" : "Add option"}
          </button>
        </>
      ) : null}
      <small>
        {category === "Deck" || category === "Wheels"
          ? isKorean
            ? "선택 후 ‘옵션 추가’를 누르세요. 추가 전 선택값은 저장되지 않습니다. "
            : "After choosing, press ‘Add option’. A choice is not saved until it is added. "
          : ""}
        {isKorean
          ? "여러 옵션은 쉼표로 구분 · 최대 20개"
          : "Separate options with commas · Up to 20"}
      </small>
      {notice ? (
        <small
          className={notice.kind === "error" ? styles.productOptionError : undefined}
          role={notice.kind === "error" ? "alert" : "status"}
        >
          {localizedText(notice.message, locale)}
        </small>
      ) : null}
    </div>
  );
}

function ProductSection({
  brands,
  canSaveToServer,
  canUploadImages,
  deleting,
  draft,
  editorId,
  loading,
  lockInputs,
  notice,
  onCloseEditor,
  onDeleteProducts,
  onEditProduct,
  onImageChange,
  onOpenCreate,
  onReset,
  onSave,
  onSaveDeckSpec,
  onTextChange,
  onToggleChange,
  previewCompareAtPrice,
  previewName,
  previewPrice,
  previewSizes,
  products,
  saving,
  view,
}: Readonly<{
  brands: readonly string[];
  canSaveToServer: boolean;
  canUploadImages: boolean;
  deleting: boolean;
  draft: AdminProductDraft;
  editorId: string;
  loading: boolean;
  lockInputs: boolean;
  notice: Notice;
  onCloseEditor: () => void;
  onDeleteProducts: (
    items: ReadonlyArray<Readonly<{ id: string; version: number }>>,
  ) => void;
  onEditProduct: (product: AdminCatalogListItem) => void;
  onImageChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onOpenCreate: () => void;
  onReset: () => void;
  onSave: (event: FormEvent<HTMLFormElement>) => void;
  onSaveDeckSpec?: (deckSpec: DeckSpec | null) => Promise<void>;
  onTextChange: (
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
  onToggleChange: (field: "isVisible" | "isFeatured", value: boolean) => void;
  previewCompareAtPrice: number;
  previewName: string;
  previewPrice: number;
  previewSizes: readonly string[];
  products: readonly AdminCatalogListItem[];
  saving: boolean;
  view: "list" | "create" | "edit";
}>) {
  const { locale } = useLocale();
  const isKorean = locale === "ko";
  const previewDescriptionLines = draft.description
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const currentProduct = products.find((product) => product.id === draft.productId);
  const deckSpec = currentProduct?.deckSpec;
  // 모달은 열 때마다 새 번호를 받고, 저장 응답은 자기 번호의 모달만 닫습니다. 편집기를 벗어나면 모달을 비웁니다.
  const deckSpecSessionRef = useRef(0);
  const [deckSpecModal, setDeckSpecModal] = useState<{
    editorKey: string;
    session: number;
  } | null>(null);
  const editorKey = `${view}:${editorId}`;
  const [deckSpecEditorKey, setDeckSpecEditorKey] = useState(editorKey);
  if (deckSpecEditorKey !== editorKey) {
    setDeckSpecEditorKey(editorKey);
    setDeckSpecModal(null);
  }
  const canEditDeckSpec = Boolean(onSaveDeckSpec && draft.productId && draft.version);
  const isCurrentlyPublic = Boolean(
    currentProduct?.version && currentProduct.isVisible,
  );
  const saveLabel = !canSaveToServer
    ? isKorean
      ? "이 브라우저에 초안 보관"
      : "Keep draft in this browser"
    : draft.isVisible
      ? view === "edit" && isCurrentlyPublic
        ? isKorean
          ? "공개 상태로 수정 저장"
          : "Save changes as public"
        : isKorean
          ? "저장 후 스토어 공개"
          : "Save and publish to store"
      : view === "edit"
        ? isKorean
          ? "비공개 수정 저장"
          : "Save changes as private"
        : isKorean
          ? "비공개로 저장"
          : "Save as private";
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [filterQuery, setFilterQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "published" | "draft">(
    "all",
  );
  const [stockFilter, setStockFilter] = useState<"all" | "inStock" | "soldOut">("all");
  const [optionResetKey, setOptionResetKey] = useState(0);
  const [manualBrandEditor, setManualBrandEditor] = useState<string | null>(null);
  const brandInputRef = useRef<HTMLInputElement>(null);
  const brandChoices = useMemo(
    () =>
      mergeProductBrandNames(
        products.map((product) => product.brand),
        brands,
      ),
    [brands, products],
  );
  const selectedBrandIndex = brandChoices.indexOf(draft.brand.trim());
  const dragSelectRef = useRef<"add" | "remove" | null>(null);

  useEffect(() => {
    const endDrag = () => {
      dragSelectRef.current = null;
    };

    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", endDrag);
    return () => {
      window.removeEventListener("pointerup", endDrag);
      window.removeEventListener("pointercancel", endDrag);
    };
  }, []);

  useEffect(() => {
    const validIds = new Set(products.map((product) => product.id));
    // eslint-disable-next-line react-hooks/set-state-in-effect -- prunes deleted ids once; returns the same Set when nothing changed.
    setSelectedIds((current) => {
      const next = new Set([...current].filter((productId) => validIds.has(productId)));
      return next.size === current.size ? current : next;
    });
  }, [products]);

  const filteredProducts = useMemo(() => {
    const normalizedQuery = filterQuery.trim().toLowerCase();

    return products.filter((product) => {
      if (
        statusFilter === "published" &&
        (!product.isVisible || product.version <= 0)
      ) {
        return false;
      }

      if (statusFilter === "draft" && product.isVisible && product.version > 0) {
        return false;
      }

      if (stockFilter === "inStock" && product.stock <= 0) {
        return false;
      }

      if (stockFilter === "soldOut" && product.stock > 0) {
        return false;
      }

      if (!normalizedQuery) {
        return true;
      }

      return (
        product.name.toLowerCase().includes(normalizedQuery) ||
        product.brand.toLowerCase().includes(normalizedQuery) ||
        product.category.toLowerCase().includes(normalizedQuery) ||
        (product.sku?.toLowerCase().includes(normalizedQuery) ?? false)
      );
    });
  }, [filterQuery, products, statusFilter, stockFilter]);

  const allFilteredSelected =
    filteredProducts.length > 0 &&
    filteredProducts.every((product) => selectedIds.has(product.id));

  const applySelection = (productId: string, mode: "add" | "remove") => {
    setSelectedIds((current) => {
      const next = new Set(current);

      if (mode === "add") {
        next.add(productId);
      } else {
        next.delete(productId);
      }

      return next;
    });
  };

  const handleSelectPointerDown = (
    productId: string,
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    if (event.button !== 0) {
      return;
    }

    event.preventDefault();
    const mode = selectedIds.has(productId) ? "remove" : "add";
    dragSelectRef.current = mode;
    applySelection(productId, mode);
  };

  const handleSelectPointerEnter = (productId: string) => {
    if (!dragSelectRef.current) {
      return;
    }

    applySelection(productId, dragSelectRef.current);
  };

  const toggleSelectAllFiltered = () => {
    setSelectedIds((current) => {
      const next = new Set(current);

      if (allFilteredSelected) {
        for (const product of filteredProducts) {
          next.delete(product.id);
        }
      } else {
        for (const product of filteredProducts) {
          next.add(product.id);
        }
      }

      return next;
    });
  };

  const selectedProducts = products.filter((product) => selectedIds.has(product.id));

  const productSaved = view !== "list" && notice?.kind === "success" && !saving;
  const productSteps: AdminStep[] = [
    {
      label: isKorean ? "상품 선택" : "Select product",
      state: view === "list" ? "current" : "complete",
    },
    {
      label: isKorean ? "정보 입력" : "Enter details",
      state:
        view === "list" ? "upcoming" : saving || productSaved ? "complete" : "current",
    },
    {
      label: canSaveToServer
        ? isKorean
          ? "서버 저장·공개"
          : "Save to server & publish"
        : isKorean
          ? "서버 저장"
          : "Save to server",
      state: !canSaveToServer
        ? "unavailable"
        : productSaved
          ? "complete"
          : saving
            ? "current"
            : "upcoming",
    },
  ];
  const productStepper = (
    <AdminStepper
      className={styles.screenStepper}
      label={isKorean ? "상품 작업 흐름" : "Product workflow"}
      locale={locale}
      steps={productSteps}
    />
  );

  if (view === "list") {
    return (
      <div className={`${styles.sectionStack} ${styles.productScreen}`}>
        {productStepper}
        <div className={styles.productListHeader}>
          <div className={styles.productPageHeading}>
            <h2>{isKorean ? "상품 관리" : "Products"}</h2>
            <p>
              {isKorean
                ? "상품의 공개 상태와 재고를 확인하세요."
                : "Check each product's visibility and stock."}
            </p>
          </div>
          <div className={styles.productListHeaderActions}>
            <button
              aria-label={isKorean ? "새 상품 등록" : "Register new product"}
              className={styles.addProductButton}
              onClick={onOpenCreate}
              type="button"
            >
              <span aria-hidden="true">＋</span> {isKorean ? "새 상품" : "New product"}
            </button>
          </div>
        </div>
        {notice ? <NoticeMessage notice={notice} /> : null}
        <div className={styles.productToolbar}>
          <label className={styles.productFilterSearch}>
            <span className={styles.srOnly}>
              {isKorean ? "상품 검색" : "Search products"}
            </span>
            <input
              onChange={(event) => setFilterQuery(event.target.value)}
              placeholder={
                isKorean ? "상품명 · 브랜드 · SKU 검색" : "Search name · brand · SKU"
              }
              type="search"
              value={filterQuery}
            />
          </label>
          <label className={styles.productFilterSelect}>
            <span>{isKorean ? "상태" : "Status"}</span>
            <select
              onChange={(event) =>
                setStatusFilter(event.target.value as "all" | "published" | "draft")
              }
              value={statusFilter}
            >
              <option value="all">{isKorean ? "전체" : "All"}</option>
              <option value="published">{isKorean ? "공개" : "Public"}</option>
              <option value="draft">{isKorean ? "비공개" : "Private"}</option>
            </select>
          </label>
          <label className={styles.productFilterSelect}>
            <span>{isKorean ? "재고" : "Stock"}</span>
            <select
              onChange={(event) =>
                setStockFilter(event.target.value as "all" | "inStock" | "soldOut")
              }
              value={stockFilter}
            >
              <option value="all">{isKorean ? "전체" : "All"}</option>
              <option value="inStock">{isKorean ? "재고 있음" : "In stock"}</option>
              <option value="soldOut">{isKorean ? "품절" : "Sold out"}</option>
            </select>
          </label>
        </div>
        <div className={styles.productSelectionBar}>
          <button
            aria-pressed={allFilteredSelected}
            className={styles.productSelectAllHit}
            onClick={toggleSelectAllFiltered}
            type="button"
          >
            <span
              aria-hidden="true"
              aria-checked={allFilteredSelected}
              className={styles.productCheckbox}
            />
            <span>{isKorean ? "전체 선택" : "Select all"}</span>
          </button>
          <button
            className={styles.productBulkDeleteButton}
            disabled={deleting || selectedProducts.length === 0}
            onClick={() =>
              onDeleteProducts(
                selectedProducts.map((product) => ({
                  id: product.id,
                  version: product.version,
                })),
              )
            }
            type="button"
          >
            {deleting
              ? isKorean
                ? "삭제 중…"
                : "Deleting…"
              : selectedProducts.length > 0
                ? isKorean
                  ? `선택 삭제 (${selectedProducts.length})`
                  : `Delete selected (${selectedProducts.length})`
                : isKorean
                  ? "선택 삭제"
                  : "Delete selected"}
          </button>
        </div>
        {loading ? (
          <p className={styles.productListEmpty}>
            {isKorean ? "상품 목록을 불러오는 중…" : "Loading products…"}
          </p>
        ) : filteredProducts.length === 0 ? (
          <p className={styles.productListEmpty}>
            {products.length === 0
              ? isKorean
                ? "아직 등록된 상품이 없습니다. 새 상품을 추가해 보세요."
                : "No products yet. Add a new product."
              : isKorean
                ? "필터 조건에 맞는 상품이 없습니다."
                : "No products match the filters."}
          </p>
        ) : (
          <ul
            aria-label={isKorean ? "상품 목록" : "Product list"}
            className={styles.productList}
          >
            {filteredProducts.map((product) => {
              const isSelected = selectedIds.has(product.id);

              return (
                <li
                  className={
                    isSelected
                      ? `${styles.productListItem} ${styles.productListItemSelected}`
                      : styles.productListItem
                  }
                  key={product.id}
                >
                  <button
                    aria-label={
                      isKorean ? `${product.name} 선택` : `Select ${product.name}`
                    }
                    aria-pressed={isSelected}
                    className={styles.productSelectHit}
                    onClick={(event) => {
                      if (event.detail === 0) {
                        applySelection(product.id, isSelected ? "remove" : "add");
                      }
                    }}
                    onPointerDown={(event) =>
                      handleSelectPointerDown(product.id, event)
                    }
                    onPointerEnter={() => handleSelectPointerEnter(product.id)}
                    type="button"
                  >
                    <span
                      aria-hidden="true"
                      aria-checked={isSelected}
                      className={styles.productCheckbox}
                    />
                  </button>
                  <div className={styles.productListIdentity}>
                    <AdminProductImage alt="" compact src={product.imageUrl} />
                    <div className={styles.productListMain}>
                      <strong>{product.name}</strong>
                      <span>
                        {product.brand} · {product.category}
                      </span>
                      {product.sku ? <small>{product.sku}</small> : null}
                    </div>
                  </div>
                  <div className={styles.productRowMeta}>
                    <span className={styles.productStock}>
                      {isKorean ? "재고" : "Stock"} {product.stock}{" "}
                      <StockStatusBadge locale={locale} stock={product.stock} />
                    </span>
                    <span className={styles.productPrice}>
                      {moneyFormatter.format(product.price)}
                    </span>
                    <span
                      className={
                        product.isVisible && product.version > 0
                          ? styles.publicStatus
                          : styles.draftStatus
                      }
                    >
                      {product.version <= 0
                        ? isKorean
                          ? "로컬 초안"
                          : "Local draft"
                        : product.isVisible
                          ? isKorean
                            ? "공개"
                            : "Public"
                          : isKorean
                            ? "비공개"
                            : "Private"}
                    </span>
                  </div>
                  <div className={styles.productRowActions}>
                    <button
                      className={styles.productRowEditButton}
                      onClick={() => onEditProduct(product)}
                      type="button"
                    >
                      {isKorean ? "수정" : "Edit"}
                    </button>
                    <button
                      className={styles.productRowDeleteButton}
                      disabled={deleting}
                      onClick={() =>
                        onDeleteProducts([{ id: product.id, version: product.version }])
                      }
                      type="button"
                    >
                      {isKorean ? "삭제" : "Delete"}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    );
  }

  const editorTitle =
    view === "edit"
      ? isKorean
        ? "상품 수정"
        : "Edit product"
      : isKorean
        ? "새 상품"
        : "New product";

  return (
    <div className={`${styles.sectionStack} ${styles.productScreen}`}>
      {productStepper}
      <div className={styles.productEditorToolbar}>
        <button
          className={styles.backToListButton}
          onClick={onCloseEditor}
          type="button"
        >
          {isKorean ? "← 목록으로" : "← Back to list"}
        </button>
      </div>
      <div className={`${styles.productPageHeading} ${styles.productCompactHeading}`}>
        <div>
          <div className={styles.productEditorTitle}>
            <h2>{editorTitle}</h2>
            <span className={styles.productSaveState}>
              {canSaveToServer
                ? draft.isVisible
                  ? isKorean
                    ? "공개 설정 · 저장 전"
                    : "Public · Not saved"
                  : isKorean
                    ? "비공개 · 저장 전"
                    : "Private · Not saved"
                : isKorean
                  ? "로컬 초안 · 서버 미연결"
                  : "Local draft · No server"}
            </span>
          </div>
          {view === "edit" && currentProduct?.version ? (
            <p>
              {isKorean ? "현재" : "Now"}{" "}
              {isCurrentlyPublic
                ? isKorean
                  ? "공개"
                  : "Public"
                : isKorean
                  ? "비공개"
                  : "Private"}{" "}
              → {isKorean ? "저장 후" : "after saving"}{" "}
              {draft.isVisible
                ? isKorean
                  ? "공개"
                  : "Public"
                : isKorean
                  ? "비공개"
                  : "Private"}
            </p>
          ) : null}
        </div>
        <label className={styles.productManagementCode}>
          <span>{isKorean ? "SKU / 관리 코드" : "SKU / code"}</span>
          <input
            readOnly
            value={draft.sku}
            placeholder={isKorean ? "기존 관리 코드 없음" : "No existing code"}
          />
        </label>
      </div>
      <div className={styles.productEditor}>
        <form
          className={styles.editorForm}
          noValidate
          onSubmit={onSave}
          aria-busy={lockInputs}
        >
          <fieldset
            className={`${styles.formGroup} ${styles.productFormGrid}`}
            disabled={lockInputs}
          >
            <legend>{isKorean ? "기본 정보" : "Basics"}</legend>
            <label>
              <span>
                {isKorean ? "상품명" : "Product name"} <em>*</em>
              </span>
              <input
                onChange={(event) => onTextChange("name", event.target.value)}
                placeholder={
                  isKorean ? "예: O'Dwyer Deck [8.25”]" : "e.g. O'Dwyer Deck [8.25”]"
                }
                required
                value={draft.name}
              />
            </label>
            <div className={styles.productBrandField}>
              <label htmlFor={`product-brand-${editorId}`}>
                <span>
                  {isKorean ? "브랜드" : "Brand"} <em>*</em>
                </span>
              </label>
              <div className={styles.productBrandControls}>
                <input
                  id={`product-brand-${editorId}`}
                  maxLength={100}
                  onChange={(event) => onTextChange("brand", event.target.value)}
                  placeholder={isKorean ? "직접 입력" : "Enter manually"}
                  ref={brandInputRef}
                  required
                  value={draft.brand}
                />
                <select
                  aria-label={isKorean ? "브랜드 선택" : "Choose brand"}
                  onChange={(event) => {
                    if (event.target.value === "manual") {
                      setManualBrandEditor(editorId);
                      brandInputRef.current?.focus();
                    } else if (event.target.value !== "") {
                      setManualBrandEditor(null);
                      const brand = brandChoices[Number(event.target.value)];
                      if (brand) onTextChange("brand", brand);
                    }
                  }}
                  value={
                    manualBrandEditor === editorId
                      ? "manual"
                      : selectedBrandIndex >= 0
                        ? String(selectedBrandIndex)
                        : draft.brand.trim()
                          ? "manual"
                          : ""
                  }
                >
                  <option value="">{isKorean ? "선택" : "Choose"}</option>
                  {brandChoices.map((brand, index) => (
                    <option key={brand} value={index}>
                      {brand}
                    </option>
                  ))}
                  <option value="manual">{isKorean ? "기타" : "Other"}</option>
                </select>
              </div>
            </div>
            <label>
              <span>{isKorean ? "카테고리" : "Category"}</span>
              <select
                onChange={(event) => onTextChange("category", event.target.value)}
                value={draft.category}
              >
                <option value="Deck">{isKorean ? "데크" : "Deck"}</option>
                <option value="Complete">{isKorean ? "컴플리트" : "Complete"}</option>
                <option value="Trucks">{isKorean ? "트럭" : "Trucks"}</option>
                <option value="Wheels">{isKorean ? "휠" : "Wheels"}</option>
                <option value="Bearings">{isKorean ? "베어링" : "Bearings"}</option>
                <option value="Top">{isKorean ? "상의" : "Tops"}</option>
                <option value="Bottom">{isKorean ? "하의" : "Bottoms"}</option>
                <option value="Accessories">
                  {isKorean ? "액세서리" : "Accessories"}
                </option>
              </select>
            </label>
          </fieldset>

          <fieldset
            className={`${styles.formGroup} ${styles.productFormGrid}`}
            disabled={lockInputs}
          >
            <legend>{isKorean ? "판매 정보" : "Pricing"}</legend>
            <label>
              <span>
                {isKorean ? "판매가" : "Price"} <em>*</em>
              </span>
              <input
                inputMode="numeric"
                min="0"
                onChange={(event) => onTextChange("price", event.target.value)}
                placeholder="108000"
                required
                type="number"
                value={draft.price}
              />
            </label>
            <label>
              <span>
                {view === "edit"
                  ? isKorean
                    ? "재고 수량"
                    : "Stock"
                  : isKorean
                    ? "최초 재고"
                    : "Initial stock"}
              </span>
              <input
                inputMode="numeric"
                min="0"
                onChange={(event) => onTextChange("stock", event.target.value)}
                placeholder="0"
                type="number"
                value={draft.stock}
              />
            </label>
            <ProductOptionControls
              category={draft.category}
              editorId={editorId}
              key={`${editorId}:${draft.category}:${optionResetKey}`}
              onChange={(value) => onTextChange("sizes", value)}
              value={draft.sizes}
            />
            {draft.category === "Deck" ? (
              <div className={styles.productLegacyPrice}>
                <span>
                  {isKorean ? "상세사이즈" : "Size chart"}
                  <strong>
                    {deckSpec
                      ? `${formatDeckInches(deckSpec.width)} × ${formatDeckInches(deckSpec.length)} · WB ${formatDeckInches(deckSpec.wheelbase)}`
                      : isKorean
                        ? "미등록"
                        : "Not set"}
                  </strong>
                </span>
                <button
                  className={styles.secondaryButton}
                  disabled={!canEditDeckSpec}
                  onClick={() =>
                    setDeckSpecModal({
                      editorKey,
                      session: ++deckSpecSessionRef.current,
                    })
                  }
                  type="button"
                >
                  {deckSpec
                    ? isKorean
                      ? "상세사이즈 수정"
                      : "Edit size chart"
                    : isKorean
                      ? "+ 상세사이즈 등록"
                      : "+ Add size chart"}
                </button>
                {onSaveDeckSpec && deckSpecModal?.editorKey === editorKey ? (
                  <AdminDeckSpecModal
                    initialSpec={deckSpec}
                    isOpen
                    key={deckSpecModal.session}
                    onCancel={() => setDeckSpecModal(null)}
                    onSave={async (next) => {
                      const { session } = deckSpecModal;
                      await onSaveDeckSpec(next);
                      setDeckSpecModal((current) =>
                        current?.session === session ? null : current,
                      );
                    }}
                    productName={previewName}
                  />
                ) : null}
                {canEditDeckSpec ? (
                  <small>
                    {isKorean
                      ? "모달의 저장 버튼을 누르면 바로 반영됩니다."
                      : "Saving in the dialog applies it right away."}
                  </small>
                ) : (
                  <small>
                    {onSaveDeckSpec
                      ? isKorean
                        ? "상품을 먼저 저장하면 등록할 수 있습니다."
                        : "Save the product first to add it."
                      : isKorean
                        ? "서버에 연결된 관리자 화면에서만 등록할 수 있습니다."
                        : "Available only on an admin screen connected to the server."}
                  </small>
                )}
              </div>
            ) : null}
            {view === "edit" && draft.compareAtPrice ? (
              <div className={styles.productLegacyPrice}>
                <span>
                  {isKorean ? "기존 정가" : "Original price"}{" "}
                  <strong>{moneyFormatter.format(previewCompareAtPrice)}</strong>
                </span>
                <button
                  className={styles.secondaryButton}
                  onClick={() => {
                    if (
                      window.confirm(
                        isKorean
                          ? "기존 정가를 제거할까요? 저장하면 할인 전 가격 표시가 사라집니다."
                          : "Remove the original price? Once saved, the pre-discount price is no longer shown.",
                      )
                    )
                      onTextChange("compareAtPrice", "");
                  }}
                  type="button"
                >
                  {isKorean ? "기존 정가 제거" : "Remove original price"}
                </button>
                <small>
                  {isKorean
                    ? "기존 값 유지 중 · 제거는 저장 후 반영"
                    : "Keeping the current value · Removal applies after saving"}
                </small>
              </div>
            ) : view === "edit" && currentProduct?.compareAtPrice ? (
              <p className={styles.productLegacyPrice} role="status">
                {isKorean
                  ? "기존 정가 제거 예정 · 저장 전"
                  : "Original price will be removed · Not saved"}
              </p>
            ) : null}
          </fieldset>

          <fieldset
            className={`${styles.formGroup} ${styles.productImageGroup}`}
            disabled={lockInputs}
          >
            <legend>{isKorean ? "대표 이미지" : "Main image"}</legend>
            <div className={styles.productImageUpload}>
              {/* 선택한 파일의 blob URL은 기존 편집 세션이 해제합니다. 추가 URL을 만들지 않습니다. */}
              <AdminProductImage
                alt={isKorean ? "선택한 대표 이미지" : "Selected main image"}
                className={styles.productImageThumb}
                compact
                src={draft.imageUrl}
              />
              <label className={styles.uploadField}>
                <span>{isKorean ? "대표 이미지" : "Main image"}</span>
                <input
                  accept="image/jpeg,image/png,image/webp,image/gif"
                  onChange={onImageChange}
                  type="file"
                />
                <small>
                  {isKorean
                    ? "JPEG·PNG·WebP·GIF · 최대 6MB"
                    : "JPEG·PNG·WebP·GIF · Up to 6MB"}
                  {canUploadImages
                    ? isKorean
                      ? " · 저장할 때 업로드"
                      : " · Uploads on save"
                    : isKorean
                      ? " · 업로드 연결 필요"
                      : " · Upload needs a connection"}
                </small>
              </label>
            </div>
          </fieldset>
          <fieldset className={styles.formGroup} disabled={lockInputs}>
            <legend>{isKorean ? "상품 설명" : "Description"}</legend>
            <label className={styles.fieldWide}>
              <span>{isKorean ? "상품 설명" : "Description"}</span>
              <textarea
                onChange={(event) => onTextChange("description", event.target.value)}
                placeholder={
                  isKorean
                    ? "소재·특징·관리 방법 등을 입력하세요.\n줄바꿈으로 항목을 구분합니다."
                    : "Enter materials, features, care and so on.\nSeparate items with line breaks."
                }
                rows={4}
                value={draft.description}
              />
            </label>
          </fieldset>
          <fieldset className={styles.formGroup} disabled={lockInputs}>
            <legend>{isKorean ? "공개 설정" : "Visibility"}</legend>
            <div className={styles.toggleRows}>
              <label className={styles.checkRow}>
                <input
                  checked={draft.isVisible}
                  disabled={!canSaveToServer}
                  onChange={(event) =>
                    onToggleChange("isVisible", event.target.checked)
                  }
                  type="checkbox"
                />
                <span>
                  {isKorean ? "저장 후 스토어에 공개" : "Publish to store after saving"}
                </span>
              </label>
              <label className={styles.checkRow}>
                <input
                  checked={draft.isFeatured}
                  onChange={(event) =>
                    onToggleChange("isFeatured", event.target.checked)
                  }
                  type="checkbox"
                />
                <span>{isKorean ? "신상품 배지 표시" : "Show New badge"}</span>
              </label>
            </div>
            {!canSaveToServer ? (
              <small>
                {isKorean
                  ? "관리자 API 연결 후 공개할 수 있습니다."
                  : "You can publish once the admin API is connected."}
              </small>
            ) : null}
          </fieldset>

          {notice ? <NoticeMessage notice={notice} /> : null}
          {!canSaveToServer ? (
            <p className={styles.productStorageNote} role="status">
              {isKorean
                ? "서버 미연결 · 이 브라우저에만 보관되며 새로고침하면 사라집니다. 스토어에는 공개되지 않습니다."
                : "No server connection · Kept only in this browser and lost on refresh. Not published to the store."}
            </p>
          ) : null}
          <div className={styles.formActions}>
            <button
              className={styles.secondaryButton}
              disabled={lockInputs}
              onClick={() => {
                setOptionResetKey((current) => current + 1);
                setManualBrandEditor(null);
                onReset();
              }}
              type="button"
            >
              {view === "edit"
                ? isKorean
                  ? "입력 초기화"
                  : "Reset input"
                : isKorean
                  ? "새 초안"
                  : "New draft"}
            </button>
            <button className={styles.primaryButton} disabled={saving} type="submit">
              {saving
                ? lockInputs
                  ? isKorean
                    ? "저장 중…"
                    : "Saving…"
                  : isKorean
                    ? "다른 상품 저장 중…"
                    : "Saving another product…"
                : saveLabel}
            </button>
          </div>
          <p className={styles.productSaveHint}>
            {canSaveToServer
              ? draft.isVisible
                ? isKorean
                  ? "저장 직전에 공개 내용을 한 번 더 확인합니다."
                  : "You will confirm the public content once more before saving."
                : isKorean
                  ? "비공개 상품은 고객에게 표시되지 않습니다."
                  : "Private products are not shown to customers."
              : isKorean
                ? "서버 저장·공개는 관리자 API 연결 후 가능합니다."
                : "Saving to the server and publishing need the admin API connection."}
          </p>
        </form>

        <aside
          className={`${styles.previewPanel} ${styles.productPreview}`}
          aria-label={isKorean ? "고객 화면 미리보기" : "Customer preview"}
        >
          <div className={styles.previewHeader}>
            <div>
              <h2>{isKorean ? "고객 화면 미리보기" : "Customer preview"}</h2>
            </div>
            <span className={styles.productSaveState}>
              {canSaveToServer
                ? draft.isVisible
                  ? isKorean
                    ? "공개 예정"
                    : "Will be public"
                  : isKorean
                    ? "비공개"
                    : "Private"
                : isKorean
                  ? "로컬 미리보기"
                  : "Local preview"}
            </span>
          </div>
          <article className={styles.storeCardPreview}>
            <div className={styles.storeCardDetail}>
              <div className={styles.storeCardInfo}>
                <p className={styles.productPreviewBrand}>
                  {draft.brand.trim() || (isKorean ? "브랜드" : "Brand")}
                </p>
                <h3>{previewName}</h3>
                <div className={styles.productPreviewPrice}>
                  <span>
                    {previewPrice > 0
                      ? moneyFormatter.format(previewPrice)
                      : isKorean
                        ? "판매가 입력"
                        : "Enter price"}
                    {previewCompareAtPrice > previewPrice && previewPrice > 0 ? (
                      <s>{moneyFormatter.format(previewCompareAtPrice)}</s>
                    ) : null}
                  </span>
                </div>

                <div className={styles.storeCardOptions}>
                  <fieldset>
                    <legend>{isKorean ? "옵션" : "Options"}</legend>
                    {previewSizes.length > 0 ? (
                      <div
                        className={styles.storeCardSizes}
                        aria-label={isKorean ? "선택 가능한 옵션" : "Available options"}
                      >
                        {previewSizes.map((size, index) => (
                          <span
                            className={
                              index === 0 ? styles.storeCardSizeActive : undefined
                            }
                            key={size}
                          >
                            {size}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className={styles.previewHint}>
                        {isKorean ? "옵션 미입력" : "No options"}
                      </span>
                    )}
                  </fieldset>
                </div>

                {previewDescriptionLines.length > 0 ? (
                  <details className={styles.productPreviewDescription}>
                    <summary>
                      {isKorean ? "상품 설명 보기" : "View description"}
                    </summary>
                    <ul className={styles.storeCardDescription}>
                      {previewDescriptionLines.map((line, index) => (
                        <li key={`${index}:${line}`}>{line}</li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </div>

              <div className={styles.storeCardMedia}>
                {draft.isFeatured ? <span className={styles.newBadge}>NEW</span> : null}
                {/* 파일 선택으로 생긴 blob URL은 정적 export의 이미지 최적화 경로를 거치지 않습니다. */}
                <AdminProductImage
                  alt={
                    isKorean
                      ? `${previewName} 상품 이미지 미리보기`
                      : `${previewName} product image preview`
                  }
                  src={draft.imageUrl}
                />
              </div>
            </div>
            <footer>
              <span>{draft.category}</span>
              <span
                className={draft.isVisible ? styles.publicStatus : styles.draftStatus}
              >
                {canSaveToServer
                  ? draft.isVisible
                    ? isKorean
                      ? "저장 후 공개"
                      : "Public after saving"
                    : isKorean
                      ? "비공개 저장 예정"
                      : "Will be saved as private"
                  : isKorean
                    ? "서버 미저장"
                    : "Not saved to server"}
              </span>
            </footer>
          </article>
          <p className={styles.previewNote}>
            {canSaveToServer
              ? view === "edit"
                ? isKorean
                  ? "입력한 변경 내용은 저장 후 반영됩니다."
                  : "Your changes apply after saving."
                : isKorean
                  ? "아직 고객에게 보이지 않습니다."
                  : "Not visible to customers yet."
              : isKorean
                ? "서버 연결 전에는 실제 저장·공개되지 않습니다."
                : "Nothing is actually saved or published until the server is connected."}
          </p>
        </aside>
      </div>
    </div>
  );
}

function InventorySection({
  canUpdateStock,
  loadFailed,
  loading,
  notice,
  onChangeStock,
  onRefresh,
  products,
  savingIds,
}: Readonly<{
  canUpdateStock: boolean;
  loadFailed: boolean;
  loading: boolean;
  notice: Notice;
  onChangeStock: (
    productId: string,
    stock: number,
    expected: Readonly<{ version: number; stock: number }>,
  ) => Promise<AdminCatalogListItem | null>;
  onRefresh: () => Promise<readonly AdminCatalogListItem[] | null>;
  products: readonly AdminCatalogListItem[];
  savingIds: ReadonlySet<string>;
}>) {
  const [filterQuery, setFilterQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [brandFilter, setBrandFilter] = useState("");
  const [stockFilter, setStockFilter] = useState<"all" | "inStock" | "low" | "soldOut">(
    "all",
  );
  const categoryChoices = useMemo(() => {
    const labels = new Map([
      ["Deck", "데크"],
      ["Complete", "컴플리트"],
      ["Trucks", "트럭"],
      ["Wheels", "휠"],
      ["Bearings", "베어링"],
      ["Top", "상의"],
      ["Bottom", "하의"],
      ["Outerwear", "아우터"],
      ["Shoes", "신발"],
      ["Accessories", "액세서리"],
      ["Hardware", "하드웨어"],
      ["Protection", "보호장비"],
      ["Other", "기타"],
    ]);
    for (const category of [
      ...products.map((product) => product.category),
      categoryFilter,
    ]) {
      if (category.trim() && !labels.has(category)) {
        labels.set(category, category);
      }
    }
    return [...labels.entries()];
  }, [categoryFilter, products]);
  const brandChoices = useMemo(
    () =>
      [...new Set([...products.map((product) => product.brand), brandFilter])]
        .filter((brand) => brand.trim())
        .sort((left, right) => left.localeCompare(right, "ko")),
    [brandFilter, products],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const inventoryFocusFrameRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (inventoryFocusFrameRef.current !== null)
        window.cancelAnimationFrame(inventoryFocusFrameRef.current);
    },
    [],
  );
  const selectedProduct = products.find((product) => product.id === selectedId);
  const selectInventoryProduct = (id: string) => {
    setSelectedId(id);
    if (inventoryFocusFrameRef.current !== null)
      window.cancelAnimationFrame(inventoryFocusFrameRef.current);
    if (window.matchMedia("(max-width: 1200px)").matches) {
      inventoryFocusFrameRef.current = window.requestAnimationFrame(() => {
        inventoryFocusFrameRef.current = null;
        const heading = document.getElementById("inventory-adjustment-title");
        if (heading?.dataset.productId !== id) return;
        heading?.focus({ preventScroll: true });
        heading?.scrollIntoView({ behavior: "instant", block: "start" });
      });
    }
  };

  const filteredProducts = useMemo(() => {
    const query = filterQuery.trim().toLowerCase();

    return products
      .filter((product) => {
        if (categoryFilter && product.category !== categoryFilter) {
          return false;
        }

        if (brandFilter && product.brand !== brandFilter) {
          return false;
        }

        if (query) {
          const haystack =
            `${product.name} ${product.brand} ${product.sku ?? ""} ${product.category}`.toLowerCase();
          if (!haystack.includes(query)) {
            return false;
          }
        }

        if (stockFilter === "inStock" && product.stock <= 0) {
          return false;
        }

        if (stockFilter === "soldOut" && product.stock > 0) {
          return false;
        }

        if (stockFilter === "low" && (product.stock <= 0 || product.stock > 5)) {
          return false;
        }

        return true;
      })
      .slice()
      .sort((left, right) => left.name.localeCompare(right.name, "ko"));
  }, [brandFilter, categoryFilter, filterQuery, products, stockFilter]);

  const stockSaving = Boolean(selectedProduct && savingIds.has(selectedProduct.id));
  const stockSaved =
    Boolean(selectedProduct) && notice?.kind === "success" && !stockSaving;
  const inventorySteps: AdminStep[] = [
    { label: "상품 선택", state: selectedProduct ? "complete" : "current" },
    {
      label: "변경 수량 확인",
      state: !selectedProduct
        ? "upcoming"
        : stockSaving || stockSaved
          ? "complete"
          : "current",
    },
    {
      label: "재고 저장",
      state: !canUpdateStock
        ? "unavailable"
        : stockSaved
          ? "complete"
          : stockSaving
            ? "current"
            : "upcoming",
    },
  ];
  return (
    <div className={`${styles.sectionStack} ${styles.inventoryScreen}`}>
      <AdminStepper
        className={styles.screenStepper}
        label="재고 작업 흐름"
        steps={inventorySteps}
      />
      <div className={styles.productPageHeading}>
        <h2>재고 관리</h2>
        <p>상품을 선택하고 변경 전후 수량을 확인하세요.</p>
      </div>

      <div className={styles.inventoryToolbar}>
        <label className={styles.inventorySearch}>
          <span className="srOnly">상품 검색</span>
          <input
            onChange={(event) => setFilterQuery(event.target.value)}
            placeholder="상품명·브랜드·SKU 검색"
            type="search"
            value={filterQuery}
          />
        </label>
        <label className={styles.inventoryFilter}>
          <span>카테고리</span>
          <select
            onChange={(event) => setCategoryFilter(event.target.value)}
            value={categoryFilter}
          >
            <option value="">전체 카테고리</option>
            {categoryChoices.map(([category, label]) => (
              <option key={category} value={category}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.inventoryFilter}>
          <span>브랜드</span>
          <select
            onChange={(event) => setBrandFilter(event.target.value)}
            value={brandFilter}
          >
            <option value="">전체 브랜드</option>
            {brandChoices.map((brand) => (
              <option key={brand} value={brand}>
                {brand}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.inventoryFilter}>
          <span>재고</span>
          <select
            onChange={(event) =>
              setStockFilter(
                event.target.value as "all" | "inStock" | "low" | "soldOut",
              )
            }
            value={stockFilter}
          >
            <option value="all">전체</option>
            <option value="inStock">재고 있음</option>
            <option value="low">재고 주의(1~5)</option>
            <option value="soldOut">품절</option>
          </select>
        </label>
        <button
          className={styles.secondaryButton}
          disabled={loading}
          onClick={() => void onRefresh()}
          type="button"
        >
          새로고침
        </button>
      </div>

      {notice ? <NoticeMessage notice={notice} /> : null}
      {loadFailed && !notice ? (
        <p className={styles.noticeError} role="alert">
          재고 목록을 불러오지 못했습니다. 새로고침으로 다시 확인해 주세요.
        </p>
      ) : null}

      <div className={styles.inventoryWorkspace}>
        <div className={styles.inventoryPanel} aria-busy={loading}>
          <div className={styles.listPanelHeading}>
            <h2>상품 재고 목록</h2>
            <span>{filteredProducts.length}</span>
          </div>

          {loading && products.length === 0 ? (
            <p className={styles.emptyState}>재고 목록을 불러오는 중…</p>
          ) : null}

          {!loading && !loadFailed && filteredProducts.length === 0 ? (
            <div className={styles.emptyState}>
              <strong>표시할 상품이 없습니다</strong>
              <p>상품 등록에서 상품을 추가하거나 검색 조건을 바꿔 보세요.</p>
            </div>
          ) : null}

          {filteredProducts.length > 0 ? (
            <ul className={styles.inventoryList}>
              {filteredProducts.map((product) => {
                return (
                  <li className={styles.inventoryRow} key={product.id}>
                    <button
                      aria-label={`${product.name} 재고 조정`}
                      aria-pressed={selectedId === product.id}
                      className={styles.inventorySelect}
                      onClick={() => selectInventoryProduct(product.id)}
                      type="button"
                    >
                      <AdminProductImage alt="" compact src={product.imageUrl} />
                      <div className={styles.inventoryMeta}>
                        <strong>{product.name}</strong>
                        <span>
                          {product.brand} · {product.category}
                          {product.sku ? ` · ${product.sku}` : ""}
                        </span>
                        <span>
                          {product.sizes || "옵션 없음"} ·{" "}
                          {product.version < 1
                            ? "로컬 초안"
                            : product.isVisible
                              ? "공개"
                              : "비공개"}
                        </span>
                      </div>
                      <div className={styles.inventoryQuantity}>
                        <strong>{product.stock}개</strong>
                        <StockStatusBadge stock={product.stock} />
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
        {selectedProduct ? (
          <StockStepper
            key={selectedProduct.id}
            canUpdateStock={canUpdateStock}
            disabled={loading || savingIds.has(selectedProduct.id)}
            onCommit={(stock, expected) =>
              onChangeStock(selectedProduct.id, stock, expected)
            }
            onReload={onRefresh}
            product={selectedProduct}
          />
        ) : (
          <aside className={styles.inventoryAdjustment} aria-label="재고 조정">
            <h2>재고 조정</h2>
            <div className={styles.emptyState}>
              <strong>상품을 선택하세요</strong>
              <p>목록에서 상품을 선택하면 변경 수량을 미리 확인할 수 있습니다.</p>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

function StockStepper({
  canUpdateStock,
  disabled = false,
  onCommit,
  onReload,
  product,
}: Readonly<{
  canUpdateStock: boolean;
  disabled?: boolean;
  onCommit: (
    stock: number,
    expected: Readonly<{ version: number; stock: number }>,
  ) => Promise<AdminCatalogListItem | null>;
  onReload: () => Promise<readonly AdminCatalogListItem[] | null>;
  product: AdminCatalogListItem;
}>) {
  const [snapshot, setSnapshot] = useState({
    stock: product.stock,
    version: product.version,
  });
  const [draft, setDraft] = useState(String(product.stock));
  const [reviewRequired, setReviewRequired] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [lastSaved, setLastSaved] = useState<"remote" | "local" | null>(null);
  const committingRef = useRef(false);
  const remote = canUpdateStock && product.version > 0;
  const stale =
    snapshot.version !== product.version || snapshot.stock !== product.stock;
  const parsed = /^\d+$/.test(draft) ? Number(draft) : NaN;
  const valid = Number.isInteger(parsed) && parsed >= 0 && parsed <= 1_000_000;
  const changed = valid && parsed !== snapshot.stock;
  const locked = disabled || saving || reloading;
  const delta = valid ? parsed - snapshot.stock : null;
  const statusLabel = saving
    ? "저장 중"
    : stale || reviewRequired
      ? "최신 재고 확인 필요"
      : lastSaved === "remote"
        ? "저장 완료"
        : lastSaved === "local"
          ? "임시 변경 · 서버 미저장"
          : "미리보기 · 아직 미반영";

  const updateDraft = (value: string) => {
    setDraft(value);
    setLastSaved(null);
  };
  const handleUseLatest = async () => {
    if (locked) return;
    setReloading(true);
    try {
      const latest = remote
        ? (await onReload())?.find((item) => item.id === product.id)
        : product;
      if (!latest) {
        setReviewRequired(true);
        return;
      }
      setSnapshot({ stock: latest.stock, version: latest.version });
      setDraft(String(latest.stock));
      setReviewRequired(false);
      setLastSaved(null);
    } finally {
      setReloading(false);
    }
  };
  const commitDraft = async () => {
    if (locked || committingRef.current || stale || reviewRequired || !changed) return;
    const target = remote ? "서버 재고" : "이 화면의 임시 수량";
    if (
      !window.confirm(
        `${product.name}\n현재 ${snapshot.stock}개 → 변경 후 ${parsed}개 (${delta! >= 0 ? "+" : ""}${delta}개)\n${target}을 변경할까요?`,
      )
    )
      return;
    committingRef.current = true;
    setSaving(true);
    try {
      const updated = await onCommit(parsed, snapshot);
      if (!updated) {
        setReviewRequired(true);
        return;
      }
      setSnapshot({ stock: updated.stock, version: updated.version });
      setDraft(String(updated.stock));
      setReviewRequired(false);
      setLastSaved(remote ? "remote" : "local");
    } finally {
      committingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <aside
      className={styles.inventoryAdjustment}
      aria-label="재고 조정"
      aria-busy={locked}
    >
      <div className={styles.inventoryAdjustmentHeader}>
        <h2 id="inventory-adjustment-title" tabIndex={-1} data-product-id={product.id}>
          재고 조정
        </h2>
        <span className={styles.productSaveState} role="status">
          {statusLabel}
        </span>
      </div>
      <div className={styles.inventorySelectedProduct}>
        <AdminProductImage alt="" compact src={product.imageUrl} />
        <div>
          <strong>{product.name}</strong>
          <span>
            {product.brand} · {product.sizes || "옵션 없음"}
          </span>
          <span>
            {product.version < 1 ? "로컬 초안" : product.isVisible ? "공개" : "비공개"}
          </span>
        </div>
      </div>
      {!remote ? (
        <p className={styles.productStorageNote}>
          이 화면에서만 수량을 변경합니다. 서버 재고에는 반영되지 않습니다.
        </p>
      ) : null}
      <label className={styles.inventoryQuantityLabel} htmlFor="inventory-next-stock">
        변경 후 재고 수량
      </label>
      <div className={styles.stockStepper}>
        <button
          aria-label="재고 1개 감소"
          className={styles.stockStepButton}
          disabled={locked || !valid || parsed <= 0}
          onClick={() => updateDraft(String(parsed - 1))}
          type="button"
        >
          −
        </button>
        <input
          id="inventory-next-stock"
          aria-describedby="inventory-input-hint inventory-draft-error"
          aria-invalid={!valid}
          className={styles.stockStepInput}
          disabled={locked}
          inputMode="numeric"
          onChange={(event) => updateDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.preventDefault();
          }}
          required
          value={draft}
        />
        <button
          aria-label="재고 1개 증가"
          className={styles.stockStepButton}
          disabled={locked || !valid || parsed >= 1_000_000}
          onClick={() => updateDraft(String(parsed + 1))}
          type="button"
        >
          ＋
        </button>
      </div>
      <p className={styles.inventoryInputHint} id="inventory-input-hint">
        0~1,000,000개 · 확인 전에는 수량이 변경되지 않습니다.
      </p>
      <p
        className={styles.inventoryDraftError}
        id="inventory-draft-error"
        role={!valid ? "alert" : undefined}
      >
        {!valid
          ? "0~1,000,000 사이의 정수를 입력해 주세요. 입력값은 자동으로 바꾸지 않습니다."
          : ""}
      </p>
      {stale || reviewRequired ? (
        <p className={styles.inventoryDraftError} role="alert">
          {stale
            ? `최신 재고는 ${product.stock}개입니다. 입력 내용은 보존했습니다.`
            : "변경 결과를 다시 확인해야 합니다."}{" "}
          최신 재고를 조회한 뒤 다시 시작해 주세요.
        </p>
      ) : null}
      <div
        className={styles.inventoryImpact}
        aria-label="재고 변경 미리보기"
        role="group"
      >
        <div>
          <span>현재</span>
          <strong>{snapshot.stock}개</strong>
        </div>
        <div>
          <span>변경 수량</span>
          <strong>{delta === null ? "—" : `${delta >= 0 ? "+" : ""}${delta}개`}</strong>
          <span aria-hidden="true">→</span>
        </div>
        <div>
          <span>변경 후</span>
          <strong>{valid ? `${parsed}개` : "—"}</strong>
        </div>
      </div>
      <button
        className={styles.primaryButton}
        disabled={locked || stale || reviewRequired || !changed}
        onClick={() => void commitDraft()}
        type="button"
      >
        {saving ? "저장 중…" : "재고 변경 내용 확인"}
      </button>
      <button
        className={styles.secondaryButton}
        disabled={locked}
        onClick={() => void handleUseLatest()}
        type="button"
      >
        {reloading ? "최신 재고 확인 중…" : "최신 재고로 다시 시작"}
      </button>
      {!changed && valid && !stale && !reviewRequired ? (
        <p className={styles.inventoryInputHint}>변경할 수량을 입력해 주세요.</p>
      ) : null}
    </aside>
  );
}

function BrandSection({
  brandMemo,
  brandName,
  brands,
  canSaveToServer,
  loadFailed,
  loading,
  notice,
  onMemoChange,
  onNameChange,
  onSubmit,
  products,
  saving,
}: Readonly<{
  brandMemo: string;
  brandName: string;
  brands: readonly string[];
  canSaveToServer: boolean;
  loadFailed: boolean;
  loading: boolean;
  notice: Notice;
  onMemoChange: (value: string) => void;
  onNameChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  products: readonly AdminCatalogListItem[];
  saving: boolean;
}>) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "linked" | "unlinked">("all");
  const brandMap = new Map<
    string,
    { name: string; productCount: number; addedHere: boolean }
  >();
  for (const product of products) {
    const name = product.brand.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    const entry = brandMap.get(key) ?? { name, productCount: 0, addedHere: false };
    entry.productCount += 1;
    brandMap.set(key, entry);
  }
  for (const brand of brands) {
    const name = brand.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    const entry = brandMap.get(key) ?? { name, productCount: 0, addedHere: false };
    entry.addedHere = true;
    brandMap.set(key, entry);
  }
  const entries = [...brandMap.values()].sort((a, b) =>
    a.name.localeCompare(b.name, "ko"),
  );
  const linkedCount = entries.filter((entry) => entry.productCount > 0).length;
  const matching = entries.filter(
    (entry) =>
      entry.name.toLowerCase().includes(search.trim().toLowerCase()) &&
      (filter === "all" ||
        (filter === "linked" ? entry.productCount > 0 : entry.productCount === 0)),
  );
  const counts = {
    all: entries.length,
    linked: linkedCount,
    unlinked: entries.length - linkedCount,
  };
  const previewName = brandName.trim() || "브랜드명";
  const emptyTitle = loading
    ? "상품의 브랜드를 불러오고 있습니다"
    : loadFailed && entries.length === 0
      ? "브랜드 목록을 확인하지 못했습니다"
      : entries.length
        ? "조건에 맞는 브랜드가 없습니다"
        : "현재 이 화면에 표시할 브랜드가 없습니다";
  const emptyDescription = loading
    ? "조회가 끝나면 이 화면의 상품 기준으로 표시합니다."
    : loadFailed && entries.length === 0
      ? "조회 실패는 브랜드가 없다는 뜻이 아닙니다. 연결과 상품 목록을 확인해 주세요."
      : entries.length
        ? "검색어나 상품 연결 필터를 바꿔 보세요."
        : "브랜드를 추가하면 이 화면의 상품 등록에서 선택할 수 있습니다.";

  const brandListReady = !loading && !loadFailed;
  const brandSaved = notice?.kind === "success" && !saving;
  const brandSteps: AdminStep[] = [
    { label: "브랜드 목록 확인", state: brandListReady ? "complete" : "current" },
    {
      label: "브랜드 입력",
      state: !brandListReady
        ? "upcoming"
        : brandSaved || saving || brandName.trim()
          ? "complete"
          : "current",
    },
    {
      label: "브랜드 저장",
      state: !canSaveToServer
        ? "unavailable"
        : brandSaved
          ? "complete"
          : saving || (brandListReady && brandName.trim())
            ? "current"
            : "upcoming",
    },
  ];
  return (
    <div className={`${styles.sectionStack} ${styles.brandScreen}`}>
      <AdminStepper
        className={styles.screenStepper}
        label="브랜드 작업 흐름"
        steps={brandSteps}
      />
      <header className={styles.brandHeader}>
        <div>
          <p>상품·재고 / 브랜드</p>
          <h2>브랜드 관리</h2>
        </div>
        <details className={styles.brandHelp}>
          <summary>도움말</summary>
          <p>
            현재 불러온 상품과 이 화면에서 추가한 브랜드만 표시합니다. 전체 브랜드
            목록이나 서버의 활성 상태를 조회하는 화면은 아닙니다.
          </p>
          <p>
            상품 연결 수는 이 화면의 상품 기준입니다. 연결이 없어도 비활성 브랜드를
            뜻하지 않습니다. 로고 업로드·브랜드 수정·삭제는 지원하지 않습니다.
          </p>
        </details>
      </header>
      <div className={styles.brandWorkspace}>
        <section className={styles.brandCatalog} aria-labelledby="brand-list-title">
          <div className={styles.brandCatalogHeading}>
            <h3 id="brand-list-title">이 화면에서 확인한 브랜드</h3>
            <p>조회 상품·이 화면 추가분 기준 · 전체 목록 아님</p>
          </div>
          <label className={styles.brandSearch}>
            <span>브랜드명 검색</span>
            <input
              onChange={(event) => setSearch(event.target.value)}
              placeholder="브랜드명으로 검색"
              type="search"
              value={search}
            />
          </label>
          <div className={styles.brandFilters} role="group" aria-label="상품 연결 필터">
            {(
              [
                ["all", "전체"],
                ["linked", "상품 연결"],
                ["unlinked", "연결 없음"],
              ] as const
            ).map(([value, label]) => (
              <button
                aria-pressed={filter === value}
                key={value}
                onClick={() => setFilter(value)}
                type="button"
              >
                {label}{" "}
                <span>
                  {(loading || loadFailed) && entries.length === 0
                    ? "—"
                    : counts[value]}
                </span>
              </button>
            ))}
          </div>
          {loading ? (
            <p className={styles.brandListNotice} role="status">
              상품의 브랜드를 불러오는 중…
            </p>
          ) : loadFailed ? (
            <p className={styles.brandListError} role="alert">
              상품 목록을 불러오지 못했습니다. 아래 연결 수는 현재 이 화면에 남은 상품만
              기준으로 하며 전체 수량이 아닙니다.
            </p>
          ) : null}
          {matching.length === 0 ? (
            <EmptyState title={emptyTitle} description={emptyDescription} />
          ) : (
            <div className={styles.brandTableWrap}>
              <table className={styles.brandTable}>
                <caption>브랜드별 이 화면 상품 연결</caption>
                <thead>
                  <tr>
                    <th scope="col">브랜드</th>
                    <th scope="col">연결 상품 수</th>
                    <th scope="col">확인 출처</th>
                  </tr>
                </thead>
                <tbody>
                  {matching.map((entry) => (
                    <tr key={entry.name.toLowerCase()}>
                      <th scope="row">
                        <span className={styles.brandRowIdentity}>
                          <span className={styles.brandTextMark} aria-hidden="true">
                            {entry.name.slice(0, 2).toUpperCase()}
                          </span>
                          <span>{entry.name}</span>
                        </span>
                      </th>
                      <td>
                        <strong>{entry.productCount}개</strong>
                        <span>
                          {entry.productCount > 0 ? "상품 연결" : "연결 없음"}
                        </span>
                      </td>
                      <td>{entry.addedHere ? "이 화면에서 추가" : "상품에서 확인"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <form
          aria-label="브랜드 추가"
          className={styles.brandForm}
          noValidate
          onSubmit={onSubmit}
        >
          <div className={styles.brandFormHeading}>
            <h3>브랜드 추가</h3>
            <span>
              {saving ? "등록 중…" : canSaveToServer ? "등록 전" : "서버 미연결"}
            </span>
          </div>
          <p className={styles.brandSaveHint}>
            {canSaveToServer
              ? "저장하면 서버에 브랜드가 등록됩니다."
              : "서버 연결이 없어 이 화면에만 임시 추가합니다."}
          </p>
          <fieldset disabled={saving} className={styles.brandFields}>
            <label>
              <span>
                브랜드명 <span className={styles.brandRequired}>(필수)</span>
                <span aria-hidden="true" className={requiredStyles.requiredMark}>
                  *
                </span>
              </span>
              <input
                maxLength={100}
                required
                onChange={(event) => onNameChange(event.target.value)}
                placeholder="예: April"
                value={brandName}
              />
            </label>
            <label>
              <span>운영 메모 (선택)</span>
              <textarea
                maxLength={1_000}
                onChange={(event) => onMemoChange(event.target.value)}
                placeholder="운영 시 참고할 내용 · 개인정보 제외"
                rows={4}
                value={brandMemo}
              />
            </label>
            <section className={styles.brandPreview} aria-label="브랜드명 표시 예시">
              <h4>브랜드명 표시 예시</h4>
              <div>
                <strong>{previewName}</strong>
                <span>상품의 브랜드명에 사용</span>
              </div>
              <p>텍스트 표시 예시이며 실제 로고나 공개 화면이 아닙니다.</p>
            </section>
            <div className={styles.brandFormActions}>
              <button className={styles.primaryButton} type="submit">
                {saving
                  ? "등록 중…"
                  : canSaveToServer
                    ? "브랜드 등록"
                    : "이 화면에 임시 추가"}
              </button>
              <button
                className={styles.secondaryButton}
                onClick={() => {
                  onNameChange("");
                  onMemoChange("");
                }}
                type="button"
              >
                입력 지우기
              </button>
            </div>
          </fieldset>
          {notice ? <NoticeMessage notice={notice} /> : null}
        </form>
      </div>
    </div>
  );
}

function MembersSection({
  canLoad,
  canUpdate,
  currentUserSub,
  loaded,
  loadFailed,
  loading,
  members,
  needsRefresh,
  notice,
  onLoad,
  onUpdateGroup,
  revision,
  saving,
}: Readonly<{
  canLoad: boolean;
  canUpdate: boolean;
  currentUserSub?: string;
  loaded: boolean;
  loadFailed: boolean;
  loading: boolean;
  members: readonly AdminMember[];
  needsRefresh: boolean;
  notice: Notice;
  onLoad: () => void;
  onUpdateGroup: (
    username: string,
    group: "admin" | "support",
    add: boolean,
    expectedGroups: readonly string[],
  ) => void;
  revision: number;
  saving: boolean;
}>) {
  const [search, setSearch] = useState("");
  const [selectedUsername, setSelectedUsername] = useState<string | null>(null);
  // 권한 변경 저장이 성공으로 끝난 경우만 마지막 단계를 완료로 봅니다(조회 성공 알림 제외).
  const [groupChanged, setGroupChanged] = useState(false);
  const [wasSaving, setWasSaving] = useState(saving);
  if (saving !== wasSaving) {
    setWasSaving(saving);
    if (!saving && notice?.kind === "success") setGroupChanged(true);
  }
  const focusFrameRef = useRef<number | null>(null);
  const locked = loading || saving;
  useEffect(
    () => () => {
      if (focusFrameRef.current !== null) cancelAnimationFrame(focusFrameRef.current);
    },
    [],
  );
  const matching = members.filter((member) =>
    [member.displayName, member.email, member.username].some((value) =>
      value?.toLowerCase().includes(search.trim().toLowerCase()),
    ),
  );
  const selected = members.find((member) => member.username === selectedUsername);
  function selectMember(username: string) {
    setSelectedUsername(username);
    setGroupChanged(false);
    if (focusFrameRef.current !== null) cancelAnimationFrame(focusFrameRef.current);
    if (window.matchMedia("(max-width: 1200px)").matches) {
      focusFrameRef.current = requestAnimationFrame(() => {
        focusFrameRef.current = null;
        const heading = document.getElementById("member-detail-title");
        if (heading?.dataset.memberUsername !== username) return;
        heading.focus({ preventScroll: true });
        heading.scrollIntoView({ behavior: "instant", block: "start" });
      });
    }
  }
  const emptyTitle = loading
    ? "회원 목록을 불러오고 있습니다"
    : loadFailed
      ? "최신 회원 목록을 확인하지 못했습니다"
      : !loaded
        ? "회원 목록을 아직 조회하지 않았습니다"
        : members.length === 0
          ? "이번 조회에서 회원이 반환되지 않았습니다"
          : "검색 조건에 맞는 회원이 없습니다";
  const memberSteps: AdminStep[] = [
    {
      label: "회원 조회",
      state: !canLoad ? "unavailable" : loaded && !loadFailed ? "complete" : "current",
    },
    {
      label: "회원 선택",
      state: !loaded || loadFailed ? "upcoming" : selected ? "complete" : "current",
    },
    {
      label: "권한 변경",
      state: !canUpdate
        ? "unavailable"
        : !selected
          ? "upcoming"
          : groupChanged && !saving
            ? "complete"
            : "current",
    },
  ];
  return (
    <div className={`${styles.sectionStack} ${styles.memberScreen}`}>
      <AdminStepper
        className={styles.screenStepper}
        label="회원 작업 흐름"
        steps={memberSteps}
      />
      <header className={styles.memberHeader}>
        <div>
          <p>고객 / 회원</p>
          <h2>회원 관리</h2>
        </div>
        <details className={styles.memberHelp}>
          <summary>도움말</summary>
          <p>
            조회 버튼을 눌러야 회원 정보를 불러옵니다. 검색은 이번 API 응답의 회원만
            필터링하며 전체 회원 검색이나 전체 회원 수 집계가 아닙니다.
          </p>
          <p>
            계정 활성 상태는 읽기 전용이며 수신 동의 정보는 제공되지 않습니다. 이
            화면에서 변경할 수 있는 항목은 admin·support 운영 권한뿐입니다.
          </p>
        </details>
      </header>
      <section className={styles.memberToolbar} aria-label="회원 조회">
        <label>
          <span>불러온 회원 검색</span>
          <input
            disabled={!loaded || locked}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="이름·이메일·계정 식별자"
            type="search"
            value={search}
          />
        </label>
        <button
          className={styles.primaryButton}
          disabled={locked || !canLoad}
          onClick={onLoad}
          type="button"
        >
          {loading ? "회원 목록 불러오는 중…" : "회원 목록 불러오기"}
        </button>
        <p>필요할 때만 조회 · 검색어와 선택 회원은 URL·저장소에 보관하지 않습니다.</p>
      </section>
      {!canLoad ? (
        <p className={styles.memberStateNote}>
          회원 목록 API가 연결되지 않았습니다. 서버 연결 후 조회할 수 있습니다.
        </p>
      ) : null}
      {notice ? <NoticeMessage notice={notice} /> : null}
      <div className={styles.memberWorkspace}>
        <section className={styles.memberDirectory} aria-labelledby="member-list-title">
          <div className={styles.memberDirectoryHeading}>
            <h3 id="member-list-title">
              {loaded ? `이번 조회 회원 ${members.length}명` : "이번 조회 회원 —"}
            </h3>
            <p>
              {loadFailed
                ? "최신 조회 실패 · 이전 결과일 수 있음"
                : "이번 API 응답 범위 · 전체 회원 목록 아님"}
            </p>
          </div>
          {matching.length ? (
            <ul className={styles.memberDirectoryList}>
              {matching.map((member) => {
                const label = member.displayName ?? member.email ?? member.username;
                return (
                  <li key={member.username}>
                    <button
                      aria-label={`${label} 회원 상세`}
                      aria-pressed={selectedUsername === member.username}
                      disabled={locked}
                      onClick={() => selectMember(member.username)}
                      type="button"
                    >
                      <span className={styles.memberIdentity}>
                        <strong>{label}</strong>
                        <span>{member.email ?? member.username}</span>
                      </span>
                      <span className={styles.memberGroupSummary}>
                        {member.groups.length
                          ? member.groups.join(" · ")
                          : "운영 그룹 없음"}
                      </span>
                      <span className={styles.memberEnabled}>
                        {member.enabled ? "활성" : "비활성"}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <EmptyState
              title={emptyTitle}
              description={
                loaded && members.length > 0
                  ? "이름·이메일·계정 식별자로 다시 검색해 보세요."
                  : "조회 버튼을 눌러 이번 응답 범위의 회원 정보를 확인하세요."
              }
            />
          )}
        </section>
        {selected ? (
          <MemberDetail
            key={`${selected.username}:${revision}`}
            canUpdate={canUpdate}
            currentUserSub={currentUserSub}
            locked={locked}
            member={selected}
            needsRefresh={needsRefresh || loadFailed}
            onUpdateGroup={onUpdateGroup}
            saving={saving}
          />
        ) : (
          <aside className={styles.memberDetailEmpty}>
            <span aria-hidden="true">◎</span>
            <h3>회원 상세</h3>
            <p>
              {loaded
                ? "목록에서 회원을 선택하면 계정 상태와 운영 권한을 확인할 수 있습니다."
                : "회원 목록을 먼저 불러와 주세요."}
            </p>
          </aside>
        )}
      </div>
    </div>
  );
}

function MemberDetail({
  canUpdate,
  currentUserSub,
  locked,
  member,
  needsRefresh,
  onUpdateGroup,
  saving,
}: Readonly<{
  canUpdate: boolean;
  currentUserSub?: string;
  locked: boolean;
  member: AdminMember;
  needsRefresh: boolean;
  onUpdateGroup: (
    username: string,
    group: "admin" | "support",
    add: boolean,
    expectedGroups: readonly string[],
  ) => void;
  saving: boolean;
}>) {
  const [group, setGroup] = useState<"admin" | "support" | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const label = member.displayName ?? member.email ?? member.username;
  const currentGroups = member.groups.length
    ? member.groups.join(" · ")
    : "운영 그룹 없음";
  const add = group ? !member.groups.includes(group) : false;
  const nextGroups = group
    ? add
      ? [...member.groups, group]
      : member.groups.filter((value) => value !== group)
    : member.groups;
  const selfAdminBlocked =
    group === "admin" &&
    !add &&
    Boolean(member.userSub && member.userSub === currentUserSub);
  const cannotChange = locked || needsRefresh || !canUpdate;
  return (
    <aside className={styles.memberDetail} aria-labelledby="member-detail-title">
      <div className={styles.memberDetailHeading}>
        <h3
          data-member-username={member.username}
          id="member-detail-title"
          tabIndex={-1}
        >
          {label}
        </h3>
        <span>
          {needsRefresh ? "최신 확인 필요" : group ? "변경 전 확인" : "읽기·권한 관리"}
        </span>
      </div>
      <dl className={styles.memberFacts}>
        <div>
          <dt>계정 식별자</dt>
          <dd>{member.username}</dd>
        </div>
        {member.email ? (
          <div>
            <dt>이메일</dt>
            <dd>{member.email}</dd>
          </div>
        ) : null}
        <div>
          <dt>
            계정 상태 <span>(읽기 전용)</span>
          </dt>
          <dd>{member.enabled ? "활성" : "비활성"}</dd>
        </div>
        <div>
          <dt>마케팅 수신 동의</dt>
          <dd>조회 데이터 없음</dd>
        </div>
        <div>
          <dt>현재 운영 권한</dt>
          <dd>{currentGroups}</dd>
        </div>
      </dl>
      <fieldset className={styles.memberPermissionFields} disabled={cannotChange}>
        <legend>운영 권한 변경</legend>
        <p>변경할 권한을 선택해 현재 상태와 적용할 내용을 비교하세요.</p>
        <div className={styles.memberPermissionChoices}>
          {(["support", "admin"] as const).map((value) => {
            const removing = member.groups.includes(value);
            const isSelfAdmin =
              value === "admin" &&
              removing &&
              Boolean(member.userSub && member.userSub === currentUserSub);
            return (
              <button
                aria-pressed={group === value}
                disabled={isSelfAdmin}
                key={value}
                onClick={() => {
                  setGroup(value);
                  setConfirmed(false);
                }}
                type="button"
              >
                {value} {removing ? "해제 준비" : "부여 준비"}
              </button>
            );
          })}
        </div>
        {member.groups.includes("admin") &&
        member.userSub &&
        member.userSub === currentUserSub ? (
          <p className={styles.memberStateNote}>
            본인 계정의 admin 권한은 해제할 수 없습니다.
          </p>
        ) : null}
        {group ? (
          <div className={styles.memberChangePreview} aria-label="권한 변경 미리보기">
            <strong>아직 미반영</strong>
            <dl>
              <div>
                <dt>현재</dt>
                <dd>{currentGroups}</dd>
              </div>
              <div>
                <dt>변경 후</dt>
                <dd>{nextGroups.length ? nextGroups.join(" · ") : "운영 그룹 없음"}</dd>
              </div>
            </dl>
            <p>
              {group} 그룹을 {add ? "부여" : "해제"}합니다. 대상: {member.username}
            </p>
            <label>
              <input
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
                type="checkbox"
              />
              선택한 회원과 권한 변경 내용을 확인했습니다
            </label>
          </div>
        ) : null}
        <div className={styles.memberPermissionActions}>
          <button
            className={styles.primaryButton}
            disabled={!group || !confirmed || selfAdminBlocked}
            onClick={() => {
              if (!group || !confirmed || cannotChange || selfAdminBlocked) return;
              if (
                !window.confirm(
                  `${label} (${member.username})\n현재: ${currentGroups}\n변경 후: ${nextGroups.length ? nextGroups.join(" · ") : "운영 그룹 없음"}\n${group} 그룹을 ${add ? "부여" : "해제"}할까요?`,
                )
              )
                return;
              onUpdateGroup(member.username, group, add, member.groups);
            }}
            type="button"
          >
            {saving ? "권한 변경 중…" : "권한 변경 내용 확인"}
          </button>
          <button
            className={styles.secondaryButton}
            disabled={!group}
            onClick={() => {
              setGroup(null);
              setConfirmed(false);
            }}
            type="button"
          >
            권한 선택 취소
          </button>
        </div>
      </fieldset>
      {needsRefresh ? (
        <p className={styles.memberStateWarning}>
          최신 권한을 확인해야 합니다. 회원 목록을 다시 불러온 뒤 변경 내용을 새로
          검토하세요.
        </p>
      ) : !canUpdate ? (
        <p className={styles.memberStateNote}>
          권한 변경 API가 연결되지 않아 읽기만 가능합니다.
        </p>
      ) : (
        <p className={styles.memberStateNote}>
          그룹 변경은 서버에서 다시 검증합니다. 새 권한은 다음 로그인부터 적용됩니다.
        </p>
      )}
    </aside>
  );
}

function CouponSection({
  canSaveToServer,
  couponCode,
  couponExpiresAt,
  couponName,
  couponType,
  couponValue,
  notice,
  onCodeChange,
  onExpiresAtChange,
  onNameChange,
  onSubmit,
  onTypeChange,
  onValueChange,
  saving,
}: Readonly<{
  canSaveToServer: boolean;
  couponCode: string;
  couponExpiresAt: string;
  couponName: string;
  couponType: "percent" | "amount";
  couponValue: string;
  notice: Notice;
  onCodeChange: (value: string) => void;
  onExpiresAtChange: (value: string) => void;
  onNameChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onTypeChange: (value: "percent" | "amount") => void;
  onValueChange: (value: string) => void;
  saving: boolean;
}>) {
  const validationMessage = couponDraftValidation(
    couponName,
    couponCode,
    couponType,
    couponValue,
    couponExpiresAt,
  );
  const hasInput = Boolean(couponName || couponCode || couponValue || couponExpiresAt);
  const benefitPreview = validationMessage
    ? "혜택 설정 필요"
    : couponType === "percent"
      ? `${Number(couponValue)}%`
      : moneyFormatter.format(Number(couponValue));
  const saved = notice?.kind === "success";

  return (
    <div className={`${styles.sectionStack} ${styles.couponScreen}`}>
      <header className={styles.couponHeader}>
        <div>
          <p>고객 / 쿠폰 / 새 초안</p>
          <div>
            <h2>쿠폰 만들기</h2>
            <span>
              {saved
                ? canSaveToServer
                  ? "초안 저장 · 미발급"
                  : "로컬 초안 · 미발급"
                : "초안 · 미발급"}
            </span>
          </div>
        </div>
        <details className={styles.couponHelp}>
          <summary>도움말</summary>
          <p>
            이 화면은 쿠폰 초안만 저장합니다. 고객에게 발급하거나 결제에 적용하지
            않습니다.
          </p>
          <p>
            대상 선택·최소 주문 금액·최대 할인·시작일 설정은 현재 지원하지 않습니다.
            만료 시각은 한국 시간으로 입력하며 해당 시각에 만료하는 초안입니다.
          </p>
        </details>
      </header>
      <AdminStepper
        label="쿠폰 작업 흐름"
        steps={[
          { label: "혜택 설정", state: validationMessage ? "current" : "complete" },
          {
            label: "미리보기 확인",
            state: validationMessage ? "upcoming" : "complete",
          },
          {
            label: "초안 저장",
            state: saved ? "complete" : validationMessage ? "upcoming" : "current",
          },
          // 고객 발급은 연결되지 않아 완료로 표시하지 않습니다.
          { label: "고객 발급", state: "unavailable" },
        ]}
      />
      <div className={styles.couponWorkspace}>
        <form
          aria-label="쿠폰 초안 설정"
          className={styles.couponForm}
          noValidate
          onSubmit={onSubmit}
        >
          <h3>혜택 설정</h3>
          <fieldset disabled={saving} className={styles.couponFields}>
            <label>
              <span>
                쿠폰명 (필수)
                <span aria-hidden="true" className={requiredStyles.requiredMark}>
                  *
                </span>
              </span>
              <input
                maxLength={120}
                required
                onChange={(event) => onNameChange(event.target.value)}
                placeholder="첫 구매 웰컴 쿠폰"
                value={couponName}
              />
            </label>
            <label>
              <span>
                쿠폰 코드 (필수)
                <span aria-hidden="true" className={requiredStyles.requiredMark}>
                  *
                </span>
              </span>
              <input
                aria-describedby="coupon-code-help"
                maxLength={32}
                required
                onChange={(event) => onCodeChange(event.target.value.toUpperCase())}
                placeholder="WELCOME10"
                value={couponCode}
              />
              <small id="coupon-code-help">
                영문·숫자로 시작하는 3–32자 · 영문 대문자·숫자·_·- 사용
              </small>
            </label>
            <div className={styles.couponInlineFields}>
              <label>
                <span>혜택 유형</span>
                <select
                  onChange={(event) =>
                    onTypeChange(event.target.value as "percent" | "amount")
                  }
                  value={couponType}
                >
                  <option value="percent">정률 할인 (%)</option>
                  <option value="amount">정액 할인 (원)</option>
                </select>
              </label>
              <label>
                <span>
                  {couponType === "percent" ? "할인율 (%)" : "할인 금액 (원)"} (필수)
                  <span aria-hidden="true" className={requiredStyles.requiredMark}>
                    *
                  </span>
                </span>
                <input
                  inputMode="numeric"
                  maxLength={12}
                  required
                  onChange={(event) => onValueChange(event.target.value)}
                  placeholder={couponType === "percent" ? "10" : "5000"}
                  type="text"
                  value={couponValue}
                />
                <small>
                  {couponType === "percent"
                    ? "1–100 사이 정수"
                    : "1–100,000,000원 사이 정수"}{" "}
                  · 쉼표·소수·지수 표기 제외
                </small>
              </label>
            </div>
            <label>
              <span>만료 시각 (한국 시간·선택)</span>
              <input
                onChange={(event) => onExpiresAtChange(event.target.value)}
                type="datetime-local"
                value={couponExpiresAt}
              />
              <small>
                입력한 한국 시간의 해당 시각에 만료합니다. 비우면 초안에 만료 시각을
                넣지 않습니다.
              </small>
            </label>
            {hasInput && validationMessage ? (
              <p className={styles.couponValidation}>{validationMessage}</p>
            ) : null}
            <p className={styles.couponSaveNote}>
              {canSaveToServer
                ? "서버에 초안만 저장합니다. 고객 발급·할인 적용은 하지 않습니다."
                : "서버 미연결 · 이 화면에만 준비하며 발급하지 않습니다."}
            </p>
            <button
              className={styles.primaryButton}
              disabled={Boolean(validationMessage)}
              type="submit"
            >
              {saving
                ? "저장 중…"
                : canSaveToServer
                  ? "쿠폰 초안 저장"
                  : "이 화면에 초안 준비"}
            </button>
          </fieldset>
          {notice ? <NoticeMessage notice={notice} /> : null}
        </form>
        <aside
          className={styles.couponDraftPreview}
          aria-label="쿠폰 고객 노출 미리보기"
        >
          <div className={styles.couponPreviewHeading}>
            <h3>쿠폰 미리보기</h3>
            <span>초안 예시 · 사용 불가</span>
          </div>
          <div className={styles.couponDraftTicket} data-valid={!validationMessage}>
            <span>PARADAYS</span>
            <strong>{benefitPreview}</strong>
            <p>{couponName.trim() || "쿠폰명을 입력하세요"}</p>
            <code>
              {/^[A-Z0-9][A-Z0-9_-]{2,31}$/.test(couponCode.trim().toUpperCase())
                ? couponCode.trim().toUpperCase()
                : "쿠폰 코드 확인 필요"}
            </code>
            <small>
              {couponExpiresAt
                ? couponExpiryIso(couponExpiresAt)
                  ? `만료 기준 ${couponExpiresAt.replace("T", " ")} (한국 시간)`
                  : "만료 시각 확인 필요"
                : "만료 시각 미설정"}
            </small>
          </div>
          <div className={styles.couponUnissued}>
            <strong>아직 발급되지 않았습니다</strong>
            <p>
              입력한 혜택을 확인하는 예시입니다. 초안을 저장해도 고객이 사용할 수 있는
              쿠폰이 되지 않습니다.
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}

function MarketingSection({
  body,
  canSaveToServer,
  channels,
  notice,
  onBodyChange,
  onChannelChange,
  onSubmit,
  onTitleChange,
  title,
  saving,
}: Readonly<{
  body: string;
  canSaveToServer: boolean;
  channels: Record<MarketingChannel, boolean>;
  notice: Notice;
  onBodyChange: (value: string) => void;
  onChannelChange: (channel: MarketingChannel, selected: boolean) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onTitleChange: (value: string) => void;
  title: string;
  saving: boolean;
}>) {
  const [previewChannel, setPreviewChannel] = useState<MarketingChannel>("email");
  const selected = (["email", "sms", "push"] as const).filter(
    (channel) => channels[channel],
  );
  const activePreview = channels[previewChannel] ? previewChannel : selected[0];
  const validationMessage = campaignDraftValidation(title, body, selected.length);
  const hasInput = Boolean(title || body);
  const saved = notice?.kind === "success";
  return (
    <div className={`${styles.sectionStack} ${styles.campaignScreen}`}>
      <header className={styles.campaignHeader}>
        <div>
          <p>고객 / 마케팅 / 새 캠페인</p>
          <div>
            <h2>캠페인 만들기</h2>
            <span>
              {saved
                ? canSaveToServer
                  ? "초안 저장 · 발송 없음"
                  : "로컬 초안 · 발송 없음"
                : "미리보기 · 발송 없음"}
            </span>
          </div>
        </div>
        <details className={styles.campaignHelp}>
          <summary>도움말</summary>
          <p>
            이 화면은 제목·메시지·채널을 초안으로만 저장합니다. 수신자
            조회·예약·발송·이미지 첨부는 지원하지 않습니다.
          </p>
          <p>
            채널 선택은 초안에 담을 문구의 종류입니다. 실제 채널 연결 상태나 발송 가능
            여부를 확인하는 표시가 아닙니다. 수신 동의와 발송 정책은 별도 서버 검증이
            필요합니다.
          </p>
        </details>
      </header>
      <AdminStepper
        label="캠페인 작업 흐름"
        steps={[
          { label: "채널 선택", state: selected.length ? "complete" : "current" },
          {
            label: "문구 작성",
            state: !selected.length
              ? "upcoming"
              : validationMessage
                ? "current"
                : "complete",
          },
          {
            label: "초안 저장",
            state: saved ? "complete" : validationMessage ? "upcoming" : "current",
          },
          { label: "고객 발송", state: "unavailable" },
        ]}
      />
      <div className={styles.campaignWorkspace}>
        <form
          aria-label="캠페인 초안 작성"
          className={styles.campaignForm}
          noValidate
          onSubmit={onSubmit}
        >
          <fieldset className={styles.campaignFields} disabled={saving}>
            <fieldset className={styles.campaignChannels}>
              <legend>초안 채널 선택 (복수 선택)</legend>
              <div className={styles.campaignChannelCards}>
                {(["email", "sms", "push"] as const).map((channel) => (
                  <label data-selected={channels[channel]} key={channel}>
                    <span className={styles.campaignChannelIcon} aria-hidden="true">
                      <CampaignChannelIcon channel={channel} />
                    </span>
                    <input
                      aria-label={`${channelLabel(channel)} 초안 선택`}
                      checked={channels[channel]}
                      onChange={(event) =>
                        onChannelChange(channel, event.target.checked)
                      }
                      type="checkbox"
                    />
                    <strong>{channelLabel(channel)}</strong>
                    <span className={styles.campaignChannelState}>
                      {channels[channel] ? "초안 포함" : "초안 제외"}
                    </span>
                    <small
                      className={styles.campaignChannelSupport}
                      data-inline-logo={campaignChannelSupport(channel).inlineLogo}
                    >
                      {campaignChannelSupport(channel).label}
                    </small>
                  </label>
                ))}
              </div>
            </fieldset>
            <p className={styles.campaignScopeNote}>
              초안 작성용 선택 · 채널 연결·수신자 수·발송 가능 여부는 미조회입니다.
            </p>
            <label>
              <span>
                캠페인 제목 (필수)
                <span aria-hidden="true" className={requiredStyles.requiredMark}>
                  *
                </span>
              </span>
              <input
                maxLength={160}
                required
                onChange={(event) => onTitleChange(event.target.value)}
                placeholder="이번 주 신상품을 확인하세요"
                value={title}
              />
              <small>{title.length}/160자</small>
            </label>
            <label>
              <span>
                메시지 (필수)
                <span aria-hidden="true" className={requiredStyles.requiredMark}>
                  *
                </span>
              </span>
              <textarea
                maxLength={8_000}
                onChange={(event) => onBodyChange(event.target.value)}
                placeholder="고객에게 전달할 혜택과 링크 안내를 작성하세요."
                rows={8}
                required
                value={body}
              />
              <small>
                {body.length.toLocaleString("ko-KR")}/8,000자 · 초안 API 저장 한도이며
                SMS 전송 길이·분할 기준이 아닙니다.
              </small>
            </label>
            <div className={styles.campaignConsentNote}>
              <strong>수신 대상 미조회 · 발송 없음</strong>
              <p>
                수신 동의가 검증된 대상자 수나 실제 발송 목록은 이 화면에서 확인하지
                않습니다.
              </p>
            </div>
            {hasInput && validationMessage ? (
              <p className={styles.campaignValidation}>{validationMessage}</p>
            ) : null}
            <p className={styles.campaignSaveNote}>
              {canSaveToServer
                ? "서버에 초안만 저장하며 고객에게 메시지를 보내지 않습니다."
                : "서버 미연결 · 초안을 이 화면에만 준비하고 발송하지 않습니다."}
            </p>
            <button
              className={styles.primaryButton}
              disabled={Boolean(validationMessage)}
              type="submit"
            >
              {saving
                ? "저장 중…"
                : canSaveToServer
                  ? "캠페인 초안 저장"
                  : "이 화면에 초안 준비"}
            </button>
          </fieldset>
          {notice ? <NoticeMessage notice={notice} /> : null}
        </form>
        <aside className={styles.campaignPreview} aria-label="선택 채널 문구 미리보기">
          <h3>
            {activePreview
              ? `${channelLabel(activePreview)} 미리보기`
              : "채널 문구 미리보기"}
          </h3>
          <div
            className={styles.campaignPreviewChoices}
            role="group"
            aria-label="미리보기 채널"
          >
            {selected.map((channel) => (
              <button
                aria-pressed={activePreview === channel}
                key={channel}
                onClick={() => setPreviewChannel(channel)}
                type="button"
              >
                {channelLabel(channel)} 미리보기
              </button>
            ))}
          </div>
          {activePreview ? (
            <div className={styles.campaignMessage} data-channel={activePreview}>
              {campaignChannelSupport(activePreview).inlineLogo ? (
                <div className={styles.campaignMessageBrand} data-inline-logo="true">
                  <Image
                    alt={CAMPAIGN_LOGO.alt}
                    className={styles.campaignLogo}
                    height={CAMPAIGN_LOGO.height}
                    src={CAMPAIGN_LOGO.path}
                    width={CAMPAIGN_LOGO.width}
                  />
                  <span>본문 삽입(인라인 이미지) · 항상 맨 위 · 초안 문구 예시</span>
                </div>
              ) : (
                <div className={styles.campaignMessageBrand} data-inline-logo="false">
                  PARADAYS <span>초안 문구 예시 · 로고 이미지 미포함</span>
                </div>
              )}
              <div className={styles.campaignMessageBody}>
                <strong>{title.trim() || "캠페인 제목"}</strong>
                <p>
                  {body.trim() ||
                    "메시지를 입력하면 선택 채널의 초안 문구가 표시됩니다."}
                </p>
              </div>
              <small>
                {campaignChannelSupport(activePreview).detail}{" "}
                {activePreview === "sms"
                  ? "문자 분할·발송 비용·인코딩은 계산하지 않습니다."
                  : activePreview === "push"
                    ? "실제 기기 알림의 길이·모양과 다를 수 있습니다."
                    : "실제 이메일 HTML·수신거부 기능이 포함된 발송물이 아닙니다."}
              </small>
            </div>
          ) : (
            <p className={styles.campaignEmptyPreview}>
              초안에 포함할 채널을 하나 이상 선택해 주세요.
            </p>
          )}
          <p className={styles.campaignPreviewNote}>
            이 미리보기는 실제 전송물이 아닙니다. 초안을 저장해도 고객에게 메시지가
            발송되지 않습니다.
          </p>
        </aside>
      </div>
    </div>
  );
}

function CampaignChannelIcon({ channel }: Readonly<{ channel: MarketingChannel }>) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height="28"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.6"
      viewBox="0 0 24 24"
      width="28"
    >
      {channel === "email" ? (
        <>
          <rect height="14" rx="2" width="20" x="2" y="5" />
          <path d="m3 6 9 7 9-7" />
        </>
      ) : channel === "sms" ? (
        <path d="M21 11a9 8 0 0 1-9 8H5l-3 3V11a9 8 0 0 1 18 0Z" />
      ) : (
        <>
          <path d="M5 17h14l-2-3V9a5 5 0 0 0-10 0v5l-2 3ZM10 21h4M12 2v2" />
        </>
      )}
    </svg>
  );
}

function OcrSection({
  canAddRow,
  canSave,
  file,
  isSaving,
  jobVersion,
  reviewSaved,
  notice,
  onAddRow,
  onFileChange,
  onRecognize,
  onRemoveRow,
  onRowChange,
  onSave,
  rows,
  rawText,
  mappingPanel,
  inventoryPanel,
  state,
}: Readonly<{
  canAddRow: boolean;
  canSave: boolean;
  file: File | null;
  isSaving: boolean;
  jobVersion: number | null;
  reviewSaved: boolean;
  notice: Notice;
  onAddRow: () => void;
  onFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onRecognize: () => void;
  onRemoveRow: (id: string) => void;
  onRowChange: (
    id: string,
    field: Exclude<keyof AdminOcrReviewRow, "id">,
    value: string,
  ) => void;
  onSave: () => void;
  rows: readonly AdminOcrReviewRow[];
  rawText: string;
  mappingPanel?: ReactNode;
  inventoryPanel?: ReactNode;
  state: OcrState;
}>) {
  const { locale } = useLocale();
  const localOcr = useSyncExternalStore(
    subscribeToLocalOcrMode,
    isLocalOcrDevelopmentMode,
    serverLocalOcrMode,
  );
  const remoteOcrDemo = useSyncExternalStore(
    subscribeToLocalOcrMode,
    isRemoteOcrDemoMode,
    serverLocalOcrMode,
  );
  const recognizing = state === "recognizing";
  const statusLabel = recognizing
    ? "인식 중"
    : reviewSaved
      ? "검토본 저장됨"
      : state === "review"
        ? "검토 중 · 저장 필요"
        : state === "connection-needed"
          ? "API 연결 필요"
          : "이미지 선택";
  const quantityValid = (value: string) => /^[0-9]{1,9}$/.test(value);
  const invalidQuantities = rows.filter(
    (row) => row.quantity !== "" && !quantityValid(row.quantity),
  ).length;
  const totalQuantity = rows.reduce(
    (total, row) => total + (quantityValid(row.quantity) ? Number(row.quantity) : 0),
    0,
  );
  const incompleteRows = rows.filter(
    (row) =>
      !row.productName.trim() ||
      !row.brand.trim() ||
      !row.option.trim() ||
      !row.quantity.trim(),
  ).length;
  const reviewing = state === "review";
  // 입고 반영 결과는 아래 반영 패널이 직접 표시하므로 이 흐름에서 완료로 표시하지 않습니다.
  const ocrSteps: AdminStep[] = [
    { label: "이미지 선택", state: recognizing || reviewing ? "complete" : "current" },
    {
      label: "OCR 인식",
      state:
        state === "connection-needed"
          ? "unavailable"
          : recognizing
            ? "current"
            : reviewing
              ? "complete"
              : "upcoming",
    },
    {
      label: "내용 검토",
      state: !reviewing ? "upcoming" : reviewSaved ? "complete" : "current",
    },
    { label: "검토본 저장", state: reviewing && reviewSaved ? "complete" : "upcoming" },
    {
      label: "입고 반영",
      state: reviewing && reviewSaved && inventoryPanel ? "current" : "upcoming",
    },
  ];
  return (
    <div
      className={`${styles.sectionStack} ${styles.ocrSectionStack} ${styles.ocrScreen}`}
    >
      <header className={styles.ocrHeader}>
        <div>
          <p>재고 / 입고 OCR</p>
          <h2>입고 검토</h2>
          <p>
            {locale === "ko"
              ? "이미지와 인식 결과를 비교하고 상품 정보를 확인하세요."
              : "Compare the image with recognition results and review the product information."}
          </p>
        </div>
        <span className={styles.ocrReviewBadge} role="status">
          {statusLabel}
        </span>
      </header>
      <AdminStepper label="OCR 등록 흐름" steps={ocrSteps} />
      <div className={styles.ocrSummary} aria-label="현재 검토 행 요약">
        <article>
          <span>검토 행</span>
          <strong>{rows.length.toLocaleString("ko-KR")}행</strong>
        </article>
        <article>
          <span>입력 수량 합계</span>
          <strong>
            {invalidQuantities
              ? "수량 확인 필요"
              : `${totalQuantity.toLocaleString("ko-KR")}개`}
          </strong>
          <small>빈 수량 제외 · 실제 재고와 무관</small>
        </article>
        <article>
          <span>빈 항목 포함 행</span>
          <strong>{incompleteRows.toLocaleString("ko-KR")}행</strong>
          <small>상품명·브랜드·옵션·수량 기준</small>
        </article>
      </div>
      {notice ? <NoticeMessage notice={notice} /> : null}
      <div className={styles.ocrWorkspace}>
        <section className={styles.ocrSourcePanel} aria-labelledby="ocr-source-title">
          <h3 id="ocr-source-title">원본 이미지</h3>
          <p className={styles.ocrSourceHint}>
            {locale === "ko"
              ? "PNG·JPG·WEBP · 4MiB 이하 · 표 전체가 보이는 이미지"
              : "PNG, JPG or WEBP · Up to 4 MiB · Include the complete table"}
          </p>
          {remoteOcrDemo ? (
            <div
              className={styles.ocrTransferNote}
              role="note"
              aria-label={
                locale === "ko" ? "PC OCR 임시 테스트" : "Temporary PC OCR test"
              }
            >
              <strong>
                {locale === "ko" ? "PC OCR 임시 테스트" : "Temporary PC OCR test"}
              </strong>
              <p>
                {locale === "ko"
                  ? "이미지는 제3자 HTTPS 중계망을 거쳐 운영자 PC로 전송됩니다. 개인정보 포함 여부를 전송 전에 확인하세요."
                  : "Images travel through a temporary third-party HTTPS relay to the operator’s PC. Check images for personal information before sending them."}
              </p>
              <p>
                {locale === "ko"
                  ? "검토본은 PC 메모리에 임시 보관되며 서버 재시작 시 삭제됩니다. 검토본 저장만으로 상품·재고·AWS에는 저장하지 않습니다. 별도로 확인한 입고 반영은 실제 재고를 변경합니다."
                  : "Text reviews are kept only in the operator’s PC memory and are deleted when the server restarts. Review saving does not save products, inventory or AWS data, or publish products. Separately confirming inventory application changes real product inventory."}
              </p>
            </div>
          ) : localOcr ? (
            <div
              className={styles.ocrTransferNote}
              role="note"
              aria-label={locale === "ko" ? "로컬 OCR 테스트" : "Local OCR test"}
            >
              <strong>{locale === "ko" ? "로컬 OCR 테스트" : "Local OCR test"}</strong>
              <p>
                {locale === "ko"
                  ? "이미지는 현재 컴퓨터의 로컬 중계 서버로 전송합니다. 검토본은 PC 메모리에만 보관되며 재시작 시 삭제됩니다. 검토본 저장만으로 상품·재고·AWS에는 저장하지 않습니다. 별도로 확인한 입고 반영은 실제 재고를 변경합니다."
                  : "Images are sent to this computer’s local relay. Only text reviews are stored in this computer’s memory and are deleted when the server restarts. Review saving does not save products, inventory or AWS data, or publish products. Separately confirming inventory application changes real product inventory."}
              </p>
            </div>
          ) : (
            <p className={styles.ocrTransferNote}>
              {locale === "ko"
                ? "이미지는 관리자 API로 전송합니다. 개인정보 포함 여부를 확인하세요. 검토본 저장만으로 재고나 상품 공개 상태는 바뀌지 않습니다."
                : "Images are sent to the administrator API. Check for personal information before sending. Saving a review does not change inventory or publish products."}
            </p>
          )}
          <label className={styles.ocrFileControl}>
            <span>이미지 파일 선택</span>
            <input
              accept="image/png,image/jpeg,image/webp"
              onChange={onFileChange}
              type="file"
            />
          </label>
          <button
            className={styles.primaryButton}
            disabled={!file || recognizing}
            onClick={onRecognize}
            type="button"
          >
            {recognizing ? "OCR 인식 중…" : "OCR로 텍스트 추출"}
          </button>
          {file ? (
            <OcrSourcePreview file={file} />
          ) : (
            <div className={styles.ocrSourceEmpty}>
              <span aria-hidden="true">▧</span>
              <p>이미지를 선택하면 여기에 표시됩니다.</p>
            </div>
          )}
          <details className={styles.ocrProcessingHelp}>
            <summary>
              {locale === "ko"
                ? "처리 경로·용량·연결 안내"
                : "Processing route, limits and connection help"}
            </summary>
            <p>
              {locale !== "ko"
                ? remoteOcrDemo
                  ? "The operator’s PC OCR server does not store image files. The PaddleOCR shared secret stays only on the operator’s PC. Administrator sign-in is required. Requests are rejected (403) if the signed authentication token lacks the admin group, even when signed in."
                  : localOcr
                    ? "Images are sent only to this computer’s local relay and are not stored. The PaddleOCR shared secret stays on the local server."
                    : "The browser sends images only to the administrator API. Keep the PaddleOCR address and shared secret in AWS Secrets Manager, not in public browser environment variables."
                : remoteOcrDemo
                  ? "운영자 PC의 OCR 서버는 이미지 파일을 저장하지 않습니다. PaddleOCR 공유 비밀값은 운영자 PC에만 보관합니다. 관리자 토큰에 admin 권한이 없으면 요청이 거부됩니다(403)."
                  : localOcr
                    ? "이미지 파일은 로컬 중계 서버에서 보관하지 않으며 PaddleOCR 공유 비밀값은 로컬 서버에만 둡니다."
                    : "브라우저는 관리자 API에만 이미지를 전달합니다. PaddleOCR 주소·공유 비밀값은 AWS Secrets Manager에만 두고 브라우저 공개 환경변수에 넣지 않습니다."}
            </p>
            <p>
              {locale === "ko"
                ? "인식에 최대 2분 정도 걸릴 수 있습니다. 시간 초과·연결 오류가 나면 관리자 권한과 OCR 서버·중계 연결을 확인한 뒤 다시 시도하세요."
                : "Recognition may take up to about 2 minutes. If it times out or the connection fails, check administrator permissions and that the OCR server and HTTPS relay are running before retrying."}
            </p>
            <p>
              {locale === "ko"
                ? "현재 직접 전송 한도는 4MiB입니다. 4~6MiB private S3 경로는 배포 전이므로 더 작은 파일을 선택하세요."
                : "Direct transmission is limited to 4 MiB. The private S3 route for 4–6 MiB files is not deployed; choose a smaller image."}
            </p>
          </details>
        </section>
        <section className={styles.ocrReviewPanel} aria-labelledby="ocr-review-title">
          <div className={styles.ocrReviewHeading}>
            <div>
              <h3 id="ocr-review-title">인식 결과</h3>
              <p>상품명·브랜드·옵션·수량을 직접 확인하고 수정하세요.</p>
            </div>
            <button
              className={styles.secondaryButton}
              disabled={!canAddRow}
              onClick={onAddRow}
              type="button"
            >
              행 추가
            </button>
          </div>
          {rows.length === 0 ? (
            <EmptyState
              title="검토할 입고 행이 없습니다"
              description="이미지를 선택해 OCR 인식을 실행하면 수정 가능한 행이 표시됩니다. 누락된 항목은 행 추가로 입력하세요."
            />
          ) : (
            <ol className={styles.ocrReviewRows}>
              {rows.map((row, index) => (
                <li key={row.id}>
                  <article
                    aria-label={`${index + 1}번째 입고 행`}
                    className={styles.ocrReviewRow}
                  >
                    <div className={styles.ocrRowHeading}>
                      <strong>{index + 1}번 행</strong>
                      <button
                        aria-label={`${index + 1}번 입고 행 삭제`}
                        className={styles.secondaryButton}
                        onClick={() => onRemoveRow(row.id)}
                        type="button"
                      >
                        행 삭제
                      </button>
                    </div>
                    <div className={styles.ocrMainFields}>
                      <label>
                        <span>상품명</span>
                        <input
                          aria-label="상품명"
                          aria-describedby="ocr-row-edit-limits"
                          maxLength={OCR_INPUT_LIMITS.maxProductNameLength}
                          onChange={(event) =>
                            onRowChange(row.id, "productName", event.target.value)
                          }
                          value={row.productName}
                        />
                      </label>
                      <label>
                        <span>브랜드</span>
                        <input
                          aria-label="브랜드"
                          aria-describedby="ocr-row-edit-limits"
                          maxLength={OCR_INPUT_LIMITS.maxBrandLength}
                          onChange={(event) =>
                            onRowChange(row.id, "brand", event.target.value)
                          }
                          value={row.brand}
                        />
                      </label>
                      <label>
                        <span>옵션</span>
                        <input
                          aria-label="옵션"
                          aria-describedby="ocr-row-edit-limits"
                          maxLength={OCR_INPUT_LIMITS.maxOptionLength}
                          onChange={(event) =>
                            onRowChange(row.id, "option", event.target.value)
                          }
                          value={row.option}
                        />
                      </label>
                      <label>
                        <span>수량</span>
                        <input
                          aria-label="수량"
                          aria-describedby="ocr-row-edit-limits"
                          inputMode="numeric"
                          maxLength={OCR_INPUT_LIMITS.maxQuantityDigits}
                          onChange={(event) =>
                            onRowChange(row.id, "quantity", event.target.value)
                          }
                          pattern="[0-9]*"
                          value={row.quantity}
                        />
                      </label>
                    </div>
                    <details className={styles.ocrRowDetails}>
                      <summary>인식 원문·상세 보기</summary>
                      <label>
                        <span>OCR 원문 (수정 가능)</span>
                        <input
                          aria-label="OCR 원문 (수정 가능)"
                          aria-describedby="ocr-row-edit-limits"
                          maxLength={OCR_INPUT_LIMITS.maxSourceTextLength}
                          onChange={(event) =>
                            onRowChange(row.id, "sourceText", event.target.value)
                          }
                          value={row.sourceText}
                        />
                      </label>
                      <dl>
                        <div>
                          <dt>신뢰도 (읽기 전용)</dt>
                          <dd>{formatOcrConfidence(row.confidence)}</dd>
                        </div>
                        <div>
                          <dt>좌표 (읽기 전용)</dt>
                          <dd>{formatOcrBoundingBox(row.box)}</dd>
                        </div>
                      </dl>
                    </details>
                  </article>
                </li>
              ))}
            </ol>
          )}
          <details className={styles.ocrEditHelp}>
            <summary>입력 제한·빈 항목 안내</summary>
            <p id="ocr-row-edit-limits">
              원문 {OCR_INPUT_LIMITS.maxSourceTextLength.toLocaleString("ko-KR")}자,
              상품명 {OCR_INPUT_LIMITS.maxProductNameLength}자, 브랜드{" "}
              {OCR_INPUT_LIMITS.maxBrandLength}자, 옵션{" "}
              {OCR_INPUT_LIMITS.maxOptionLength}자까지 입력할 수 있습니다. 검토 행은
              최대 {OCR_INPUT_LIMITS.maxReviewRows}개이며 수량은 비우거나 0~999,999,999
              정수만 허용됩니다. 빈 항목은 검토본에 보관할 수 있으나 실제 입고 전에
              상품과 수량을 별도로 확인해야 합니다.
            </p>
          </details>
          <div className={styles.ocrReviewSave}>
            <p className={styles.ocrSaveBoundary}>
              {locale === "ko"
                ? "검토본을 저장해도 재고는 변경되지 않습니다. 입고 반영은 저장 후 별도로 확인하며 신규 상품은 비공개 초안으로 생성됩니다."
                : "Saving a review does not change inventory. Inventory application requires separate confirmation after saving; new products are created as private drafts."}
            </p>
            <div>
              <span>
                {reviewSaved
                  ? `검토본 저장됨 · 서버 버전 ${jobVersion}`
                  : rows.length
                    ? "검토본 저장 필요"
                    : "인식 결과 대기"}
              </span>
              <button
                className={styles.primaryButton}
                disabled={!canSave || isSaving || recognizing || rows.length === 0}
                onClick={onSave}
                type="button"
              >
                {isSaving ? "처리 중…" : "검토본 저장"}
              </button>
            </div>
          </div>
        </section>
      </div>
      {mappingPanel ? (
        <details className={styles.ocrAdvanced}>
          <summary>표 인식이 다르면 · 열·이미지 영역 직접 지정</summary>
          <p>
            상품명·브랜드·옵션·수량의 위치를 지정하고 미리보기로 확인한 뒤 적용하세요.
            적용하면 검토 내용을 다시 확인하고 저장해야 합니다.
          </p>
          {mappingPanel}
        </details>
      ) : null}
      {rawText ? (
        <details className={styles.ocrRawReadOnly}>
          <summary>인식 원문 보기 · 읽기 전용</summary>
          <pre>{rawText}</pre>
        </details>
      ) : null}
      {inventoryPanel ? (
        <section className={styles.ocrInventoryStage} aria-label="검토본 입고 반영">
          <h3>5. 입고 반영</h3>
          <p>
            아래에서 상품과 수량을 별도로 확인합니다. 이 화면의 검토본 저장 상태는 입고
            완료를 뜻하지 않습니다.
          </p>
          {inventoryPanel}
        </section>
      ) : null}
    </div>
  );
}

function OcrSourcePreview({ file }: Readonly<{ file: File }>) {
  const imageRef = useRef<HTMLImageElement>(null);
  const expandedImageRef = useRef<HTMLImageElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const url = URL.createObjectURL(file);
    const image = imageRef.current;
    const expandedImage = expandedImageRef.current;
    const dialog = dialogRef.current;
    if (image) image.src = url;
    if (expandedImage) expandedImage.src = url;
    return () => {
      dialog?.close();
      image?.removeAttribute("src");
      expandedImage?.removeAttribute("src");
      URL.revokeObjectURL(url);
    };
  }, [file]);
  return (
    <figure className={styles.ocrSourceFigure}>
      {/* 로컬 blob을 DOM ref로 교체·폐기하는 미리보기이며 최적화 서버로 전송하지 않습니다. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img alt="선택한 입고 원본 이미지" ref={imageRef} />
      <figcaption>
        {file.name} ·{" "}
        {(file.size / 1024).toLocaleString("ko-KR", { maximumFractionDigits: 1 })}KiB
      </figcaption>
      <button
        className={styles.secondaryButton}
        onClick={() => dialogRef.current?.showModal()}
        type="button"
      >
        원본 이미지 확대 보기
      </button>
      <dialog
        aria-labelledby="ocr-image-dialog-title"
        className={styles.ocrImageDialog}
        ref={dialogRef}
      >
        <div>
          <h3 id="ocr-image-dialog-title">원본 이미지 확대</h3>
          <button
            autoFocus
            className={styles.secondaryButton}
            onClick={() => dialogRef.current?.close()}
            type="button"
          >
            확대 보기 닫기
          </button>
        </div>
        <p>{file.name}</p>
        {/* 동일한 로컬 blob URL을 사용하며 파일 교체·언마운트 시 폐기합니다. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img alt="입고 원본 이미지 확대" ref={expandedImageRef} />
      </dialog>
    </figure>
  );
}

function formatOcrConfidence(confidence: number | undefined) {
  if (confidence === undefined) {
    return "—";
  }

  return `${(confidence * 100).toLocaleString("ko-KR", { maximumFractionDigits: 1 })}%`;
}

function formatOcrBoundingBox(box: AdminOcrReviewRow["box"]) {
  if (!box || box.length === 0) {
    return "—";
  }

  return box
    .map(([x, y]) => `${formatOcrCoordinate(x)}, ${formatOcrCoordinate(y)}`)
    .join(" → ");
}

function formatOcrCoordinate(value: number) {
  return value.toLocaleString("ko-KR", { maximumFractionDigits: 2 });
}

function MetricCard({
  icon,
  label,
  note,
  value,
}: Readonly<{ icon?: AdminSection; label: string; note: string; value: string }>) {
  return (
    <article className={styles.metricCard}>
      {icon ? (
        <div
          className={styles.metricIcon}
          data-tone={icon === "inventory" ? "purple" : operationIconTone[icon]}
        >
          <AdminMenuIcon section={icon} cart={icon === "overview"} />
        </div>
      ) : null}
      <p>{label}</p>
      <strong>{value}</strong>
      <span>{note}</span>
    </article>
  );
}

function QuickAction({
  actionLabel,
  icon,
  label,
  note,
  needsAttention = false,
  onClick,
  primary = false,
  value,
}: Readonly<{
  actionLabel: string;
  icon: AdminSection;
  label: string;
  note: string;
  needsAttention?: boolean;
  onClick: () => void;
  primary?: boolean;
  value?: string;
}>) {
  const { locale } = useLocale();
  return (
    <article className={styles.overviewTask}>
      <div className={styles.taskIcon} data-tone={operationIconTone[icon]}>
        <AdminMenuIcon section={icon} />
      </div>
      <div className={styles.taskDescription}>
        <h3>
          {label}
          {value !== undefined ? (
            <span className={styles.taskCount}>{value}</span>
          ) : null}
          {needsAttention ? (
            <AdminStatusBadge locale={locale} status="attention" />
          ) : null}
        </h3>
        <p>{note}</p>
      </div>
      <button
        className={primary ? styles.primaryButton : styles.secondaryButton}
        onClick={onClick}
        type="button"
      >
        {actionLabel}
        <span aria-hidden="true">→</span>
      </button>
    </article>
  );
}

function EmptyState({
  description,
  title,
}: Readonly<{ description: string; title: string }>) {
  return (
    <div className={styles.emptyState}>
      <strong>{title}</strong>
      <p>{description}</p>
    </div>
  );
}

function NoticeMessage({ notice }: Readonly<{ notice: Exclude<Notice, null> }>) {
  const { locale } = useLocale();
  return (
    <div role={notice.kind === "error" ? "alert" : "status"}>
      <AdminNotice
        locale={locale}
        status={notice.kind === "error" ? "warning" : "neutral"}
      >
        {localizedText(notice.message, locale)}
      </AdminNotice>
    </div>
  );
}

function channelLabel(channel: MarketingChannel) {
  if (channel === "email") {
    return "이메일";
  }

  return channel === "sms" ? "SMS" : "푸시";
}

function parsePositiveNumber(value: string) {
  const parsed = Number(value.replaceAll(",", ""));

  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function couponExpiryIso(value: string): string | undefined | null {
  if (!value) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const timestamp = Date.parse(`${value}+09:00`);
  if (!Number.isFinite(timestamp)) return null;
  const roundTrip = new Date(timestamp + 9 * 60 * 60 * 1_000)
    .toISOString()
    .slice(0, 16);
  return roundTrip === value ? new Date(timestamp).toISOString() : null;
}

function campaignDraftValidation(
  title: string,
  body: string,
  channelCount: number,
): string | null {
  if (channelCount < 1 || channelCount > 3)
    return "초안에 포함할 채널을 하나 이상 선택해 주세요.";
  if (!title.trim() || title.trim().length > 160)
    return "캠페인 제목은 1–160자로 입력해 주세요.";
  if (!body.trim() || body.trim().length > 8_000)
    return "메시지는 1–8,000자로 입력해 주세요.";
  return null;
}

function couponDraftValidation(
  name: string,
  code: string,
  type: "percent" | "amount",
  value: string,
  expiresAt: string,
): string | null {
  if (!name.trim() || name.trim().length > 120)
    return "쿠폰명은 1–120자로 입력해 주세요.";
  if (!/^[A-Z0-9][A-Z0-9_-]{2,31}$/.test(code.trim().toUpperCase()))
    return "쿠폰 코드는 영문·숫자로 시작하는 3–32자의 영문·숫자·_·-만 사용할 수 있습니다.";
  const amount = Number(value.trim());
  if (
    !/^\d+$/.test(value.trim()) ||
    !Number.isSafeInteger(amount) ||
    amount < 1 ||
    amount > (type === "percent" ? 100 : 100_000_000)
  )
    return type === "percent"
      ? "할인율은 1–100 사이의 정수만 입력해 주세요."
      : "할인 금액은 1–100,000,000원 사이의 정수만 입력해 주세요.";
  if (couponExpiryIso(expiresAt) === null)
    return "만료 시각을 실제 존재하는 날짜와 한국 시간으로 입력해 주세요.";
  return null;
}
