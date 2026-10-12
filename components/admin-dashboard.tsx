// 역할: Cognito admin 그룹 사용자에게만 노출되는 정적 관리자 워크스페이스 UI를 제공합니다.
"use client";

import Link from "next/link";
import {
  type ChangeEvent,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { useAuth } from "@/contexts/auth-context";
import { useLocale } from "@/contexts/locale-context";
import { rememberAuthReturnPath } from "@/lib/auth/return-path";
import type {
  AdminBrandDraft,
  AdminCampaignDraft,
  AdminCatalogListItem,
  AdminCouponDraft,
  AdminDashboardActions,
  AdminMember,
  AdminOcrRecognitionResult,
  AdminOcrReviewRow,
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
} from "@/lib/commerce/admin-api-client";
import {
  buildProductI18nFields,
  TranslateError,
} from "@/lib/commerce/translate-text";

import styles from "./admin-dashboard.module.css";

type AdminSection =
  | "overview"
  | "products"
  | "inventory"
  | "brands"
  | "members"
  | "coupons"
  | "marketing"
  | "ocr";

type Notice =
  | Readonly<{ kind: "error"; message: string }>
  | Readonly<{ kind: "success"; message: string }>
  | null;

type MarketingChannel = "email" | "sms" | "push";

type OcrState = "idle" | "connection-needed" | "recognizing" | "review";

const ADMIN_GROUP = "admin";
const subscribeToLocalOcrMode = () => () => {};
const serverLocalOcrMode = () => false;

const sectionItems: ReadonlyArray<Readonly<{ id: AdminSection; label: string }>> = [
  { id: "overview", label: "운영 현황" },
  { id: "products", label: "상품 등록" },
  { id: "inventory", label: "재고 수정" },
  { id: "brands", label: "브랜드" },
  { id: "members", label: "회원" },
  { id: "coupons", label: "쿠폰" },
  { id: "marketing", label: "마케팅" },
  { id: "ocr", label: "입고 OCR" },
];

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
          <Link
            href="/login"
            onClick={() => rememberAuthReturnPath("/admin")}
          >
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

  return (
    <section className={styles.accessPage} aria-live="polite">
      <div className={styles.accessTopBar}>
        <Link className={styles.homeLink} href="/">
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
  const languageLabels =
    locale === "en" ? { ko: "KOR", en: "ENG" } : { ko: "한국어", en: "영어" };
  const [activeSection, setActiveSection] = useState<AdminSection>("overview");
  const [isOpsMenuOpen, setIsOpsMenuOpen] = useState(false);
  const [productView, setProductView] = useState<"list" | "create" | "edit">("list");
  const [localProducts, setLocalProducts] = useState<readonly AdminCatalogListItem[]>(
    [],
  );
  const [isLoadingProducts, setIsLoadingProducts] = useState(false);
  const [isDeletingProducts, setIsDeletingProducts] = useState(false);
  const [productDraft, setProductDraft] =
    useState<AdminProductDraft>(emptyProductDraft);
  const [productNotice, setProductNotice] = useState<Notice>(null);
  const [isSavingProduct, setIsSavingProduct] = useState(false);
  const [inventoryNotice, setInventoryNotice] = useState<Notice>(null);
  const [inventorySavingIds, setInventorySavingIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [brandName, setBrandName] = useState("");
  const [brandMemo, setBrandMemo] = useState("");
  const [localBrands, setLocalBrands] = useState<string[]>([]);
  const [brandNotice, setBrandNotice] = useState<Notice>(null);
  const [isSavingBrand, setIsSavingBrand] = useState(false);
  const [couponName, setCouponName] = useState("");
  const [couponCode, setCouponCode] = useState("");
  const [couponType, setCouponType] = useState<"percent" | "amount">("percent");
  const [couponValue, setCouponValue] = useState("");
  const [couponExpiresAt, setCouponExpiresAt] = useState("");
  const [couponNotice, setCouponNotice] = useState<Notice>(null);
  const [isSavingCoupon, setIsSavingCoupon] = useState(false);
  const [campaignTitle, setCampaignTitle] = useState("");
  const [campaignBody, setCampaignBody] = useState("");
  const [campaignChannels, setCampaignChannels] = useState<
    Record<MarketingChannel, boolean>
  >({ email: true, sms: false, push: false });
  const [campaignNotice, setCampaignNotice] = useState<Notice>(null);
  const [isSavingCampaign, setIsSavingCampaign] = useState(false);
  const [members, setMembers] = useState<readonly AdminMember[]>([]);
  const [memberNotice, setMemberNotice] = useState<Notice>(null);
  const [isLoadingMembers, setIsLoadingMembers] = useState(false);
  const [ocrFile, setOcrFile] = useState<File | null>(null);
  const [ocrState, setOcrState] = useState<OcrState>("idle");
  const [ocrRawText, setOcrRawText] = useState("");
  const [ocrRows, setOcrRows] = useState<AdminOcrReviewRow[]>([]);
  const [ocrNotice, setOcrNotice] = useState<Notice>(null);
  const [isSavingOcr, setIsSavingOcr] = useState(false);
  const [ocrJobId, setOcrJobId] = useState<string | null>(null);
  const [ocrVersion, setOcrVersion] = useState<number | null>(null);
  const productObjectUrlRef = useRef<string | null>(null);
  const productImageFileRef = useRef<File | null>(null);
  const ocrFileSelectionRef = useRef(0);
  const ocrRequestGenerationRef = useRef(0);
  const ocrCurrentJobRef = useRef<{ jobId: string; version: number } | null>(null);

  useEffect(() => {
    return () => {
      ocrRequestGenerationRef.current += 1;
      if (productObjectUrlRef.current) {
        URL.revokeObjectURL(productObjectUrlRef.current);
      }
    };
  }, []);

  const refreshCatalogProducts = async () => {
    if (!actions?.listCatalogProducts) {
      return;
    }

    setIsLoadingProducts(true);

    try {
      const products = await actions.listCatalogProducts();
      setLocalProducts(products);
    } catch {
      setProductNotice({
        kind: "error",
        message: "상품 목록을 불러오지 못했습니다. 관리자 권한과 API를 확인해 주세요.",
      });
    } finally {
      setIsLoadingProducts(false);
    }
  };

  useEffect(() => {
    void refreshCatalogProducts();
    // actions 객체는 getAccessToken 참조로 바뀌므로 listCatalogProducts 존재 여부만 의존합니다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Boolean(actions?.listCatalogProducts)]);

  useEffect(() => {
    if (!isOpsMenuOpen) {
      return;
    }

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsOpsMenuOpen(false);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpsMenuOpen]);

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
    selectSection(nextSection.id);
    window.requestAnimationFrame(() => {
      document.getElementById(`admin-tab-${nextSection.id}`)?.focus();
    });
  };

  const selectSection = (
    section: AdminSection,
    options?: Readonly<{ productView?: "list" | "create" | "edit" }>,
  ) => {
    setActiveSection(section);
    setIsOpsMenuOpen(false);
    if (section === "products") {
      setProductView(options?.productView ?? "list");
    }
  };

  const rememberLocalProduct = (name: string) => {
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
      ...(previewCompareAtPrice > 0
        ? { compareAtPrice: previewCompareAtPrice }
        : {}),
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
    if (productObjectUrlRef.current) {
      URL.revokeObjectURL(productObjectUrlRef.current);
      productObjectUrlRef.current = null;
    }

    productImageFileRef.current = null;
    setProductDraft({
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
      ...(product.descriptionI18n
        ? { descriptionI18n: product.descriptionI18n }
        : {}),
    });
    setProductNotice(null);
    setProductView(mode);
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
    setProductDraft((current) => ({ ...current, [field]: value }));
  };

  const updateProductToggle = (field: "isVisible" | "isFeatured", value: boolean) => {
    setProductDraft((current) => ({ ...current, [field]: value }));
  };

  const handleProductImageChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    if (productObjectUrlRef.current) {
      URL.revokeObjectURL(productObjectUrlRef.current);
    }

    const objectUrl = URL.createObjectURL(file);
    productObjectUrlRef.current = objectUrl;
    productImageFileRef.current = file;
    updateProductText("imageUrl", objectUrl);
    setProductNotice({
      kind: "success",
      message:
        "선택한 이미지가 미리보기에 반영되었습니다. 저장 시 S3 저장소로 업로드됩니다.",
    });
  };

  const handleProductSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = productDraft.name.trim();

    if (!name || !productDraft.brand.trim() || previewPrice <= 0) {
      setProductNotice({
        kind: "error",
        message: "상품명, 브랜드, 판매가를 입력한 뒤 임시 저장해 주세요.",
      });
      return;
    }

    if (productDraft.isVisible && previewSizes.length === 0) {
      setProductNotice({
        kind: "error",
        message: "스토어 공개 준비 상품은 최소 한 개의 옵션/사이즈가 필요합니다.",
      });
      return;
    }

    if (previewCompareAtPrice > 0 && previewCompareAtPrice <= previewPrice) {
      setProductNotice({
        kind: "error",
        message: "정가는 판매가보다 큰 값으로 입력해 주세요.",
      });
      return;
    }

    if (productDraft.imageUrl.startsWith("blob:")) {
      if (!actions?.uploadProductImage || !productImageFileRef.current) {
        setProductNotice({
          kind: "error",
          message:
            "상품 이미지 저장소 API가 아직 연결되지 않았습니다. CDK 배포 후 다시 시도해 주세요.",
        });
        return;
      }
    }

    const descriptionLines = productDraft.description
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    setIsSavingProduct(true);

    let imageUrlForSave = productDraft.imageUrl;

    try {
      if (imageUrlForSave.startsWith("blob:") && productImageFileRef.current) {
        imageUrlForSave = await actions!.uploadProductImage!(
          productImageFileRef.current,
        );
        updateProductText("imageUrl", imageUrlForSave);

        if (productObjectUrlRef.current) {
          URL.revokeObjectURL(productObjectUrlRef.current);
          productObjectUrlRef.current = null;
        }

        productImageFileRef.current = null;
      }
    } catch {
      setIsSavingProduct(false);
      setProductNotice({
        kind: "error",
        message:
          "상품 이미지를 저장소에 올리지 못했습니다. 파일 형식(JPEG/PNG/WebP/GIF)과 6MB 이하인지 확인해 주세요.",
      });
      return;
    }

    let translatedDraft: AdminProductDraft;

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
      setProductNotice({
        kind: "error",
        message:
          error instanceof TranslateError
            ? error.message
            : "상품명·설명을 자동 번역하지 못했습니다. 잠시 후 다시 시도해 주세요.",
      });
      return;
    }

    if (!actions?.saveProductDraft) {
      rememberLocalProduct(name);
      setProductNotice({
        kind: "success",
        message: `“${name}” 초안을 목록에 추가했습니다. 한/영 자동 번역 필드는 관리자 API 연결 후 저장됩니다.`,
      });
      resetProductDraft();
      setProductView("list");
      setIsSavingProduct(false);
      return;
    }

    try {
      await actions.saveProductDraft(translatedDraft);

      if (actions.listCatalogProducts) {
        await refreshCatalogProducts();
      } else {
        rememberLocalProduct(name);
      }

      setProductNotice({
        kind: "success",
        message: productDraft.productId
          ? "상품을 수정했습니다. 이미지와 한/영 문구가 함께 반영되었습니다."
          : "상품 초안을 저장했습니다. 이미지와 한/영 문구가 함께 등록되었습니다.",
      });
      resetProductDraft();
      setProductView("list");
    } catch {
      setProductNotice({
        kind: "error",
        message:
          "상품을 저장하지 못했습니다. 네트워크와 관리자 권한을 확인해 주세요.",
      });
    } finally {
      setIsSavingProduct(false);
    }
  };

  const handleDeleteProducts = async (
    items: ReadonlyArray<Readonly<{ id: string; version: number }>>,
  ) => {
    if (items.length === 0) {
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

  const handleInventoryStockChange = async (
    productId: string,
    nextStock: number,
  ) => {
    const product = localProducts.find((item) => item.id === productId);

    if (!product) {
      return;
    }

    const clamped = Math.max(0, Math.min(1_000_000, Math.trunc(nextStock)));

    if (clamped === product.stock) {
      return;
    }

    if (!actions?.updateProductStock || product.version < 1) {
      setLocalProducts((current) =>
        current.map((item) =>
          item.id === productId ? { ...item, stock: clamped } : item,
        ),
      );
      setInventoryNotice({
        kind: "success",
        message: `${product.name} 재고를 ${clamped}개로 반영했습니다.`,
      });
      return;
    }

    setInventorySavingIds((current) => new Set(current).add(productId));
    setInventoryNotice(null);

    try {
      const updated = await actions.updateProductStock({
        id: product.id,
        version: product.version,
        stock: clamped,
      });

      setLocalProducts((current) =>
        current.map((item) => (item.id === productId ? updated : item)),
      );
      setInventoryNotice({
        kind: "success",
        message: `${updated.name} 재고를 ${updated.stock}개로 저장했습니다.`,
      });
    } catch {
      setInventoryNotice({
        kind: "error",
        message:
          "재고를 저장하지 못했습니다. 다른 관리자가 먼저 수정했을 수 있어 목록을 다시 불러옵니다.",
      });
      await refreshCatalogProducts();
    } finally {
      setInventorySavingIds((current) => {
        const next = new Set(current);
        next.delete(productId);
        return next;
      });
    }
  };

  const resetProductDraft = () => {
    if (productObjectUrlRef.current) {
      URL.revokeObjectURL(productObjectUrlRef.current);
      productObjectUrlRef.current = null;
    }

    productImageFileRef.current = null;
    setProductDraft(emptyProductDraft);
    setProductNotice(null);
  };

  const handleBrandSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedBrand = brandName.trim();

    if (!normalizedBrand) {
      setBrandNotice({ kind: "error", message: "브랜드명을 입력해 주세요." });
      return;
    }

    if (
      localBrands.some((brand) => brand.toLowerCase() === normalizedBrand.toLowerCase())
    ) {
      setBrandNotice({
        kind: "error",
        message: "이미 이 화면의 브랜드 목록에 있습니다.",
      });
      return;
    }

    const draft: AdminBrandDraft = {
      name: normalizedBrand,
      ...(brandMemo.trim() ? { memo: brandMemo.trim() } : {}),
    };

    try {
      setIsSavingBrand(true);
      await actions?.saveBrandDraft?.(draft);
      setLocalBrands((current) => [...current, normalizedBrand]);
      setBrandNotice({
        kind: "success",
        message: actions?.saveBrandDraft
          ? `“${normalizedBrand}” 브랜드를 관리자 API에 저장했습니다.`
          : `“${normalizedBrand}” 브랜드 초안을 이 화면에 추가했습니다.`,
      });
      setBrandName("");
      setBrandMemo("");
    } catch {
      setBrandNotice({
        kind: "error",
        message:
          "브랜드를 저장하지 못했습니다. 관리자 권한과 네트워크를 확인해 주세요.",
      });
    } finally {
      setIsSavingBrand(false);
    }
  };

  const handleCouponSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (
      !couponName.trim() ||
      !couponCode.trim() ||
      parsePositiveNumber(couponValue) <= 0
    ) {
      setCouponNotice({
        kind: "error",
        message: "쿠폰명, 코드, 혜택 값을 입력해 주세요.",
      });
      return;
    }

    const formattedBenefit =
      couponType === "percent"
        ? `${couponValue}% 할인`
        : `${moneyFormatter.format(parsePositiveNumber(couponValue))} 할인`;
    const draft: AdminCouponDraft = {
      name: couponName.trim(),
      code: couponCode.trim().toUpperCase(),
      discountType: couponType === "percent" ? "PERCENT" : "AMOUNT",
      discountValue: parsePositiveNumber(couponValue),
      ...(couponExpiresAt ? { expiresAt: couponExpiresAt } : {}),
    };

    try {
      setIsSavingCoupon(true);
      await actions?.saveCouponDraft?.(draft);
      setCouponNotice({
        kind: "success",
        message: actions?.saveCouponDraft
          ? `${draft.code} · ${formattedBenefit} 쿠폰 초안을 관리자 API에 저장했습니다.`
          : `${draft.code} · ${formattedBenefit} 쿠폰 초안을 이 화면에 만들었습니다.`,
      });
    } catch {
      setCouponNotice({
        kind: "error",
        message:
          "쿠폰 초안을 저장하지 못했습니다. 입력값과 관리자 API를 확인해 주세요.",
      });
    } finally {
      setIsSavingCoupon(false);
    }
  };

  const handleCampaignSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (
      !campaignTitle.trim() ||
      !campaignBody.trim() ||
      selectedChannelLabels.length === 0
    ) {
      setCampaignNotice({
        kind: "error",
        message: "제목, 내용, 최소 한 개의 발송 채널을 입력해 주세요.",
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

    try {
      setIsSavingCampaign(true);
      await actions?.saveCampaignDraft?.(draft);
      setCampaignNotice({
        kind: "success",
        message: actions?.saveCampaignDraft
          ? `${selectedChannelLabels.join(" · ")} 캠페인 초안을 관리자 API에 저장했습니다. 실제 발송은 수신 동의 검증 후에만 실행됩니다.`
          : `${selectedChannelLabels.join(" · ")} 발송 초안을 이 화면에 준비했습니다.`,
      });
    } catch {
      setCampaignNotice({
        kind: "error",
        message: "캠페인 초안을 저장하지 못했습니다. 관리자 API를 확인해 주세요.",
      });
    } finally {
      setIsSavingCampaign(false);
    }
  };

  /** 회원 개인정보는 자동 렌더링하지 않고 admin이 명시적으로 조회할 때만 API에서 읽습니다. */
  const handleLoadMembers = async () => {
    if (!actions?.listMembers) {
      setMemberNotice({
        kind: "error",
        message: "회원 목록 API가 아직 연결되지 않았습니다.",
      });
      return;
    }

    try {
      setIsLoadingMembers(true);
      setMemberNotice(null);
      const nextMembers = await actions.listMembers();
      setMembers(nextMembers);
      setMemberNotice({
        kind: "success",
        message: `${nextMembers.length}명의 회원을 안전한 관리자 API에서 불러왔습니다.`,
      });
    } catch {
      setMemberNotice({
        kind: "error",
        message: "회원 목록을 불러오지 못했습니다. 관리자 권한과 API를 확인해 주세요.",
      });
    } finally {
      setIsLoadingMembers(false);
    }
  };

  const handleMemberGroupUpdate = async (
    username: string,
    group: "admin" | "support",
    add: boolean,
  ) => {
    if (!actions?.updateMemberGroup) {
      setMemberNotice({
        kind: "error",
        message: "회원 그룹 API가 아직 연결되지 않았습니다.",
      });
      return;
    }

    try {
      await actions.updateMemberGroup({ username, group, add });
      setMemberNotice({
        kind: "success",
        message: `${username} 계정의 ${group} 그룹을 ${add ? "부여" : "해제"}했습니다. 새 권한은 다음 로그인부터 적용됩니다.`,
      });
      await handleLoadMembers();
    } catch {
      setMemberNotice({
        kind: "error",
        message:
          "회원 그룹을 변경하지 못했습니다. 자기 자신의 admin 권한은 이 화면에서 해제할 수 없습니다.",
      });
    }
  };

  const applyOcrJob = (job: AdminOcrRecognitionResult) => {
    ocrCurrentJobRef.current = { jobId: job.jobId, version: job.version };
    setOcrJobId(job.jobId);
    setOcrVersion(job.version);
    setOcrRawText(job.rawText);
    setOcrRows([...job.rows]);
    setOcrState("review");
  };

  const resetOcrReview = () => {
    ocrRequestGenerationRef.current += 1;
    ocrCurrentJobRef.current = null;
    setIsSavingOcr(false);
    setOcrState("idle");
    setOcrJobId(null);
    setOcrVersion(null);
    setOcrRows([]);
    setOcrRawText("");
  };

  const invalidateOcrRequest = () => {
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

  const handleOcrRawTextChange = (value: string) => {
    invalidateOcrRequest();
    setOcrRawText(value);
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
    productName: sourceText,
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
      setOcrNotice({
        kind: "success",
        message: `${result.rows.length}개 행을 인식했습니다. 저장 전에 상품명·옵션·수량을 반드시 검토해 주세요.`,
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

  const createRowsFromRawText = () => {
    const lines = ocrRawText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines.length === 0) {
      setOcrNotice({
        kind: "error",
        message:
          "편집할 OCR 텍스트가 없습니다. 인식 결과를 받거나 텍스트를 붙여넣어 주세요.",
      });
      return;
    }

    if (lines.length > OCR_INPUT_LIMITS.maxReviewRows) {
      setOcrNotice({
        kind: "error",
        message: `한 번에 ${OCR_INPUT_LIMITS.maxReviewRows}개를 초과한 OCR 행은 저장할 수 없습니다. 텍스트를 나눠 검토해 주세요.`,
      });
      return;
    }

    invalidateOcrRequest();
    setOcrRows(lines.map((line) => createOcrRow(line)));
    setOcrState("review");
    setOcrNotice({
      kind: "success",
      message:
        "텍스트를 수정 가능한 입고 행으로 변환했습니다. 각 행을 확인한 뒤 저장해 주세요.",
    });
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
        message: `검토한 입고 행을 관리자 API에 저장했습니다. 서버 버전 ${result.job.version}을 적용했습니다.`,
      });
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

  return (
    <section className={styles.adminPage} aria-label="PARADAYS 관리자 화면">
      <header className={styles.adminHeader}>
        <div>
          <p className={styles.eyebrowMuted}>PARADAYS / ADMIN</p>
          <h1>스토어 운영</h1>
          <p className={styles.adminLead}>
            {adminName}님, 상품이 고객에게 보이는 모습과 운영 데이터를 한 곳에서
            준비하세요.
          </p>
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
            <Link className={styles.homeLink} href="/">
              {copy.adminBackToStore}
            </Link>
            <div className={styles.securityBadge}>
              <span aria-hidden="true">●</span>
              admin 그룹 확인됨
            </div>
          </div>
        </div>
      </header>

      <nav aria-label="관리자 메뉴" className={styles.sidebar}>
        <div className={styles.sidebarIntro}>
          <strong>OPERATIONS</strong>
          <span>권한 기반 관리 화면</span>
        </div>
        {/* fixed 햄버거가 레이아웃에서 빠지므로 자리만 확보 */}
        <div aria-hidden="true" className={styles.opsMenuButtonSlot} />
        <button
          aria-controls="ops-menu-drawer"
          aria-expanded={isOpsMenuOpen}
          className={styles.opsMenuButton}
          onClick={() => setIsOpsMenuOpen((open) => !open)}
          type="button"
        >
          <span className="srOnly">운영 메뉴 {isOpsMenuOpen ? "닫기" : "열기"}</span>
          <span aria-hidden="true" />
          <span aria-hidden="true" />
          <span aria-hidden="true" />
        </button>
      </nav>

      {isOpsMenuOpen ? (
        <button
          aria-label="메뉴 닫기"
          className={styles.opsMenuScrim}
          onClick={() => setIsOpsMenuOpen(false)}
          type="button"
        />
      ) : null}

      <div
        aria-hidden={!isOpsMenuOpen}
        className={
          isOpsMenuOpen
            ? `${styles.opsMenuDrawer} ${styles.opsMenuDrawerOpen}`
            : styles.opsMenuDrawer
        }
        id="ops-menu-drawer"
      >
        <div className={styles.opsMenuDrawerHeader}>
          <strong>OPERATIONS</strong>
          <button
            aria-label="메뉴 닫기"
            className={styles.opsMenuClose}
            onClick={() => setIsOpsMenuOpen(false)}
            type="button"
          >
            ×
          </button>
        </div>
        <div className={styles.tabList} role="tablist" aria-orientation="vertical">
          {sectionItems.map((section) => (
            <button
              aria-controls={`admin-panel-${section.id}`}
              aria-selected={activeSection === section.id}
              className={activeSection === section.id ? styles.tabActive : styles.tab}
              id={`admin-tab-${section.id}`}
              key={section.id}
              onClick={() => selectSection(section.id)}
              onKeyDown={(event) => moveSectionFocus(event, section.id)}
              role="tab"
              tabIndex={isOpsMenuOpen ? undefined : -1}
              type="button"
            >
              <span>{section.label}</span>
              <span aria-hidden="true">→</span>
            </button>
          ))}
        </div>
        <p className={styles.sidebarFootnote}>
          화면 권한은 UX 보호용입니다. 실제 조회·수정 API도 admin 권한을 다시 검증해야
          합니다.
        </p>
      </div>

      <section
        aria-labelledby={`admin-tab-${activeSection}`}
        className={styles.workspace}
        id={`admin-panel-${activeSection}`}
        role="tabpanel"
      >
        {activeSection === "overview" ? (
          <OverviewSection
            loadOverviewMetrics={actions?.loadOverviewMetrics}
            onGoTo={(section) =>
              selectSection(
                section,
                section === "products" ? { productView: "create" } : undefined,
              )
            }
          />
        ) : null}
        {activeSection === "products" ? (
          <ProductSection
            brands={localBrands}
            deleting={isDeletingProducts}
            draft={productDraft}
            loading={isLoadingProducts}
            notice={productNotice}
            onCloseEditor={() => {
              resetProductDraft();
              setProductView("list");
            }}
            onDeleteProducts={(items) => void handleDeleteProducts(items)}
            onEditProduct={(product) => openProductEditor(product, "edit")}
            onImageChange={handleProductImageChange}
            onOpenCreate={() => {
              resetProductDraft();
              setProductNotice(null);
              setProductView("create");
            }}
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
        {activeSection === "inventory" ? (
          <InventorySection
            loading={isLoadingProducts}
            notice={inventoryNotice}
            onChangeStock={(productId, stock) =>
              void handleInventoryStockChange(productId, stock)
            }
            onRefresh={() => {
              setInventoryNotice(null);
              void refreshCatalogProducts();
            }}
            products={localProducts}
            savingIds={inventorySavingIds}
          />
        ) : null}
        {activeSection === "brands" ? (
          <BrandSection
            brandMemo={brandMemo}
            brandName={brandName}
            brands={localBrands}
            notice={brandNotice}
            onMemoChange={setBrandMemo}
            onNameChange={setBrandName}
            onSubmit={(event) => void handleBrandSubmit(event)}
            saving={isSavingBrand}
          />
        ) : null}
        {activeSection === "members" ? (
          <MembersSection
            loading={isLoadingMembers}
            members={members}
            notice={memberNotice}
            onLoad={() => void handleLoadMembers()}
            onUpdateGroup={(username, group, add) =>
              void handleMemberGroupUpdate(username, group, add)
            }
          />
        ) : null}
        {activeSection === "coupons" ? (
          <CouponSection
            couponCode={couponCode}
            couponExpiresAt={couponExpiresAt}
            couponName={couponName}
            couponType={couponType}
            couponValue={couponValue}
            notice={couponNotice}
            onCodeChange={setCouponCode}
            onExpiresAtChange={setCouponExpiresAt}
            onNameChange={setCouponName}
            onSubmit={(event) => void handleCouponSubmit(event)}
            onTypeChange={setCouponType}
            onValueChange={setCouponValue}
            saving={isSavingCoupon}
          />
        ) : null}
        {activeSection === "marketing" ? (
          <MarketingSection
            body={campaignBody}
            channels={campaignChannels}
            notice={campaignNotice}
            onBodyChange={setCampaignBody}
            onChannelChange={(channel, selected) =>
              setCampaignChannels((current) => ({ ...current, [channel]: selected }))
            }
            onSubmit={(event) => void handleCampaignSubmit(event)}
            onTitleChange={setCampaignTitle}
            saving={isSavingCampaign}
            title={campaignTitle}
          />
        ) : null}
        {activeSection === "ocr" ? (
          <OcrSection
            canAddRow={ocrRows.length < OCR_INPUT_LIMITS.maxReviewRows}
            canSave={Boolean(actions?.saveOcrReview && ocrJobId && ocrVersion !== null)}
            file={ocrFile}
            isSaving={isSavingOcr}
            notice={ocrNotice}
            onAddRow={handleAddOcrRow}
            onCreateRowsFromText={createRowsFromRawText}
            onFileChange={handleOcrFileChange}
            onRawTextChange={handleOcrRawTextChange}
            onRecognize={() => void handleRecognize()}
            onRemoveRow={handleRemoveOcrRow}
            onSave={() => void handleOcrSave()}
            onRowChange={updateOcrRow}
            rawText={ocrRawText}
            rows={ocrRows}
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
}: Readonly<{
  loadOverviewMetrics?: () => Promise<AdminOverviewMetrics>;
  onGoTo: (section: AdminSection) => void;
}>) {
  const [metrics, setMetrics] = useState<AdminOverviewMetrics | null>(null);
  const [metricsState, setMetricsState] = useState<"loading" | "ready" | "unavailable">(
    loadOverviewMetrics ? "loading" : "unavailable",
  );

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
        setMetricsState("unavailable");
      });

    return () => {
      isCurrent = false;
    };
  }, [loadOverviewMetrics]);

  const formatCount = (value: number | undefined) =>
    metricsState === "loading" ? "…" : value === undefined ? "—" : String(value);

  return (
    <div className={styles.sectionStack}>
      <SectionHeading
        eyebrow="TODAY"
        mutedEyebrow
        title="운영 현황"
        description={
          metricsState === "ready"
            ? `Asia/Seoul 기준 실시간 집계입니다. 마지막 갱신 ${metrics?.asOf ?? ""}.`
            : "실제 매출·재고·회원 수는 관리자 API가 연결된 뒤에만 표시합니다. 지금은 안전한 운영 흐름을 먼저 준비할 수 있습니다."
        }
      />
      <div className={styles.metricGrid}>
        <MetricCard
          label="오늘 주문"
          value={formatCount(metrics?.todayOrderCount)}
          note={
            metricsState === "ready"
              ? "오늘(KST) 생성된 주문"
              : "주문 API 연결 대기"
          }
        />
        <MetricCard
          label="재고 주의"
          value={formatCount(metrics?.lowStockCount)}
          note={
            metricsState === "ready"
              ? `재고 ${metrics?.lowStockThreshold ?? 5}개 이하 상품`
              : "입고 OCR 저장 후 집계"
          }
        />
        <MetricCard
          label="발급 쿠폰"
          value={formatCount(metrics?.activeCouponCount)}
          note={
            metricsState === "ready" ? "등록된 쿠폰(초안 포함)" : "쿠폰 API 연결 대기"
          }
        />
        <MetricCard
          label="마케팅 대상"
          value={formatCount(metrics?.marketingConsentCount)}
          note={
            metricsState === "ready"
              ? "마케팅 수신 동의 회원"
              : "동의자 기준 서버 산출"
          }
        />
      </div>
      <section className={styles.actionBoard} aria-labelledby="quick-actions-title">
        <div>
          <p className={styles.eyebrow}>QUICK START</p>
          <h2 id="quick-actions-title">다음 운영 작업을 시작하세요</h2>
        </div>
        <div className={styles.quickActions}>
          <QuickAction
            label="상품을 바로 등록"
            note="입력 즉시 스토어 카드로 확인"
            onClick={() => onGoTo("products")}
          />
          <QuickAction
            label="재고 수량 조정"
            note="목록에서 바로 증감·직접 입력"
            onClick={() => onGoTo("inventory")}
          />
          <QuickAction
            label="입고표 OCR 검토"
            note="이미지 인식 → 수정 → 저장"
            onClick={() => onGoTo("ocr")}
          />
          <QuickAction
            label="쿠폰 초안 만들기"
            note="혜택과 유효기간을 먼저 설계"
            onClick={() => onGoTo("coupons")}
          />
        </div>
      </section>
      <section className={styles.safetyNote}>
        <strong>권한과 개인정보 보호</strong>
        <p>
          회원 목록과 수신 동의 정보는 정적 화면에 포함하지 않습니다. 배포된 관리자
          API가 admin 그룹과 동의 상태를 확인한 뒤에만 조회·전송해야 합니다.
        </p>
      </section>
    </div>
  );
}

function ProductSection({
  brands,
  deleting,
  draft,
  loading,
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
  deleting: boolean;
  draft: AdminProductDraft;
  loading: boolean;
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
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [filterQuery, setFilterQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "published" | "draft">(
    "all",
  );
  const [stockFilter, setStockFilter] = useState<"all" | "inStock" | "soldOut">(
    "all",
  );
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
      const next = new Set(
        [...current].filter((productId) => validIds.has(productId)),
      );
      return next.size === current.size ? current : next;
    });
  }, [products]);

  const filteredProducts = useMemo(() => {
    const normalizedQuery = filterQuery.trim().toLowerCase();

    return products.filter((product) => {
      if (statusFilter === "published" && !product.isVisible) {
        return false;
      }

      if (statusFilter === "draft" && product.isVisible) {
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

  const selectedProducts = products.filter((product) =>
    selectedIds.has(product.id),
  );

  if (view === "list") {
    return (
      <div className={styles.sectionStack}>
        <div className={styles.productListHeader}>
          <SectionHeading
            eyebrow="CATALOG"
            title="상품 등록"
            description="등록된 상품을 확인하고, 필요할 때만 + 버튼으로 새 상품을 작성하세요."
          />
          <div className={styles.productListHeaderActions}>
            <button
              aria-label="새 상품 등록"
              className={styles.addProductButton}
              onClick={onOpenCreate}
              type="button"
            >
              +
            </button>
          </div>
        </div>
        {notice ? <NoticeMessage notice={notice} /> : null}
        <div className={styles.productToolbar}>
          <label className={styles.productFilterSearch}>
            <span className={styles.srOnly}>상품 검색</span>
            <input
              onChange={(event) => setFilterQuery(event.target.value)}
              placeholder="상품명 · 브랜드 · 카테고리 검색"
              type="search"
              value={filterQuery}
            />
          </label>
          <label className={styles.productFilterSelect}>
            <span>상태</span>
            <select
              onChange={(event) =>
                setStatusFilter(
                  event.target.value as "all" | "published" | "draft",
                )
              }
              value={statusFilter}
            >
              <option value="all">전체</option>
              <option value="published">공개</option>
              <option value="draft">초안</option>
            </select>
          </label>
          <label className={styles.productFilterSelect}>
            <span>재고</span>
            <select
              onChange={(event) =>
                setStockFilter(
                  event.target.value as "all" | "inStock" | "soldOut",
                )
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
            className={styles.productSelectAllHit}
            onClick={toggleSelectAllFiltered}
            type="button"
          >
            <span
              aria-checked={allFilteredSelected}
              className={styles.productCheckbox}
              role="checkbox"
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
              ? "아직 등록된 상품이 없습니다. + 버튼으로 첫 상품을 추가하세요."
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
                    onPointerDown={(event) =>
                      handleSelectPointerDown(product.id, event)
                    }
                    onPointerEnter={() => handleSelectPointerEnter(product.id)}
                    type="button"
                  >
                    <span
                      aria-checked={isSelected}
                      className={styles.productCheckbox}
                      role="checkbox"
                    />
                  </button>
                  <div className={styles.productListMain}>
                    <strong>{product.name}</strong>
                    <span>
                      {product.brand} · {product.category}
                    </span>
                  </div>
                  <span className={styles.productStock}>
                    재고 {product.stock}
                    {product.stock <= 0 ? (
                      <em className={styles.productSoldOutBadge}>soldout</em>
                    ) : null}
                  </span>
                  <span>{moneyFormatter.format(product.price)}</span>
                  <span
                    className={
                      product.isVisible ? styles.publicStatus : styles.draftStatus
                    }
                  >
                    {product.isVisible ? "공개" : "초안"}
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
                        onDeleteProducts([
                          { id: product.id, version: product.version },
                        ])
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

  const editorTitle = view === "edit" ? "상품 수정" : "상품 등록";

  return (
    <div className={styles.sectionStack}>
      <div className={styles.productEditorToolbar}>
        <button
          className={styles.backToListButton}
          onClick={onCloseEditor}
          type="button"
        >
          ← 목록으로
        </button>
      </div>
      <SectionHeading
        eyebrow="CATALOG"
        title={editorTitle}
        description={
          view === "edit"
            ? "등록과 같은 화면에서 상품 정보를 수정하고, 저장 전 고객용 미리보기를 확인하세요."
            : "엑셀 대신 필요한 정보를 하나씩 입력하고, 저장 전 고객용 상품상세가 어떻게 보이는지 바로 확인하세요."
        }
      />
      <div className={styles.productEditor}>
        <form className={styles.editorForm} noValidate onSubmit={onSave}>
          <fieldset className={styles.formGroup}>
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
              <span>브랜드</span>
              <input
                list="admin-brand-options"
                onChange={(event) => onTextChange("brand", event.target.value)}
                placeholder="브랜드 입력 또는 선택"
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
                <option>Deck</option>
                <option>Complete</option>
                <option>Trucks</option>
                <option>Wheels</option>
                <option>Bearings</option>
                <option>Top</option>
                <option>Bottom</option>
                <option>Accessories</option>
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

          <fieldset className={styles.formGroup}>
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
              <small>쉼표로 구분하면 상품상세 Size 버튼으로 보입니다.</small>
            </label>
            <label className={styles.fieldWide}>
              <span>상품 설명</span>
              <textarea
                onChange={(event) => onTextChange("description", event.target.value)}
                placeholder={"Heavy Flannel Weave\nDual Chest Pockets\nButton Front Closure"}
                rows={4}
                value={draft.description}
              />
              <small>줄바꿈마다 상품상세 스펙 목록(■)으로 표시됩니다.</small>
            </label>
          </fieldset>

          <fieldset className={styles.formGroup}>
            <legend>이미지와 노출</legend>
            <label className={styles.uploadField}>
              <span>대표 이미지</span>
              <input accept="image/*" onChange={onImageChange} type="file" />
              <small>
                JPEG/PNG/WebP/GIF · 최대 6MB. 저장 시 S3 저장소로 업로드됩니다.
              </small>
            </label>
            <div className={styles.toggleRows}>
              <label className={styles.checkRow}>
                <input
                  checked={draft.isVisible}
                  onChange={(event) =>
                    onToggleChange("isVisible", event.target.checked)
                  }
                  type="checkbox"
                />
                <span>검토 후 스토어에 바로 공개</span>
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
          </fieldset>

          {notice ? <NoticeMessage notice={notice} /> : null}
          <div className={styles.formActions}>
            <button className={styles.secondaryButton} onClick={onReset} type="button">
              {view === "edit" ? "입력 초기화" : "새 초안"}
            </button>
            <button className={styles.primaryButton} disabled={saving} type="submit">
              {saving
                ? "저장 중…"
                : view === "edit"
                  ? "수정 저장"
                  : "상품 저장"}
            </button>
          </div>
        </form>

        <aside className={styles.previewPanel} aria-label="스토어 카드 미리보기">
          <div className={styles.previewHeader}>
            <div>
              <p className={styles.eyebrow}>LIVE PREVIEW</p>
              <h2>스토어 카드</h2>
            </div>
            <span>상품상세와 동일</span>
          </div>
          <article className={styles.storeCardPreview}>
            <div className={styles.storeCardDetail}>
              <div className={styles.storeCardInfo}>
                <h3>{previewName}</h3>
                {previewDescriptionLines.length > 0 ? (
                  <ul className={styles.storeCardDescription}>
                    {previewDescriptionLines.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                ) : (
                  <p className={styles.previewHint}>
                    상품 설명을 줄바꿈으로 입력하면 스펙 목록으로 표시됩니다.
                  </p>
                )}

                <div className={styles.storeCardOptions}>
                  <fieldset>
                    <legend>Qty:</legend>
                    <div className={styles.storeCardQuantity} aria-hidden="true">
                      <span>−</span>
                      <span>1</span>
                      <span>+</span>
                    </div>
                  </fieldset>
                  <fieldset>
                    <legend>Size</legend>
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
                      <span className={styles.previewHint}>
                        사이즈를 입력하면 여기에 표시됩니다.
                      </span>
                    )}
                  </fieldset>
                </div>

                <div className={styles.storeCardAddButton} aria-hidden="true">
                  <span>
                    {previewPrice > 0
                      ? moneyFormatter.format(previewPrice)
                      : "판매가 입력"}
                    {previewCompareAtPrice > previewPrice && previewPrice > 0 ? (
                      <s>{moneyFormatter.format(previewCompareAtPrice)}</s>
                    ) : null}
                  </span>
                  <span>＋</span>
                </div>
              </div>

              <div className={styles.storeCardMedia}>
                {draft.isFeatured ? (
                  <span className={styles.newBadge}>NEW</span>
                ) : null}
                {/* 파일 선택으로 생긴 blob URL은 정적 export의 이미지 최적화 경로를 거치지 않습니다. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img alt={`${previewName} 상품 이미지 미리보기`} src={draft.imageUrl} />
                <span className={styles.storeCardArrowPrev} aria-hidden="true">
                  ‹
                </span>
                <span className={styles.storeCardArrowNext} aria-hidden="true">
                  ›
                </span>
              </div>
            </div>
            <footer>
              <span>{draft.category}</span>
              <span
                className={draft.isVisible ? styles.publicStatus : styles.draftStatus}
              >
                {draft.isVisible ? "스토어 공개" : "비공개 초안"}
              </span>
            </footer>
          </article>
          <p className={styles.previewNote}>
            미리보기는 고객용 상품상세(좌측 정보·우측 이미지)와 같은 구성입니다. 실제
            게시는 서버 저장과 공개 검토 후에만 이루어집니다.
          </p>
        </aside>
      </div>
    </div>
  );
}

function InventorySection({
  loading,
  notice,
  onChangeStock,
  onRefresh,
  products,
  savingIds,
}: Readonly<{
  loading: boolean;
  notice: Notice;
  onChangeStock: (productId: string, stock: number) => void;
  onRefresh: () => void;
  products: readonly AdminCatalogListItem[];
  savingIds: ReadonlySet<string>;
}>) {
  const [filterQuery, setFilterQuery] = useState("");
  const [stockFilter, setStockFilter] = useState<"all" | "inStock" | "low" | "soldOut">(
    "all",
  );

  const filteredProducts = useMemo(() => {
    const query = filterQuery.trim().toLowerCase();

    return products
      .filter((product) => {
        if (query) {
          const haystack = `${product.name} ${product.brand} ${product.sku ?? ""} ${product.category}`.toLowerCase();
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
    <div className={styles.sectionStack}>
      <SectionHeading
        eyebrow="INVENTORY"
        title="재고 수정"
        description="상품 재고를 한눈에 보고, 화살표로 한 개씩 조정하거나 숫자를 직접 입력해 저장합니다."
      />

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
          onClick={onRefresh}
          type="button"
        >
          새로고침
        </button>
      </div>

      {notice ? <NoticeMessage notice={notice} /> : null}

      <div className={styles.inventoryPanel}>
        <div className={styles.listPanelHeading}>
          <h2>상품 재고 목록</h2>
          <span>{filteredProducts.length}</span>
        </div>

        {loading && products.length === 0 ? (
          <p className={styles.emptyState}>재고 목록을 불러오는 중…</p>
        ) : null}

        {!loading && filteredProducts.length === 0 ? (
          <div className={styles.emptyState}>
            <strong>표시할 상품이 없습니다</strong>
            <p>상품 등록에서 상품을 추가하거나 검색 조건을 바꿔 보세요.</p>
          </div>
        ) : null}

        {filteredProducts.length > 0 ? (
          <ul className={styles.inventoryList}>
            {filteredProducts.map((product) => {
              const isSaving = savingIds.has(product.id);
              const stockTone =
                product.stock <= 0
                  ? styles.inventorySoldOut
                  : product.stock <= 5
                    ? styles.inventoryLow
                    : undefined;

              return (
                <li className={styles.inventoryRow} key={product.id}>
                  <div className={styles.inventoryMeta}>
                    <strong>{product.name}</strong>
                    <span>
                      {product.brand} · {product.category}
                      {product.sku ? ` · ${product.sku}` : ""}
                    </span>
                    <span className={stockTone}>
                      {product.isVisible ? "공개" : "초안"}
                      {product.stock <= 0
                        ? " · 품절"
                        : product.stock <= 5
                          ? " · 재고 주의"
                          : ""}
                    </span>
                  </div>
                  <StockStepper
                    disabled={isSaving}
                    onCommit={(stock) => onChangeStock(product.id, stock)}
                    value={product.stock}
                  />
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

function StockStepper({
  disabled = false,
  onCommit,
  value,
}: Readonly<{
  disabled?: boolean;
  onCommit: (stock: number) => void;
  value: number;
}>) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const commitDraft = () => {
    const parsed = Number.parseInt(draft.replace(/[^\d]/g, ""), 10);

    if (!Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }

    const clamped = Math.max(0, Math.min(1_000_000, parsed));
    setDraft(String(clamped));

    if (clamped !== value) {
      onCommit(clamped);
    }
  };

  return (
    <div className={styles.stockStepper} aria-label="재고 수량 조정">
      <button
        aria-label="재고 1개 감소"
        className={styles.stockStepButton}
        disabled={disabled || value <= 0}
        onClick={() => onCommit(Math.max(0, value - 1))}
        type="button"
      >
        ←
      </button>
      <input
        aria-label="재고 수량"
        className={styles.stockStepInput}
        disabled={disabled}
        inputMode="numeric"
        onBlur={commitDraft}
        onChange={(event) => setDraft(event.target.value.replace(/[^\d]/g, ""))}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commitDraft();
            event.currentTarget.blur();
          }
        }}
        value={draft}
      />
      <button
        aria-label="재고 1개 증가"
        className={styles.stockStepButton}
        disabled={disabled || value >= 1_000_000}
        onClick={() => onCommit(Math.min(1_000_000, value + 1))}
        type="button"
      >
        →
      </button>
    </div>
  );
}

function BrandSection({
  brandMemo,
  brandName,
  brands,
  notice,
  onMemoChange,
  onNameChange,
  onSubmit,
  saving,
}: Readonly<{
  brandMemo: string;
  brandName: string;
  brands: readonly string[];
  notice: Notice;
  onMemoChange: (value: string) => void;
  onNameChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  saving: boolean;
}>) {
  return (
    <div className={styles.sectionStack}>
      <SectionHeading
        eyebrow="BRANDS"
        title="브랜드 추가"
        description="상품 입력과 연결되는 브랜드명을 먼저 정리하세요. 실제 공개 브랜드 목록은 관리자 API 저장 후에 반영됩니다."
      />
      <div className={styles.twoColumnBoard}>
        <form className={styles.compactForm} noValidate onSubmit={onSubmit}>
          <label>
            <span>브랜드명</span>
            <input
              onChange={(event) => onNameChange(event.target.value)}
              placeholder="예: April"
              value={brandName}
            />
          </label>
          <label>
            <span>운영 메모 (선택)</span>
            <textarea
              onChange={(event) => onMemoChange(event.target.value)}
              placeholder="공급처, 담당자, 노출 유의사항 등"
              rows={5}
              value={brandMemo}
            />
          </label>
          {notice ? <NoticeMessage notice={notice} /> : null}
          <button className={styles.primaryButton} disabled={saving} type="submit">
            {saving ? "저장 중…" : "브랜드 초안 추가"}
          </button>
        </form>
        <section className={styles.listPanel} aria-labelledby="brand-draft-list-title">
          <div className={styles.listPanelHeading}>
            <h2 id="brand-draft-list-title">이 화면의 브랜드 초안</h2>
            <span>{brands.length}</span>
          </div>
          {brands.length === 0 ? (
            <EmptyState
              title="아직 추가한 브랜드가 없습니다"
              description="왼쪽에서 브랜드를 추가하면 상품 입력 칸에서 바로 선택할 수 있습니다."
            />
          ) : (
            <ul className={styles.brandList}>
              {brands.map((brand) => (
                <li key={brand}>
                  <strong>{brand}</strong>
                  <span>저장 대기</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

function MembersSection({
  loading,
  members,
  notice,
  onLoad,
  onUpdateGroup,
}: Readonly<{
  loading: boolean;
  members: readonly AdminMember[];
  notice: Notice;
  onLoad: () => void;
  onUpdateGroup: (username: string, group: "admin" | "support", add: boolean) => void;
}>) {
  return (
    <div className={styles.sectionStack}>
      <SectionHeading
        eyebrow="MEMBERS"
        title="회원 관리"
        description="회원 정보는 정적 페이지에 미리 싣지 않습니다. 인증된 관리자 API에서만 필요한 최소 계정 정보와 운영 권한을 조회합니다."
      />
      <section className={styles.memberShell} aria-labelledby="member-api-title">
        <div className={styles.memberIllustration} aria-hidden="true">
          <span>01</span>
          <span>02</span>
          <span>03</span>
        </div>
        <div>
          <p className={styles.eyebrow}>PROTECTED DATA</p>
          <h2 id="member-api-title">필요할 때만 회원 목록 조회</h2>
          <p>
            이메일·구매 이력 등 개인정보는 브라우저에 하드코딩하지 않습니다. 백엔드에서
            admin 그룹을 다시 검증한 뒤 회원 식별·상태·운영 권한에 필요한 최소 정보만
            조회합니다.
          </p>
          <div className={styles.memberCapabilities}>
            <span>회원 목록 조회</span>
            <span>계정 상태 확인</span>
            <span>admin · support 권한 관리</span>
          </div>
          <button
            className={styles.memberLoadButton}
            disabled={loading}
            onClick={onLoad}
            type="button"
          >
            {loading ? "회원 목록 불러오는 중…" : "회원 목록 불러오기"}
          </button>
        </div>
      </section>
      {notice ? <NoticeMessage notice={notice} /> : null}
      {members.length > 0 ? (
        <section
          className={styles.memberTablePanel}
          aria-labelledby="member-table-title"
        >
          <div className={styles.listPanelHeading}>
            <h2 id="member-table-title">회원 및 운영 권한</h2>
            <span>{members.length}</span>
          </div>
          <div className={styles.memberTableWrap}>
            <table className={styles.memberTable}>
              <caption className="srOnly">관리자 API에서 불러온 회원 목록</caption>
              <thead>
                <tr>
                  <th scope="col">회원</th>
                  <th scope="col">상태</th>
                  <th scope="col">운영 그룹</th>
                  <th scope="col">권한 변경</th>
                </tr>
              </thead>
              <tbody>
                {members.map((member) => {
                  const label = member.displayName ?? member.email ?? member.username;
                  const isAdmin = member.groups.includes("admin");
                  const isSupport = member.groups.includes("support");

                  return (
                    <tr key={member.username}>
                      <td>
                        <strong>{label}</strong>
                        {member.email && member.email !== label ? (
                          <span>{member.email}</span>
                        ) : null}
                      </td>
                      <td>{member.enabled ? "활성" : "비활성"}</td>
                      <td>
                        {member.groups.length ? member.groups.join(", ") : "일반 회원"}
                      </td>
                      <td>
                        <div className={styles.memberActions}>
                          <button
                            onClick={() =>
                              onUpdateGroup(member.username, "support", !isSupport)
                            }
                            type="button"
                          >
                            {isSupport ? "support 해제" : "support 부여"}
                          </button>
                          <button
                            onClick={() =>
                              onUpdateGroup(member.username, "admin", !isAdmin)
                            }
                            type="button"
                          >
                            {isAdmin ? "admin 해제" : "admin 부여"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}

function CouponSection({
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
  const benefitPreview =
    couponType === "percent"
      ? couponValue
        ? `${couponValue}%`
        : "할인율"
      : couponValue
        ? moneyFormatter.format(parsePositiveNumber(couponValue))
        : "할인 금액";

  return (
    <div className={styles.sectionStack}>
      <SectionHeading
        eyebrow="COUPONS"
        title="쿠폰 발급"
        description="조건과 혜택을 직관적으로 설계하고, 실제 발급 전 고객 노출 문구를 확인하세요."
      />
      <div className={styles.twoColumnBoard}>
        <form className={styles.compactForm} noValidate onSubmit={onSubmit}>
          <label>
            <span>쿠폰명</span>
            <input
              onChange={(event) => onNameChange(event.target.value)}
              placeholder="첫 구매 웰컴 쿠폰"
              value={couponName}
            />
          </label>
          <label>
            <span>쿠폰 코드</span>
            <input
              onChange={(event) => onCodeChange(event.target.value.toUpperCase())}
              placeholder="WELCOME10"
              value={couponCode}
            />
          </label>
          <div className={styles.inlineFields}>
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
              <span>혜택 값</span>
              <input
                inputMode="numeric"
                min="0"
                onChange={(event) => onValueChange(event.target.value)}
                placeholder={couponType === "percent" ? "10" : "5000"}
                type="number"
                value={couponValue}
              />
            </label>
          </div>
          <label>
            <span>유효 기간 (선택)</span>
            <input
              onChange={(event) => onExpiresAtChange(event.target.value)}
              type="date"
              value={couponExpiresAt}
            />
          </label>
          {notice ? <NoticeMessage notice={notice} /> : null}
          <button className={styles.primaryButton} disabled={saving} type="submit">
            {saving ? "저장 중…" : "쿠폰 초안 만들기"}
          </button>
        </form>
        <aside className={styles.couponPreview} aria-label="쿠폰 고객 노출 미리보기">
          <p className={styles.eyebrow}>CUSTOMER PREVIEW</p>
          <div className={styles.ticket}>
            <span>PARADAYS</span>
            <strong>{benefitPreview}</strong>
            <p>{couponName.trim() || "쿠폰명을 입력하세요"}</p>
            <code>{couponCode.trim() || "COUPON CODE"}</code>
            <small>
              {couponExpiresAt ? `${couponExpiresAt}까지 사용 가능` : "유효기간 미설정"}
            </small>
          </div>
          <p className={styles.previewNote}>
            발급 대상·중복 사용·최소 구매금액은 서버 정책에서 최종 검증해야 합니다.
          </p>
        </aside>
      </div>
    </div>
  );
}

function MarketingSection({
  body,
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
  channels: Record<MarketingChannel, boolean>;
  notice: Notice;
  onBodyChange: (value: string) => void;
  onChannelChange: (channel: MarketingChannel, selected: boolean) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onTitleChange: (value: string) => void;
  title: string;
  saving: boolean;
}>) {
  return (
    <div className={styles.sectionStack}>
      <SectionHeading
        eyebrow="MARKETING"
        title="이메일 · SMS · 푸시"
        description="동의한 고객에게만 보낼 캠페인을 작성하세요. 실제 수신 대상 계산과 발송은 백엔드 동의 검증을 통과해야 합니다."
      />
      <div className={styles.marketingLayout}>
        <form className={styles.marketingForm} noValidate onSubmit={onSubmit}>
          <fieldset className={styles.channelFieldset}>
            <legend>발송 채널</legend>
            <div className={styles.channelChoices}>
              {(["email", "sms", "push"] as const).map((channel) => (
                <label className={styles.channelChoice} key={channel}>
                  <input
                    checked={channels[channel]}
                    onChange={(event) => onChannelChange(channel, event.target.checked)}
                    type="checkbox"
                  />
                  <span>{channelLabel(channel)}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <label>
            <span>캠페인 제목</span>
            <input
              onChange={(event) => onTitleChange(event.target.value)}
              placeholder="이번 주 신상품을 확인하세요"
              value={title}
            />
          </label>
          <label>
            <span>메시지</span>
            <textarea
              maxLength={500}
              onChange={(event) => onBodyChange(event.target.value)}
              placeholder="고객에게 전달할 혜택과 링크 안내를 작성하세요."
              rows={8}
              value={body}
            />
            <small>{body.length}/500</small>
          </label>
          <div className={styles.consentCallout}>
            <strong>수신 동의자만</strong>
            <span>채널별 동의, 철회 이력, 발송 제한을 서버에서 확인합니다.</span>
          </div>
          {notice ? <NoticeMessage notice={notice} /> : null}
          <button className={styles.primaryButton} disabled={saving} type="submit">
            {saving ? "저장 중…" : "발송 초안 준비"}
          </button>
        </form>
        <aside className={styles.phonePreview} aria-label="모바일 메시지 미리보기">
          <p className={styles.eyebrow}>MESSAGE PREVIEW</p>
          <div className={styles.phoneFrame}>
            <div className={styles.phoneTop}>PARADAYS</div>
            <div className={styles.messageBubble}>
              <strong>{title.trim() || "캠페인 제목"}</strong>
              <p>
                {body.trim() ||
                  "메시지를 입력하면 고객이 받게 될 문구를 이곳에서 확인할 수 있습니다."}
              </p>
            </div>
            <small>전송 전 수신 동의와 발송 정책을 확인합니다.</small>
          </div>
        </aside>
      </div>
    </div>
  );
}

function OcrSection({
  canAddRow,
  canSave,
  file,
  isSaving,
  notice,
  onAddRow,
  onCreateRowsFromText,
  onFileChange,
  onRawTextChange,
  onRecognize,
  onRemoveRow,
  onRowChange,
  onSave,
  rawText,
  rows,
  state,
}: Readonly<{
  canAddRow: boolean;
  canSave: boolean;
  file: File | null;
  isSaving: boolean;
  notice: Notice;
  onAddRow: () => void;
  onCreateRowsFromText: () => void;
  onFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onRawTextChange: (value: string) => void;
  onRecognize: () => void;
  onRemoveRow: (id: string) => void;
  onRowChange: (
    id: string,
    field: Exclude<keyof AdminOcrReviewRow, "id">,
    value: string,
  ) => void;
  onSave: () => void;
  rawText: string;
  rows: readonly AdminOcrReviewRow[];
  state: OcrState;
}>) {
  const { locale } = useLocale();
  const localOcr = useSyncExternalStore(
    subscribeToLocalOcrMode,
    isLocalOcrDevelopmentMode,
    serverLocalOcrMode,
  );
  const statusLabel =
    state === "recognizing"
      ? "인식 중"
      : state === "review"
        ? "검토 필요"
        : state === "connection-needed"
          ? "API 연결 필요"
          : "파일 선택";

  return (
    <div className={styles.sectionStack}>
      <SectionHeading
        eyebrow="INBOUND OCR"
        title="입고 목록 OCR"
        description={localOcr
          ? locale === "ko"
            ? "현재 컴퓨터의 PaddleOCR로 이미지를 인식하고 텍스트 검토본을 로컬에 저장합니다."
            : "Recognize images with PaddleOCR on this computer and save the text review locally."
          : "입고표 캡처 이미지를 관리자 API로 보내고, 인식 텍스트를 수정한 뒤 재고 초안으로 저장하는 흐름입니다."}
      />
      {localOcr ? (
        <div className={styles.ocrSecurity} role="note" aria-label={locale === "ko" ? "로컬 OCR 테스트" : "Local OCR test"}>
          <strong>{locale === "ko" ? "로컬 OCR 테스트" : "Local OCR test"}</strong>
          <p>{locale === "ko"
            ? "검토본만 현재 컴퓨터의 메모리에 저장하며 서버 재시작 시 삭제됩니다. 상품·재고·AWS에는 저장하지 않습니다. CPU 인식은 최대 2분 걸릴 수 있습니다."
            : "Only text reviews are stored in this computer’s memory and are deleted when the server restarts. This does not save products, inventory, or AWS data. CPU recognition may take up to 2 minutes."}</p>
        </div>
      ) : null}
      <ol className={styles.ocrSteps} aria-label="OCR 등록 흐름">
        <li className={file ? styles.stepDone : undefined}>
          <span>1</span>이미지 선택
        </li>
        <li className={state === "review" ? styles.stepDone : undefined}>
          <span>2</span>OCR 인식
        </li>
        <li className={rows.length > 0 ? styles.stepDone : undefined}>
          <span>3</span>텍스트 수정
        </li>
        <li>
          <span>4</span>저장
        </li>
      </ol>
      <section className={styles.ocrIntake}>
        <div className={styles.ocrUpload}>
          <p className={styles.eyebrow}>SOURCE IMAGE</p>
          <h2>입고 목록 캡처</h2>
          <p>
            표 전체가 보이도록 촬영한 PNG, JPG, WEBP 파일을 선택하세요. 현재 직접 OCR은
            4MiB 이하만 전송합니다.
          </p>
          <label className={styles.filePicker}>
            <span>{file ? file.name : "이미지 파일 선택"}</span>
            <input
              accept="image/png,image/jpeg,image/webp"
              onChange={onFileChange}
              type="file"
            />
          </label>
          <button
            className={styles.primaryButton}
            disabled={!file || state === "recognizing"}
            onClick={onRecognize}
            type="button"
          >
            {state === "recognizing" ? "OCR 인식 중…" : "OCR로 텍스트 추출"}
          </button>
          <span className={styles.ocrState} data-state={state}>
            {statusLabel}
          </span>
        </div>
        <div className={styles.ocrSecurity}>
          <strong>안전한 처리 경로</strong>
          <p>
            {localOcr ? (locale === "ko"
              ? "이미지는 이 컴퓨터의 로컬 중계 서버로만 전송하며 저장하지 않습니다. PaddleOCR 공유 비밀값은 로컬 서버에만 보관합니다."
              : "Images are sent only to this computer’s local relay and are not stored. The PaddleOCR shared secret stays on the local server.") : <>브라우저는 이미지를 관리자 API에만 전달합니다. PaddleOCR 주소·공유 비밀값은
            AWS Secrets Manager <code>paradays-dev/paddle-ocr</code>에만 두고,
            브라우저·NEXT_PUBLIC 환경변수에는 넣지 마세요.</>}
          </p>
          <p>
            현재 직접 OCR은 4MiB 이하 PNG·JPEG·WEBP만 전송합니다. 4~6MiB는 private S3
            경로 배포 전이라 더 작은 파일로 다시 선택해 주세요.
          </p>
        </div>
      </section>

      {notice ? <NoticeMessage notice={notice} /> : null}

      <div className={styles.ocrReviewLayout}>
        <section className={styles.rawTextPanel} aria-labelledby="ocr-text-title">
          <div className={styles.panelTitleRow}>
            <div>
              <p className={styles.eyebrow}>OCR OUTPUT</p>
              <h2 id="ocr-text-title">인식 텍스트</h2>
            </div>
            <button
              className={styles.textButton}
              onClick={onCreateRowsFromText}
              type="button"
            >
              편집 행으로 변환
            </button>
          </div>
          <textarea
            aria-label="OCR 원문 텍스트"
            aria-describedby="ocr-raw-text-limit"
            maxLength={OCR_INPUT_LIMITS.maxRawTextLength}
            onChange={(event) => onRawTextChange(event.target.value)}
            placeholder="OCR 결과가 이곳에 표시됩니다. 필요하면 직접 붙여넣고 수정할 수도 있습니다."
            rows={15}
            value={rawText}
          />
          <p id="ocr-raw-text-limit">
            원문은 최대 {OCR_INPUT_LIMITS.maxRawTextLength.toLocaleString("ko-KR")}자까지
            입력할 수 있습니다. 한 줄씩 행으로 변환한 뒤 오른쪽에서 상품명, 옵션, 수량을
            수정합니다.
          </p>
        </section>
        <section className={styles.ocrRowsPanel} aria-labelledby="ocr-review-title">
          <div className={styles.panelTitleRow}>
            <div>
              <p className={styles.eyebrow}>HUMAN REVIEW</p>
              <h2 id="ocr-review-title">수정 후 저장</h2>
            </div>
            <button
              className={styles.textButton}
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
              description="OCR 인식을 실행하거나 왼쪽 텍스트를 행으로 변환해 주세요."
            />
          ) : (
            <div className={styles.ocrTableWrap}>
              <table className={styles.ocrTable}>
                <caption className="srOnly">OCR 인식 결과 수정 표</caption>
                <thead>
                  <tr>
                    <th scope="col">원문</th>
                    <th scope="col">신뢰도</th>
                    <th scope="col">좌표</th>
                    <th scope="col">상품명</th>
                    <th scope="col">브랜드</th>
                    <th scope="col">옵션</th>
                    <th scope="col">수량</th>
                    <th scope="col">
                      <span className="srOnly">삭제</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <input
                          aria-label="OCR 원문"
                          aria-describedby="ocr-row-edit-limits"
                          maxLength={OCR_INPUT_LIMITS.maxSourceTextLength}
                          onChange={(event) =>
                            onRowChange(row.id, "sourceText", event.target.value)
                          }
                          value={row.sourceText}
                        />
                      </td>
                      <td className={styles.ocrMetadataCell}>
                        {formatOcrConfidence(row.confidence)}
                      </td>
                      <td className={styles.ocrMetadataCell}>
                        {formatOcrBoundingBox(row.box)}
                      </td>
                      <td>
                        <input
                          aria-label="상품명"
                          aria-describedby="ocr-row-edit-limits"
                          maxLength={OCR_INPUT_LIMITS.maxProductNameLength}
                          onChange={(event) =>
                            onRowChange(row.id, "productName", event.target.value)
                          }
                          value={row.productName}
                        />
                      </td>
                      <td>
                        <input
                          aria-label="브랜드"
                          aria-describedby="ocr-row-edit-limits"
                          maxLength={OCR_INPUT_LIMITS.maxBrandLength}
                          onChange={(event) =>
                            onRowChange(row.id, "brand", event.target.value)
                          }
                          value={row.brand}
                        />
                      </td>
                      <td>
                        <input
                          aria-label="옵션"
                          aria-describedby="ocr-row-edit-limits"
                          maxLength={OCR_INPUT_LIMITS.maxOptionLength}
                          onChange={(event) =>
                            onRowChange(row.id, "option", event.target.value)
                          }
                          value={row.option}
                        />
                      </td>
                      <td>
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
                      </td>
                      <td>
                        <button
                          aria-label="입고 행 삭제"
                          className={styles.removeRowButton}
                          onClick={() => onRemoveRow(row.id)}
                          type="button"
                        >
                          ×
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className={styles.ocrEditLimits} id="ocr-row-edit-limits">
            원문 {OCR_INPUT_LIMITS.maxSourceTextLength.toLocaleString("ko-KR")}자, 상품명
            {OCR_INPUT_LIMITS.maxProductNameLength}자, 브랜드 {OCR_INPUT_LIMITS.maxBrandLength}자,
            옵션 {OCR_INPUT_LIMITS.maxOptionLength}자까지 입력할 수 있습니다. 검토 행은 최대
            {OCR_INPUT_LIMITS.maxReviewRows}개이며, 수량은 비우거나 0~999,999,999 정수만
            허용됩니다.
          </p>
          <div className={styles.ocrSaveBar}>
            <span>
              자동 인식 결과는 항상 운영자가 수정·확인한 뒤 저장합니다. 신뢰도와 좌표는
              읽기 전용 provider metadata입니다.
            </span>
            <button
              className={styles.primaryButton}
              disabled={!canSave || isSaving || rows.length === 0}
              onClick={onSave}
              type="button"
            >
              {isSaving ? "저장 중…" : "검토 초안 저장"}
            </button>
          </div>
        </section>
      </div>
    </div>
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

function SectionHeading({
  description,
  eyebrow,
  mutedEyebrow = false,
  title,
}: Readonly<{
  description: string;
  eyebrow: string;
  mutedEyebrow?: boolean;
  title: string;
}>) {
  return (
    <header className={styles.sectionHeading}>
      <p className={mutedEyebrow ? styles.eyebrowMuted : styles.eyebrow}>{eyebrow}</p>
      <h2>{title}</h2>
      <p>{description}</p>
    </header>
  );
}

function MetricCard({
  label,
  note,
  value,
}: Readonly<{ label: string; note: string; value: string }>) {
  return (
    <article className={styles.metricCard}>
      <p>{label}</p>
      <strong>{value}</strong>
      <span>{note}</span>
    </article>
  );
}

function QuickAction({
  label,
  note,
  onClick,
}: Readonly<{ label: string; note: string; onClick: () => void }>) {
  return (
    <button className={styles.quickAction} onClick={onClick} type="button">
      <strong>{label}</strong>
      <span>{note}</span>
      <i aria-hidden="true">→</i>
    </button>
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
