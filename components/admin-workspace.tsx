"use client";
import { useAuth } from "@/contexts/auth-context";
import { useLocale } from "@/contexts/locale-context";
import { useHeaderScroll } from "@/hooks/use-header-scroll";
import {
  getAdminSectionSnapshot,
  getServerAdminSectionSnapshot,
  navigateToAdminSection,
  subscribeToAdminSection,
  type AdminSection,
} from "@/lib/admin-ui/navigation";
import {
  getAdminStoreResumeSnapshot,
  getServerAdminStoreReturnSnapshot,
} from "@/lib/admin-ui/store-return";
import type { AdminDashboardActions } from "@/lib/admin-ui/types";
import type { Locale } from "@/types/store";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from "react";
import {
  getDesktopAdminSnapshot,
  getServerDesktopAdminSnapshot,
  sectionItems,
  subscribeToAdminViewport,
} from "./admin-navigation";
import {
  channelLabel,
  LocalizedText,
  MarketingChannel,
  OperationActivity,
  operationEventTime,
  parsePositiveNumber,
} from "./admin-shared";
import { useAdminBrandDraft } from "./admin-use-brand-draft";
import { useAdminBrandState } from "./admin-use-brand-state";
import { useAdminCampaignDraft } from "./admin-use-campaign-draft";
import { useAdminCampaignSubmit } from "./admin-use-campaign-submit";
import { useAdminCatalog } from "./admin-use-catalog";
import { useAdminCouponDraft } from "./admin-use-coupon-draft";
import { useAdminCouponSubmit } from "./admin-use-coupon-submit";
import { useAdminInventory } from "./admin-use-inventory";
import { useAdminInventoryState } from "./admin-use-inventory-state";
import { useAdminMembers } from "./admin-use-members";
import { useAdminMembersState } from "./admin-use-members-state";
import { useAdminOcrInput } from "./admin-use-ocr-input";
import { useAdminOcrRecognition } from "./admin-use-ocr-recognition";
import { useAdminOcrReview } from "./admin-use-ocr-review";
import { useAdminOcrReviewState } from "./admin-use-ocr-review-state";
import { useAdminProductDelete } from "./admin-use-product-delete";
import { useAdminProductEditor } from "./admin-use-product-editor";
import { useAdminProductEditorState } from "./admin-use-product-editor-state";
import { useAdminProductSave } from "./admin-use-product-save";
import { useAdminProductSizeInfo } from "./admin-use-product-size-info";
import { AdminWorkspaceLayout } from "./admin-workspace-layout";

