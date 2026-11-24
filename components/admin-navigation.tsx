"use client";
import { type AdminSection } from "@/lib/admin-ui/navigation";
import type { Locale } from "@/types/store";

export const ADMIN_GROUP = "admin";

export const subscribeToLocalOcrMode = () => () => {};

export const serverLocalOcrMode = () => false;

export const desktopAdminQuery = "(min-width: 1024px)";

export const subscribeToAdminViewport = (onChange: () => void) => {
  const query = window.matchMedia(desktopAdminQuery);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
};

export const getDesktopAdminSnapshot = () =>
  window.matchMedia(desktopAdminQuery).matches;

export const getServerDesktopAdminSnapshot = () => false;

export const sectionShortLabels: Record<Locale, Record<AdminSection, string>> = {
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

export const sectionItems: ReadonlyArray<
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

export function AdminMenuIcon({
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
