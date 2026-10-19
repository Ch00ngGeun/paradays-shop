// 역할: Cognito admin 그룹 사용자에게만 노출되는 정적 관리자 워크스페이스 UI를 제공합니다.
"use client";

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
import {
  getOcrInputErrorMessage,
  getOcrReviewRowValidationMessage,
  OCR_INPUT_LIMITS,
  validateOcrImageFile,
} from "@/lib/admin-ui/ocr-input-validation";
import {
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
import {
  OcrInventoryCommitPanel,
  OcrInventoryAttemptStore,
} from "./ocr-inventory-commit";

type Notice =
  | Readonly<{ kind: "error"; message: string }>
  | Readonly<{ kind: "success"; message: string }>
  | null;

type MarketingChannel = "email" | "sms" | "push";

type OcrState = "idle" | "connection-needed" | "recognizing" | "review";

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

const sectionShortLabels: Record<AdminSection, string> = {
  overview: "홈",
  products: "상품",
  inventory: "재고",
  sales: "매출·일마감",
  brands: "브랜드",
  members: "회원",
  coupons: "쿠폰",
  marketing: "마케팅",
  ocr: "입고 OCR",
};

const sectionItems: ReadonlyArray<Readonly<{ id: AdminSection; label: string }>> = [
  { id: "overview", label: "운영 현황" },
  { id: "products", label: "상품 등록" },
  { id: "inventory", label: "재고 수정" },
  { id: "sales", label: "매출·일마감" },
  { id: "brands", label: "브랜드" },
  { id: "members", label: "회원" },
  { id: "coupons", label: "쿠폰" },
  { id: "marketing", label: "마케팅" },
  { id: "ocr", label: "입고 OCR" },
];

function AdminMenuIcon({ section }: Readonly<{ section: AdminSection }>) {
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
      <path d={paths[section]} />
    </svg>
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
        message: "상품 목록을 불러오지 못했습니다. 관리자 권한과 API를 확인해 주세요.",
      });
      return null;
    } finally {
      if (requestGeneration === catalogRequestGenerationRef.current)
        setIsLoadingProducts(false);
    }
  };

  useEffect(() => {
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
  const previewName = productDraft.name.trim() || "상품명을 입력하세요";

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
    const id = productEditors.open("create", emptyProductDraft);
    setProductNotice(null);
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
      id: productDraft.productId ?? `local_${Date.now()}`,
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
    if (productEditor)
      productEditors.updateDraft(productEditor.id, (current) => ({
        ...current,
        [field]: value,
      }));
  };

  const updateProductToggle = (field: "isVisible" | "isFeatured", value: boolean) => {
    if (productEditor)
      productEditors.updateDraft(productEditor.id, (current) => ({
        ...current,
        [field]: value,
      }));
  };

  const handleProductImageChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];

    if (!file || !productEditor) {
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    productEditors.setImage(productEditor.id, file, objectUrl);
    setProductNotice({
      kind: "success",
      message: "이미지가 미리보기에 반영되었습니다. 아직 저장되지 않았습니다.",
    });
  };

  const handleProductSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const savingEditor = productEditors.getSnapshot();
    if (!savingEditor || isSavingProduct) return;
    const setEditorNotice = (notice: Notice) => {
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
        message: "상품명, 브랜드, 판매가를 입력한 뒤 저장해 주세요.",
      });
      return;
    }

    if (productDraft.isVisible && previewSizes.length === 0) {
      setEditorNotice({
        kind: "error",
        message: "스토어 공개 준비 상품은 최소 한 개의 옵션/사이즈가 필요합니다.",
      });
      return;
    }

    if (previewCompareAtPrice > 0 && previewCompareAtPrice <= previewPrice) {
      setEditorNotice({
        kind: "error",
        message: "정가는 판매가보다 큰 값으로 입력해 주세요.",
      });
      return;
    }

    if (productDraft.imageUrl.startsWith("blob:")) {
      if (!actions?.uploadProductImage || !savingEditor.imageFile) {
        setEditorNotice({
          kind: "error",
          message:
            "상품 이미지 저장소 API가 아직 연결되지 않았습니다. CDK 배포 후 다시 시도해 주세요.",
        });
        return;
      }
    }

    if (
      productDraft.isVisible &&
      actions?.saveProductDraft &&
      !window.confirm(
        `“${name}”을 공개 상태로 저장할까요? 저장하면 상품 정보가 스토어에 표시됩니다.`,
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
        message:
          "상품 이미지를 저장소에 올리지 못했습니다. 파일 형식(JPEG/PNG/WebP/GIF)과 6MB 이하인지 확인해 주세요.",
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
            ? error.message
            : "상품명·설명을 자동 번역하지 못했습니다. 잠시 후 다시 시도해 주세요.",
      });
      return;
    }

    if (!productEditors.has(savingEditor.id)) {
      setIsSavingProduct(false);
      return;
    }

    if (!actions?.saveProductDraft) {
      rememberLocalProduct({ ...productDraft, imageUrl: imageUrlForSave }, name);
      setEditorNotice({
        kind: "success",
        message: `“${name}”을 이 브라우저의 임시 목록에만 보관했습니다. 서버에 저장하거나 스토어에 공개하지 않았으며 새로고침하면 사라집니다.`,
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

      setEditorNotice({
        kind: "success",
        message: productDraft.isVisible
          ? "상품을 공개 상태로 저장했습니다. 이미지와 한/영 문구가 함께 반영되었습니다."
          : "상품을 비공개로 저장했습니다. 고객에게는 표시되지 않습니다.",
      });
      finishProductEditor(savingEditor.id, productDraft.productId);
    } catch {
      setEditorNotice({
        kind: "error",
        message: "상품을 저장하지 못했습니다. 네트워크와 관리자 권한을 확인해 주세요.",
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
        ? "선택한 상품을 삭제할까요? 이 작업은 되돌릴 수 없습니다."
        : `선택한 ${items.length}개 상품을 삭제할까요? 이 작업은 되돌릴 수 없습니다.`,
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
            message: "상품 삭제 API가 아직 연결되지 않았습니다.",
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
            ? "상품을 삭제했습니다."
            : `${items.length}개 상품을 삭제했습니다.`,
      });
    } catch {
      setProductNotice({
        kind: "error",
        message: "상품을 삭제하지 못했습니다. 관리자 권한과 API를 확인해 주세요.",
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
        message: "최신 재고를 불러오지 못했습니다. 연결을 확인하고 다시 조회해 주세요.",
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
        message: "상품 재고가 변경되었습니다. 최신 수량을 다시 확인해 주세요.",
      });
      return null;
    }
    if (!Number.isInteger(nextStock) || nextStock < 0 || nextStock > 1_000_000) {
      setInventoryNotice({
        kind: "error",
        message: "재고는 0~1,000,000 사이의 정수로 입력해 주세요.",
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
        message: `${product.name} 수량을 이 화면에서만 ${clamped}개로 변경했습니다. 서버 재고에는 반영되지 않았습니다.`,
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
        message: `${updated.name} 재고를 ${updated.stock}개로 저장했습니다.`,
      });
      return updated;
    } catch {
      const products = await refreshCatalogProducts();
      setInventoryNotice({
        kind: "error",
        message: products
          ? "재고 변경 결과를 다시 확인해야 합니다. 최신 목록을 불러왔으니 수량을 검토한 뒤 다시 시작해 주세요."
          : "재고 변경 결과와 최신 수량을 확인하지 못했습니다. 중복 저장하지 말고 새로고침으로 결과를 확인해 주세요.",
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

  const resetProductDraft = () => {
    if (productEditor) productEditors.reset(productEditor.id, emptyProductDraft);
    setProductNotice(null);
  };

  const handleBrandSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (brandBusyRef.current) return;
    const normalizedBrand = brandName.trim();

    if (!normalizedBrand) {
      setBrandNotice({ kind: "error", message: "브랜드명을 입력해 주세요." });
      return;
    }

    if (normalizedBrand.length > 100 || brandMemo.trim().length > 1_000) {
      setBrandNotice({
        kind: "error",
        message: "브랜드명은 100자, 운영 메모는 1,000자까지 입력해 주세요.",
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
        message: "이미 이 화면의 목록에 있는 브랜드명입니다. 목록에서 확인해 주세요.",
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
      setBrandNotice({
        kind: "success",
        message: saveToServer
          ? `“${normalizedBrand}” 브랜드를 서버에 등록했습니다.`
          : `“${normalizedBrand}” 브랜드명을 이 화면에만 임시 추가했습니다. 서버에는 저장되지 않습니다.`,
      });
      setBrandName("");
      setBrandMemo("");
    } catch {
      setBrandNotice({
        kind: "error",
        message:
          "브랜드 등록 결과를 확인하지 못했습니다. 입력은 유지했습니다. 중복 등록하지 않도록 관리자 권한·연결과 서버의 처리 결과를 확인해 주세요.",
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
        ? `${Number(couponValue)}% 할인`
        : `${moneyFormatter.format(Number(couponValue))} 할인`;
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
      setCouponNotice({
        kind: "success",
        message: saveToServer
          ? `${draft.code} · ${formattedBenefit} 초안을 서버에 저장했습니다. 아직 고객에게 발급되지 않았습니다.`
          : `${draft.code} · ${formattedBenefit} 초안을 이 화면에만 준비했습니다. 서버 저장·고객 발급은 하지 않았습니다.`,
      });
    } catch {
      setCouponNotice({
        kind: "error",
        message:
          "쿠폰 초안 저장 결과를 확인하지 못했습니다. 입력은 유지했습니다. 중복 저장하지 않도록 서버 처리 결과와 연결을 확인해 주세요.",
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
      setCampaignNotice({
        kind: "success",
        message: saveToServer
          ? `${selectedChannelLabels.join(" · ")} 캠페인 초안을 서버에 저장했습니다. 고객에게 발송하지 않았습니다.`
          : `${selectedChannelLabels.join(" · ")} 캠페인 초안을 이 화면에만 준비했습니다. 서버 저장·고객 발송은 하지 않았습니다.`,
      });
    } catch {
      setCampaignNotice({
        kind: "error",
        message:
          "캠페인 초안 저장 결과를 확인하지 못했습니다. 입력은 유지했습니다. 중복 저장하지 않도록 서버 처리 결과와 연결을 확인해 주세요.",
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
        message: "회원 목록 API가 아직 연결되지 않았습니다.",
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
        message: `이번 조회에서 회원 ${nextMembers.length}명을 불러왔습니다. 전체 회원 수가 아닌 이번 API 응답 범위입니다.`,
      });
    } catch {
      setMemberLoadFailed(true);
      setMemberNotice({
        kind: "error",
        message:
          "회원 목록을 불러오지 못했습니다. 기존 목록이 있다면 이전 조회 결과이며 최신 상태가 아닐 수 있습니다. 관리자 권한·연결을 확인한 뒤 다시 조회해 주세요.",
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
        message:
          "확인한 회원 권한과 현재 목록이 다릅니다. 회원 목록을 다시 조회하고 변경 내용을 검토해 주세요.",
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
        message: "자기 자신의 admin 권한은 해제할 수 없습니다.",
      });
      return;
    }
    if (!actions?.updateMemberGroup) {
      setMemberNotice({
        kind: "error",
        message: "회원 그룹 API가 아직 연결되지 않았습니다.",
      });
      return;
    }

    const changeLabel = `${username} 계정의 ${group} 그룹 ${add ? "부여" : "해제"}`;
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
          message: `${changeLabel} 요청은 성공했습니다. 최신 회원 목록을 확인하지 못했으므로 이전 권한 표시를 신뢰하지 말고 다시 조회해 주세요. 재조회 전에는 권한을 다시 변경할 수 없습니다.`,
        });
        return;
      }
      setMemberNotice({
        kind: "success",
        message: `${changeLabel} 요청이 성공했고 목록을 다시 불러왔습니다. 새 권한은 다음 로그인부터 적용됩니다.`,
      });
    } catch {
      setMemberNeedsRefresh(true);
      setMemberNotice({
        kind: "error",
        message: `${changeLabel} 결과를 확인하지 못했습니다. 실제로 반영됐을 수 있으므로 재전송하지 말고 회원 목록을 다시 조회해 주세요. 자기 자신의 admin 해제는 서버에서 금지합니다.`,
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
      setOcrNotice({
        kind: "success",
        message: `“${file.name}” 파일의 이름·MIME·매직 바이트·4MiB 직접 전송 한도를 확인했습니다.`,
      });
    } catch (error) {
      if (selectionId !== ocrFileSelectionRef.current) {
        return;
      }

      event.target.value = "";
      setOcrNotice({
        kind: "error",
        message:
          getOcrInputErrorMessage(error) ??
          "이미지 파일을 검증하지 못했습니다. 파일을 다시 선택해 주세요.",
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
        message: "먼저 입고 목록 이미지 파일을 선택해 주세요.",
      });
      return;
    }

    if (!actions?.recognizeInventory) {
      setOcrState("connection-needed");
      setOcrNotice({
        kind: "error",
        message:
          "OCR API 연결을 기다리고 있습니다. 이미지나 OCR 키를 브라우저에 직접 노출하지 않습니다.",
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
            ? "인식된 텍스트가 없습니다. 더 선명한 이미지를 선택하거나 행 추가로 직접 입력해 주세요."
            : hasTableFields
              ? result.rows.length +
                "개 상품 행을 인식했습니다. 저장 전에 상품명·브랜드·옵션·수량을 반드시 검토해 주세요."
              : "표의 열을 확정하지 못해 미분류 원문 " +
                result.rows.length +
                "개를 그대로 표시합니다. 열 지정 또는 직접 입력으로 상품 필드를 확인해 주세요. 분류 사유: " +
                (result.analysis?.reason ?? "이전 응답에 분류 정보 없음"),
      });
    } catch (error) {
      if (
        requestGeneration !== ocrRequestGenerationRef.current ||
        selectionId !== ocrFileSelectionRef.current
      ) {
        return;
      }
      setOcrState("idle");
      setOcrNotice({
        kind: "error",
        message:
          getOcrInputErrorMessage(error) ??
          getOcrRequestErrorMessage(error) ??
          "OCR 요청에 실패했습니다. 이미지 형식과 관리자 API·PaddleOCR 연결을 확인해 주세요.",
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
        message: `검토 행은 최대 ${OCR_INPUT_LIMITS.maxReviewRows}개까지 추가할 수 있습니다.`,
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
      setOcrNotice({ kind: "error", message: "저장할 입고 행이 없습니다." });
      return;
    }

    const validationMessage = getOcrReviewRowValidationMessage(ocrRows);

    if (validationMessage) {
      setOcrNotice({ kind: "error", message: validationMessage });
      return;
    }

    if (!actions?.saveOcrReview || !ocrJobId || ocrVersion === null) {
      setOcrState("connection-needed");
      setOcrNotice({
        kind: "error",
        message:
          "OCR 검토 저장 API가 연결되지 않았습니다. 현재 화면의 초안은 서버에 저장되지 않았습니다.",
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
        setOcrNotice({
          kind: "error",
          message:
            "다른 관리자의 수정이 먼저 저장되어 최신 OCR 검토본을 다시 불러왔습니다. 내용을 다시 확인한 뒤 저장해 주세요.",
        });
        return;
      }

      setOcrNotice({
        kind: "success",
        message: `검토한 입고 행을 관리자 API에 저장했습니다. 서버 버전 ${result.job.version}을 적용했습니다. 실제 재고를 변경하려면 아래 재고 반영에서 상품과 수량을 확인해 주세요.`,
      });
      setOcrInventoryJob(result.job);
    } catch {
      if (!isCurrentRequest()) {
        return;
      }
      setOcrNotice({
        kind: "error",
        message: "입고 행을 저장하지 못했습니다. 내용을 확인한 뒤 다시 시도해 주세요.",
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
        setOcrNotice({
          kind: result.kind === "conflict" ? "error" : "success",
          message:
            result.kind === "conflict"
              ? "다른 수정이 먼저 저장되어 최신 OCR 검토본을 불러왔습니다. 열 지정을 다시 미리보기해 주세요."
              : `열 지정을 원본 OCR에 적용했습니다. 서버 버전 ${result.job.version}의 상품 필드를 검토한 뒤 초안을 저장해 주세요.`,
        });
      }
      return result;
    } catch (error) {
      if (current())
        setOcrNotice({
          kind: "error",
          message:
            getOcrRequestErrorMessage(error) ??
            "열 지정에 실패했습니다. 현재 검토본은 유지됩니다.",
        });
      return null;
    } finally {
      if (generation === ocrRequestGenerationRef.current) setIsSavingOcr(false);
    }
  };

  return (
    <section className={styles.adminPage} aria-label="PARADAYS 관리자 화면">
      <header className={styles.adminHeader}>
        <div>
          <p className={styles.adminBreadcrumb}>
            {locale === "ko" ? "관리자" : "Admin"}
            <span aria-hidden="true">/</span>
            {activeSection === "overview"
              ? locale === "ko"
                ? "홈"
                : "Home"
              : sectionShortLabels[activeSection]}
          </p>
          <h1 className={styles.srOnly}>스토어 운영</h1>
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

      <nav aria-label="관리자 메뉴" className={styles.sidebar}>
        <div className={styles.sidebarIntro}>
          <strong>PARADAYS</strong>
          <span>{locale === "ko" ? "관리자" : "Admin"}</span>
        </div>
        <button
          aria-controls="ops-menu-drawer"
          aria-expanded={isOpsMenuOpen}
          className={styles.opsMenuButton}
          onClick={() => setIsOpsMenuOpen((open) => !open)}
          ref={menuButtonRef}
          type="button"
        >
          <span className="srOnly">운영 메뉴 {isOpsMenuOpen ? "닫기" : "열기"}</span>
          <span aria-hidden="true" />
          <span aria-hidden="true" />
          <span aria-hidden="true" />
        </button>
      </nav>

      {isOpsMenuOpen && !isDesktopAdmin ? (
        <button
          aria-label="메뉴 닫기"
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
        aria-label="관리자 메뉴"
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
            aria-label="메뉴 닫기"
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
                section.id === "overview" ? copy.adminOverviewMenu : section.label
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
              <span>{sectionShortLabels[section.id]}</span>
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
        className={styles.workspace}
        id={`admin-panel-${activeSection}`}
        role="tabpanel"
        tabIndex={-1}
      >
        {activeSection === "overview" ? (
          <>
            <OverviewSection
              loadOverviewMetrics={actions?.loadOverviewMetrics}
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
            loading={isLoadingProducts}
            lockInputs={isSavingProduct && savingProductEditorId === productEditor?.id}
            notice={productNotice}
            onCloseEditor={() => {
              if (productEditor) finishProductEditor(productEditor.id);
              setProductNotice(null);
            }}
            onDeleteProducts={(items) => void handleDeleteProducts(items)}
            onEditProduct={(product) => openProductEditor(product, "edit")}
            onImageChange={handleProductImageChange}
            onOpenCreate={openNewProductEditor}
            onReset={resetProductDraft}
            onSave={(event) => void handleProductSave(event)}
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
            onMemoChange={setBrandMemo}
            onNameChange={setBrandName}
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
            }}
            onExpiresAtChange={(value) => {
              setCouponExpiresAt(value);
              setCouponNotice(null);
            }}
            onNameChange={(value) => {
              setCouponName(value);
              setCouponNotice(null);
            }}
            onSubmit={(event) => void handleCouponSubmit(event)}
            onTypeChange={(value) => {
              setCouponType(value);
              setCouponNotice(null);
            }}
            onValueChange={(value) => {
              setCouponValue(value);
              setCouponNotice(null);
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
            }}
            onChannelChange={(channel, selected) => {
              setCampaignChannels((current) => ({ ...current, [channel]: selected }));
              setCampaignNotice(null);
            }}
            onSubmit={(event) => void handleCampaignSubmit(event)}
            onTitleChange={(value) => {
              setCampaignTitle(value);
              setCampaignNotice(null);
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
  loadOverviewMetrics,
  onGoTo,
  onOpenCreate,
}: Readonly<{
  loadOverviewMetrics?: () => Promise<AdminOverviewMetrics>;
  onGoTo: (section: AdminSection) => void;
  onOpenCreate: () => void;
}>) {
  const { copy, locale } = useLocale();
  const isKorean = locale === "ko";
  const [metrics, setMetrics] = useState<AdminOverviewMetrics | null>(null);
  const [metricsState, setMetricsState] = useState<
    "loading" | "ready" | "unavailable" | "error"
  >(loadOverviewMetrics ? "loading" : "unavailable");

  useEffect(() => {
    if (!loadOverviewMetrics) {
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

  return (
    <div className={`${styles.sectionStack} ${styles.overviewStack}`}>
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

function ProductSection({
  brands,
  canSaveToServer,
  canUploadImages,
  deleting,
  draft,
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
  const previewDescriptionLines = draft.description
    .split(/\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const currentProduct = products.find((product) => product.id === draft.productId);
  const isCurrentlyPublic = Boolean(
    currentProduct?.version && currentProduct.isVisible,
  );
  const saveLabel = !canSaveToServer
    ? "이 브라우저에 초안 보관"
    : draft.isVisible
      ? view === "edit" && isCurrentlyPublic
        ? "공개 상태로 수정 저장"
        : "저장 후 스토어 공개"
      : view === "edit"
        ? "비공개 수정 저장"
        : "비공개로 저장";
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [filterQuery, setFilterQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "published" | "draft">(
    "all",
  );
  const [stockFilter, setStockFilter] = useState<"all" | "inStock" | "soldOut">("all");
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

  if (view === "list") {
    return (
      <div className={`${styles.sectionStack} ${styles.productScreen}`}>
        <div className={styles.productListHeader}>
          <div className={styles.productPageHeading}>
            <h2>상품 관리</h2>
            <p>상품의 공개 상태와 재고를 확인하세요.</p>
          </div>
          <div className={styles.productListHeaderActions}>
            <button
              aria-label="새 상품 등록"
              className={styles.addProductButton}
              onClick={onOpenCreate}
              type="button"
            >
              <span aria-hidden="true">＋</span> 새 상품
            </button>
          </div>
        </div>
        {notice ? <NoticeMessage notice={notice} /> : null}
        <div className={styles.productToolbar}>
          <label className={styles.productFilterSearch}>
            <span className={styles.srOnly}>상품 검색</span>
            <input
              onChange={(event) => setFilterQuery(event.target.value)}
              placeholder="상품명 · 브랜드 · SKU 검색"
              type="search"
              value={filterQuery}
            />
          </label>
          <label className={styles.productFilterSelect}>
            <span>상태</span>
            <select
              onChange={(event) =>
                setStatusFilter(event.target.value as "all" | "published" | "draft")
              }
              value={statusFilter}
            >
              <option value="all">전체</option>
              <option value="published">공개</option>
              <option value="draft">비공개</option>
            </select>
          </label>
          <label className={styles.productFilterSelect}>
            <span>재고</span>
            <select
              onChange={(event) =>
                setStockFilter(event.target.value as "all" | "inStock" | "soldOut")
              }
              value={stockFilter}
            >
              <option value="all">전체</option>
              <option value="inStock">재고 있음</option>
              <option value="soldOut">품절</option>
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
            <span>전체 선택</span>
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
              ? "삭제 중…"
              : selectedProducts.length > 0
                ? `선택 삭제 (${selectedProducts.length})`
                : "선택 삭제"}
          </button>
        </div>
        {loading ? (
          <p className={styles.productListEmpty}>상품 목록을 불러오는 중…</p>
        ) : filteredProducts.length === 0 ? (
          <p className={styles.productListEmpty}>
            {products.length === 0
              ? "아직 등록된 상품이 없습니다. 새 상품을 추가해 보세요."
              : "필터 조건에 맞는 상품이 없습니다."}
          </p>
        ) : (
          <ul className={styles.productList}>
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
                    aria-label={`${product.name} 선택`}
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
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      alt=""
                      src={product.imageUrl || "/images/product-placeholder.svg"}
                    />
                    <div className={styles.productListMain}>
                      <strong>{product.name}</strong>
                      <span>
                        {product.brand} · {product.category}
                      </span>
                      {product.sku ? <small>{product.sku}</small> : null}
                    </div>
                  </div>
                  <span className={styles.productStock}>
                    재고 {product.stock}
                    {product.stock <= 0 ? (
                      <em className={styles.productSoldOutBadge}>품절</em>
                    ) : null}
                  </span>
                  <span>{moneyFormatter.format(product.price)}</span>
                  <span
                    className={
                      product.isVisible && product.version > 0
                        ? styles.publicStatus
                        : styles.draftStatus
                    }
                  >
                    {product.version <= 0
                      ? "로컬 초안"
                      : product.isVisible
                        ? "공개"
                        : "비공개"}
                  </span>
                  <div className={styles.productRowActions}>
                    <button
                      className={styles.productRowEditButton}
                      onClick={() => onEditProduct(product)}
                      type="button"
                    >
                      수정
                    </button>
                    <button
                      className={styles.productRowDeleteButton}
                      disabled={deleting}
                      onClick={() =>
                        onDeleteProducts([{ id: product.id, version: product.version }])
                      }
                      type="button"
                    >
                      삭제
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

  const editorTitle = view === "edit" ? "상품 수정" : "새 상품";

  return (
    <div className={`${styles.sectionStack} ${styles.productScreen}`}>
      <div className={styles.productEditorToolbar}>
        <button
          className={styles.backToListButton}
          onClick={onCloseEditor}
          type="button"
        >
          ← 목록으로
        </button>
      </div>
      <div className={styles.productPageHeading}>
        <div className={styles.productEditorTitle}>
          <h2>{editorTitle}</h2>
          <span className={styles.productSaveState}>
            {canSaveToServer
              ? draft.isVisible
                ? "공개 설정 · 저장 전"
                : "비공개 · 저장 전"
              : "로컬 초안 · 서버 미연결"}
          </span>
        </div>
        {view === "edit" && currentProduct?.version ? (
          <p>
            현재 {isCurrentlyPublic ? "공개" : "비공개"} → 저장 후{" "}
            {draft.isVisible ? "공개" : "비공개"}
          </p>
        ) : (
          <p>저장 전 고객 화면을 미리 확인하세요.</p>
        )}
      </div>
      <div className={styles.productEditor}>
        <form
          className={styles.editorForm}
          noValidate
          onSubmit={onSave}
          aria-busy={lockInputs}
        >
          <fieldset className={styles.formGroup} disabled={lockInputs}>
            <legend>기본 정보</legend>
            <label className={styles.fieldWide}>
              <span>
                상품명 <em>*</em>
              </span>
              <input
                onChange={(event) => onTextChange("name", event.target.value)}
                placeholder="예: O'Dwyer Deck [8.25”]"
                required
                value={draft.name}
              />
            </label>
            <label>
              <span>
                브랜드 <em>*</em>
              </span>
              <input
                list="admin-brand-options"
                onChange={(event) => onTextChange("brand", event.target.value)}
                placeholder="브랜드 입력 또는 선택"
                required
                value={draft.brand}
              />
              <datalist id="admin-brand-options">
                {brands.map((brand) => (
                  <option key={brand} value={brand} />
                ))}
              </datalist>
            </label>
            <label>
              <span>카테고리</span>
              <select
                onChange={(event) => onTextChange("category", event.target.value)}
                value={draft.category}
              >
                <option value="Deck">데크</option>
                <option value="Complete">컴플리트</option>
                <option value="Trucks">트럭</option>
                <option value="Wheels">휠</option>
                <option value="Bearings">베어링</option>
                <option value="Top">상의</option>
                <option value="Bottom">하의</option>
                <option value="Accessories">액세서리</option>
              </select>
            </label>
            <label>
              <span>SKU / 관리 코드</span>
              <input
                onChange={(event) => onTextChange("sku", event.target.value)}
                placeholder="예: APR-ODW-825"
                value={draft.sku}
              />
            </label>
            <label>
              <span>재고 수량</span>
              <input
                inputMode="numeric"
                min="0"
                onChange={(event) => onTextChange("stock", event.target.value)}
                placeholder="0"
                type="number"
                value={draft.stock}
              />
            </label>
          </fieldset>

          <fieldset className={styles.formGroup} disabled={lockInputs}>
            <legend>판매 정보</legend>
            <label>
              <span>
                판매가 <em>*</em>
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
              <span>정가 (선택)</span>
              <input
                inputMode="numeric"
                min="0"
                onChange={(event) => onTextChange("compareAtPrice", event.target.value)}
                placeholder="128000"
                type="number"
                value={draft.compareAtPrice}
              />
            </label>
            <label className={styles.fieldWide}>
              <span>사이즈 / 옵션</span>
              <input
                onChange={(event) => onTextChange("sizes", event.target.value)}
                placeholder="8.0”, 8.25”, 8.5”"
                value={draft.sizes}
              />
              <small>여러 옵션은 쉼표로 구분</small>
            </label>
            <label className={styles.fieldWide}>
              <span>상품 설명</span>
              <textarea
                onChange={(event) => onTextChange("description", event.target.value)}
                placeholder={
                  "Heavy Flannel Weave\nDual Chest Pockets\nButton Front Closure"
                }
                rows={4}
                value={draft.description}
              />
              <small>줄바꿈으로 항목 구분</small>
            </label>
          </fieldset>

          <fieldset className={styles.formGroup} disabled={lockInputs}>
            <legend>대표 이미지</legend>
            <label className={styles.uploadField}>
              <span>대표 이미지</span>
              <input
                accept="image/jpeg,image/png,image/webp,image/gif"
                onChange={onImageChange}
                type="file"
              />
              <small>
                JPEG·PNG·WebP·GIF · 최대 6MB
                {canUploadImages ? " · 저장할 때 업로드" : " · 업로드 연결 필요"}
              </small>
            </label>
          </fieldset>
          <fieldset className={styles.formGroup} disabled={lockInputs}>
            <legend>공개 설정</legend>
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
                <span>저장 후 스토어에 공개</span>
              </label>
              <label className={styles.checkRow}>
                <input
                  checked={draft.isFeatured}
                  onChange={(event) =>
                    onToggleChange("isFeatured", event.target.checked)
                  }
                  type="checkbox"
                />
                <span>신상품 배지 표시</span>
              </label>
            </div>
            {!canSaveToServer ? (
              <small>관리자 API 연결 후 공개할 수 있습니다.</small>
            ) : null}
          </fieldset>

          {notice ? <NoticeMessage notice={notice} /> : null}
          {!canSaveToServer ? (
            <p className={styles.productStorageNote} role="status">
              서버 미연결 · 이 브라우저에만 보관되며 새로고침하면 사라집니다. 스토어에는
              공개되지 않습니다.
            </p>
          ) : null}
          <div className={styles.formActions}>
            <button
              className={styles.secondaryButton}
              disabled={lockInputs}
              onClick={onReset}
              type="button"
            >
              {view === "edit" ? "입력 초기화" : "새 초안"}
            </button>
            <button className={styles.primaryButton} disabled={saving} type="submit">
              {saving ? (lockInputs ? "저장 중…" : "다른 상품 저장 중…") : saveLabel}
            </button>
          </div>
          <p className={styles.productSaveHint}>
            {canSaveToServer
              ? draft.isVisible
                ? "저장 직전에 공개 내용을 한 번 더 확인합니다."
                : "비공개 상품은 고객에게 표시되지 않습니다."
              : "서버 저장·공개는 관리자 API 연결 후 가능합니다."}
          </p>
        </form>

        <aside
          className={`${styles.previewPanel} ${styles.productPreview}`}
          aria-label="고객 화면 미리보기"
        >
          <div className={styles.previewHeader}>
            <div>
              <h2>고객 화면 미리보기</h2>
            </div>
            <span className={styles.productSaveState}>
              {canSaveToServer
                ? draft.isVisible
                  ? "공개 예정"
                  : "비공개"
                : "로컬 미리보기"}
            </span>
          </div>
          <article className={styles.storeCardPreview}>
            <div className={styles.storeCardDetail}>
              <div className={styles.storeCardInfo}>
                <p className={styles.productPreviewBrand}>
                  {draft.brand.trim() || "브랜드"}
                </p>
                <h3>{previewName}</h3>
                {previewDescriptionLines.length > 0 ? (
                  <ul className={styles.storeCardDescription}>
                    {previewDescriptionLines.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                ) : (
                  <p className={styles.previewHint}>상품 설명 미입력</p>
                )}

                <div className={styles.storeCardOptions}>
                  <fieldset>
                    <legend>옵션</legend>
                    {previewSizes.length > 0 ? (
                      <div
                        className={styles.storeCardSizes}
                        aria-label="선택 가능한 옵션"
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
                      <span className={styles.previewHint}>옵션 미입력</span>
                    )}
                  </fieldset>
                </div>

                <div className={styles.productPreviewPrice}>
                  <span>
                    {previewPrice > 0
                      ? moneyFormatter.format(previewPrice)
                      : "판매가 입력"}
                    {previewCompareAtPrice > previewPrice && previewPrice > 0 ? (
                      <s>{moneyFormatter.format(previewCompareAtPrice)}</s>
                    ) : null}
                  </span>
                </div>
              </div>

              <div className={styles.storeCardMedia}>
                {draft.isFeatured ? <span className={styles.newBadge}>NEW</span> : null}
                {/* 파일 선택으로 생긴 blob URL은 정적 export의 이미지 최적화 경로를 거치지 않습니다. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img alt={`${previewName} 상품 이미지 미리보기`} src={draft.imageUrl} />
              </div>
            </div>
            <footer>
              <span>{draft.category}</span>
              <span
                className={draft.isVisible ? styles.publicStatus : styles.draftStatus}
              >
                {canSaveToServer
                  ? draft.isVisible
                    ? "저장 후 공개"
                    : "비공개 저장 예정"
                  : "서버 미저장"}
              </span>
            </footer>
          </article>
          <p className={styles.previewNote}>
            {canSaveToServer
              ? view === "edit"
                ? "입력한 변경 내용은 저장 후 반영됩니다."
                : "아직 고객에게 보이지 않습니다."
              : "서버 연결 전에는 실제 저장·공개되지 않습니다."}
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
  const [stockFilter, setStockFilter] = useState<"all" | "inStock" | "low" | "soldOut">(
    "all",
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
  }, [filterQuery, products, stockFilter]);

  return (
    <div className={`${styles.sectionStack} ${styles.inventoryScreen}`}>
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
                const stockTone =
                  product.stock <= 0
                    ? styles.inventorySoldOut
                    : product.stock <= 5
                      ? styles.inventoryLow
                      : undefined;

                return (
                  <li className={styles.inventoryRow} key={product.id}>
                    <button
                      aria-label={`${product.name} 재고 조정`}
                      aria-pressed={selectedId === product.id}
                      className={styles.inventorySelect}
                      onClick={() => selectInventoryProduct(product.id)}
                      type="button"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        alt=""
                        src={product.imageUrl || "/images/product-placeholder.svg"}
                      />
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
                        <span className={stockTone}>
                          {product.stock <= 0
                            ? "품절"
                            : product.stock <= 5
                              ? "주의"
                              : "정상"}
                        </span>
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
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img alt="" src={product.imageUrl || "/images/product-placeholder.svg"} />
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

  return (
    <div className={`${styles.sectionStack} ${styles.brandScreen}`}>
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
  return (
    <div className={`${styles.sectionStack} ${styles.memberScreen}`}>
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
      <ol className={styles.couponWorkflow} aria-label="쿠폰 초안 작성 순서">
        <li>
          <span>1</span> 혜택 설정
        </li>
        <li>
          <span>2</span> 미리보기 확인
        </li>
        <li>
          <span>3</span> 초안 저장
        </li>
      </ol>
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
              <span>쿠폰명 (필수)</span>
              <input
                maxLength={120}
                required
                onChange={(event) => onNameChange(event.target.value)}
                placeholder="첫 구매 웰컴 쿠폰"
                value={couponName}
              />
            </label>
            <label>
              <span>쿠폰 코드 (필수)</span>
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
      <ol className={styles.campaignWorkflow} aria-label="캠페인 초안 작성 순서">
        <li>
          <span>1</span> 채널 선택
        </li>
        <li>
          <span>2</span> 문구 미리보기
        </li>
        <li>
          <span>3</span> 초안 저장
        </li>
      </ol>
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
                  </label>
                ))}
              </div>
            </fieldset>
            <p className={styles.campaignScopeNote}>
              초안 작성용 선택 · 채널 연결·수신자 수·발송 가능 여부는 미조회입니다.
            </p>
            <label>
              <span>캠페인 제목 (필수)</span>
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
              <span>메시지 (필수)</span>
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
              <div className={styles.campaignMessageBrand}>
                PARADAYS <span>초안 문구 예시</span>
              </div>
              <div className={styles.campaignMessageBody}>
                <strong>{title.trim() || "캠페인 제목"}</strong>
                <p>
                  {body.trim() ||
                    "메시지를 입력하면 선택 채널의 초안 문구가 표시됩니다."}
                </p>
              </div>
              <small>
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
  const activeStep = recognizing ? 2 : reviewSaved ? 4 : state === "review" ? 3 : 1;
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
      <ol className={styles.ocrWorkflow} aria-label="OCR 등록 흐름">
        {["이미지 선택", "OCR 인식", "내용 검토", "검토본 저장", "입고 반영"].map(
          (step, index) => (
            <li aria-current={activeStep === index + 1 ? "step" : undefined} key={step}>
              <span>{index + 1}</span>
              {step}
            </li>
          ),
        )}
      </ol>
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
        <div className={styles.metricIcon}>
          <AdminMenuIcon section={icon} />
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
  onClick,
  primary = false,
  value,
}: Readonly<{
  actionLabel: string;
  icon: AdminSection;
  label: string;
  note: string;
  onClick: () => void;
  primary?: boolean;
  value?: string;
}>) {
  return (
    <article className={styles.overviewTask}>
      <div className={styles.taskIcon}>
        <AdminMenuIcon section={icon} />
      </div>
      <div className={styles.taskDescription}>
        <h3>
          {label}
          {value !== undefined ? (
            <span className={styles.taskCount}>{value}</span>
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
  return (
    <p
      className={notice.kind === "error" ? styles.noticeError : styles.noticeSuccess}
      role={notice.kind === "error" ? "alert" : "status"}
    >
      {notice.message}
    </p>
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