/** admin 그룹 확인 뒤에만 마운트되는 인터랙티브 운영 워크스페이스입니다. */
export function AdminWorkspace({
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
  const {
    productEditors,
    productEditor,
    productView,
    productDraft,
    localProducts,
    setLocalProducts,
    isLoadingProducts,
    setIsLoadingProducts,
    catalogLoadFailed,
    setCatalogLoadFailed,
    isDeletingProducts,
    setIsDeletingProducts,
    productNotice,
    setProductNotice,
    isSavingProduct,
    setIsSavingProduct,
    savingProductEditorId,
    setSavingProductEditorId,
  } = useAdminProductEditorState();
  const {
    inventoryNotice,
    setInventoryNotice,
    inventorySavingIds,
    setInventorySavingIds,
    inventoryBusyRef,
  } = useAdminInventoryState();
  const {
    brandName,
    setBrandName,
    brandMemo,
    setBrandMemo,
    localBrands,
    setLocalBrands,
    brandNotice,
    setBrandNotice,
    isSavingBrand,
    setIsSavingBrand,
    brandBusyRef,
  } = useAdminBrandState();
  const {
    couponName,
    setCouponName,
    couponCode,
    setCouponCode,
    couponType,
    setCouponType,
    couponValue,
    setCouponValue,
    couponExpiresAt,
    setCouponExpiresAt,
    couponNotice,
    setCouponNotice,
    isSavingCoupon,
    setIsSavingCoupon,
    couponBusyRef,
  } = useAdminCouponDraft();
  const {
    campaignTitle,
    setCampaignTitle,
    campaignBody,
    setCampaignBody,
    campaignChannels,
    setCampaignChannels,
    campaignNotice,
    setCampaignNotice,
    isSavingCampaign,
    setIsSavingCampaign,
    campaignBusyRef,
  } = useAdminCampaignDraft();
  const {
    members,
    setMembers,
    memberNotice,
    setMemberNotice,
    isLoadingMembers,
    setIsLoadingMembers,
    membersLoaded,
    setMembersLoaded,
    memberLoadFailed,
    setMemberLoadFailed,
    memberNeedsRefresh,
    setMemberNeedsRefresh,
    isSavingMemberGroup,
    setIsSavingMemberGroup,
    memberRevision,
    setMemberRevision,
    memberBusyRef,
  } = useAdminMembersState();
  const {
    ocrFile,
    setOcrFile,
    ocrState,
    setOcrState,
    ocrRawText,
    setOcrRawText,
    ocrRows,
    setOcrRows,
    ocrNotice,
    setOcrNotice,
    isSavingOcr,
    setIsSavingOcr,
    isApplyingOcrInventory,
    setIsApplyingOcrInventory,
    ocrJobId,
    setOcrJobId,
    ocrVersion,
    setOcrVersion,
    ocrAnalysis,
    setOcrAnalysis,
    ocrInventoryJob,
    setOcrInventoryJob,
    ocrInventoryAttempts,
    ocrFileSelectionRef,
  } = useAdminOcrReviewState();
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
  const { refreshCatalogProducts } = useAdminCatalog({
    actions,
    catalogRequestGenerationRef,
    catalogMutationGenerationRef,
    setIsLoadingProducts,
    setCatalogLoadFailed,
    setLocalProducts,
    setProductNotice,
  });

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

  const selectedChannels = useMemo(
    () =>
      (Object.entries(campaignChannels) as Array<[MarketingChannel, boolean]>)
        .filter(([, selected]) => selected)
        .map(([channel]) => channel),
    [campaignChannels],
  );
  const selectedChannelNames = (target: Locale) =>
    selectedChannels.map((channel) => channelLabel(channel, target)).join(" · ");

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
  const {
    openNewProductEditor,
    finishProductEditor,
    rememberLocalProduct,
    openProductEditor,
    updateProductText,
    updateProductToggle,
    handleProductImageChange,
  } = useAdminProductEditor({
    productEditors,
    setProductNotice,
    recordProductActivity,
    setLocalProducts,
    productEditor,
  });
  const { handleProductSave } = useAdminProductSave({
    productEditors,
    isSavingProduct,
    productWorkspaceActiveRef,
    recordProductActivity,
    setProductNotice,
    actions,
    isKorean,
    setSavingProductEditorId,
    setIsSavingProduct,
    locale,
    rememberLocalProduct,
    finishProductEditor,
    refreshCatalogProducts,
  });
  const { handleDeleteProducts } = useAdminProductDelete({
    isDeletingProducts,
    isKorean,
    setIsDeletingProducts,
    actions,
    setProductNotice,
    refreshCatalogProducts,
    setLocalProducts,
    productEditors,
  });
  const { refreshInventoryProducts, handleInventoryStockChange } = useAdminInventory({
    setInventoryNotice,
    refreshCatalogProducts,
    localProducts,
    inventoryBusyRef,
    actions,
    catalogMutationGenerationRef,
    setLocalProducts,
    recordActivity,
    setInventorySavingIds,
  });
  const {
    saveProductDeckSpec,
    saveProductSizeChart,
    changeProductSizeChartKind,
    resetProductDraft,
  } = useAdminProductSizeInfo({
    productEditor,
    refreshCatalogProducts,
    setProductNotice,
    catalogMutationGenerationRef,
    setLocalProducts,
    productEditors,
    actions,
    removePendingProductActivity,
    localProducts,
  });
  const { handleBrandSubmit } = useAdminBrandDraft({
    brandBusyRef,
    brandName,
    setBrandNotice,
    brandMemo,
    localBrands,
    localProducts,
    actions,
    setIsSavingBrand,
    setLocalBrands,
    recordActivity,
    setBrandName,
    setBrandMemo,
  });
  const { handleCouponSubmit } = useAdminCouponSubmit({
    couponBusyRef,
    couponName,
    couponCode,
    couponType,
    couponValue,
    couponExpiresAt,
    setCouponNotice,
    actions,
    setIsSavingCoupon,
    recordActivity,
  });
  const { handleCampaignSubmit } = useAdminCampaignSubmit({
    campaignBusyRef,
    campaignTitle,
    campaignBody,
    selectedChannels,
    setCampaignNotice,
    campaignChannels,
    actions,
    setIsSavingCampaign,
    recordActivity,
    selectedChannelNames,
  });
  const { handleLoadMembers, handleMemberGroupUpdate } = useAdminMembers({
    memberBusyRef,
    actions,
    setMemberLoadFailed,
    setMemberNotice,
    setIsLoadingMembers,
    setMembers,
    setMembersLoaded,
    setMemberNeedsRefresh,
    setMemberRevision,
    memberNeedsRefresh,
    memberLoadFailed,
    members,
    currentAdmin,
    setIsSavingMemberGroup,
  });
  const { applyOcrJob, invalidateOcrRequest, handleOcrFileChange, createOcrRow } =
    useAdminOcrInput({
      setOcrInventoryJob,
      ocrCurrentJobRef,
      setOcrJobId,
      setOcrVersion,
      setOcrRawText,
      setOcrRows,
      setOcrAnalysis,
      setOcrState,
      ocrRequestGenerationRef,
      setIsSavingOcr,
      recordActivity,
      ocrFileSelectionRef,
      setOcrFile,
      setOcrNotice,
    });
  const { handleRecognize, updateOcrRow, handleAddOcrRow, handleRemoveOcrRow } =
    useAdminOcrRecognition({
      ocrFile,
      setOcrNotice,
      actions,
      setOcrState,
      ocrRequestGenerationRef,
      ocrFileSelectionRef,
      setIsSavingOcr,
      applyOcrJob,
      recordActivity,
      invalidateOcrRequest,
      setOcrRows,
      ocrRows,
      createOcrRow,
    });
  const { handleOcrSave, handleOcrRemap } = useAdminOcrReview({
    ocrRows,
    setOcrNotice,
    actions,
    ocrJobId,
    ocrVersion,
    setOcrState,
    recordActivity,
    ocrRequestGenerationRef,
    ocrCurrentJobRef,
    setIsSavingOcr,
    ocrRawText,
    applyOcrJob,
    setOcrInventoryJob,
  });

  return (
    <AdminWorkspaceLayout
      context={{
        locale,
        activeSection,
        setLocale,
        languageLabels,
        storeReturnPath,
        copy,
        adminName,
        isOpsMenuOpen,
        isMenuButtonHidden,
        setIsOpsMenuOpen,
        menuButtonRef,
        isDesktopAdmin,
        isMenuVisible,
        menuDrawerRef,
        selectSection,
        moveSectionFocus,
        operationActivities,
        productEditors,
        actions,
        localBrands,
        isDeletingProducts,
        productDraft,
        productEditor,
        isLoadingProducts,
        isSavingProduct,
        savingProductEditorId,
        productNotice,
        removePendingProductActivity,
        finishProductEditor,
        setProductNotice,
        handleDeleteProducts,
        openProductEditor,
        handleProductImageChange,
        openNewProductEditor,
        resetProductDraft,
        handleProductSave,
        saveProductDeckSpec,
        saveProductSizeChart,
        changeProductSizeChartKind,
        updateProductText,
        updateProductToggle,
        previewCompareAtPrice,
        previewName,
        previewPrice,
        previewSizes,
        localProducts,
        productView,
        catalogLoadFailed,
        inventoryNotice,
        handleInventoryStockChange,
        refreshInventoryProducts,
        inventorySavingIds,
        brandMemo,
        brandName,
        brandNotice,
        setBrandMemo,
        markActivityWorking,
        setBrandName,
        handleBrandSubmit,
        isSavingBrand,
        currentAdmin,
        membersLoaded,
        memberLoadFailed,
        isLoadingMembers,
        members,
        memberNotice,
        handleLoadMembers,
        memberNeedsRefresh,
        handleMemberGroupUpdate,
        memberRevision,
        isSavingMemberGroup,
        couponCode,
        couponExpiresAt,
        couponName,
        couponType,
        couponValue,
        couponNotice,
        setCouponCode,
        setCouponNotice,
        setCouponExpiresAt,
        setCouponName,
        handleCouponSubmit,
        setCouponType,
        setCouponValue,
        isSavingCoupon,
        campaignBody,
        campaignChannels,
        campaignNotice,
        setCampaignBody,
        setCampaignNotice,
        setCampaignChannels,
        handleCampaignSubmit,
        setCampaignTitle,
        isSavingCampaign,
        campaignTitle,
        ocrRows,
        ocrJobId,
        ocrVersion,
        ocrFile,
        isSavingOcr,
        isApplyingOcrInventory,
        ocrInventoryJob,
        ocrNotice,
        handleAddOcrRow,
        handleOcrFileChange,
        handleRecognize,
        handleRemoveOcrRow,
        handleOcrSave,
        updateOcrRow,
        ocrRawText,
        ocrInventoryAttempts,
        setIsApplyingOcrInventory,
        catalogMutationGenerationRef,
        setLocalProducts,
        ocrAnalysis,
        ocrState,
        handleOcrRemap,
      }}
    />
  );
}
