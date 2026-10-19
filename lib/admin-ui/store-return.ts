import { parseAdminSection, type AdminSection } from "./navigation";

/** 관리자 진입마다 공개 스토어 복귀 위치를 URL에 명시하며 전역 저장소는 사용하지 않습니다. */
const STORE_RETURN_PARAMETER = "returnTo";
const ADMIN_RESUME_PARAMETER = "adminSection";
const STORE_ORIGIN = "https://store.invalid";
const PUBLIC_ANCHORS = new Set([
  "catalog",
  "products",
  "details",
  "product-details",
  "description",
  "reviews",
  "size-guide",
]);
const PUBLIC_SLUG = /^[a-z0-9가-힣][a-z0-9가-힣-]{0,179}$/;

function getSafeStorefrontUrl(candidate: string): URL | null {
  if (
    candidate.length > 2_048 ||
    !candidate.startsWith("/") ||
    candidate.startsWith("//") ||
    /[\\\u0000-\u0020\u007f-\u009f]/.test(candidate)
  ) {
    return null;
  }

  const rawPath = candidate.split(/[?#]/, 1)[0];
  if (/%2f|%5c/i.test(rawPath)) return null;

  try {
    const path = decodeURIComponent(rawPath);
    if (
      !/^\/(?:products(?:\/[a-z0-9가-힣][a-z0-9가-힣-]{0,179})?|cart|account)?\/?$/.test(
        path,
      )
    ) {
      return null;
    }

    const url = new URL(candidate, STORE_ORIGIN);
    if (url.origin !== STORE_ORIGIN || decodeURIComponent(url.pathname) !== path)
      return null;
    for (const key of ["slug", "locale"]) {
      if (url.searchParams.getAll(key).length > 1) return null;
    }
    return url;
  } catch {
    return null;
  }
}

/** 공개 화면·상품 slug·언어·공개 anchor만 복제해 인증값/개인정보 query를 전달하지 않습니다. */
export function sanitizeStorefrontReturnPath(candidate: string): string {
  const url = getSafeStorefrontUrl(candidate);
  if (!url) return "/";
  const publicQuery = new URLSearchParams();
  for (const key of ["slug", "locale"]) {
    const value = url.searchParams.get(key);
    if (
      value &&
      ((key === "slug" &&
        decodeURIComponent(url.pathname).replace(/\/$/, "") === "/products" &&
        PUBLIC_SLUG.test(value)) ||
        (key === "locale" && (value === "ko" || value === "en")))
    ) {
      publicQuery.set(key, value);
    }
  }
  const search = publicQuery.toString();
  const hash = PUBLIC_ANCHORS.has(url.hash.slice(1)) ? url.hash : "";
  return `${url.pathname}${search ? `?${search}` : ""}${hash}`;
}

function parseStorefrontAdminSection(storefrontPath: string): AdminSection {
  const values =
    getSafeStorefrontUrl(storefrontPath)?.searchParams.getAll(ADMIN_RESUME_PARAMETER);
  return values?.length === 1
    ? parseAdminSection(new URLSearchParams({ section: values[0] }).toString())
    : "overview";
}

export function buildAdminEntryHref(storefrontPath: string): string {
  const returnPath = sanitizeStorefrontReturnPath(storefrontPath);
  const section = parseStorefrontAdminSection(storefrontPath);
  const query = new URLSearchParams();
  if (returnPath !== "/") query.set(STORE_RETURN_PARAMETER, returnPath);
  if (section !== "overview") query.set("section", section);
  return `/admin${query.size ? `?${query}` : ""}`;
}

/** 중복 returnTo나 미지정 주소는 홈으로 처리해 관리자/인증 화면 순환을 막습니다. */
export function parseAdminStoreReturnPath(search: string): string {
  const values = new URLSearchParams(search).getAll(STORE_RETURN_PARAMETER);
  return values.length === 1 ? sanitizeStorefrontReturnPath(values[0]) : "/";
}

export function getAdminStoreReturnSnapshot(): string {
  return typeof window === "undefined"
    ? getServerAdminStoreReturnSnapshot()
    : parseAdminStoreReturnPath(window.location.search);
}

/** 메뉴만 공개 URL로 왕복하며 편집 세션·초안·실제/모의 모드는 복원하지 않습니다. */
export function buildAdminStoreResumeHref(search: string): string {
  const returnPath = parseAdminStoreReturnPath(search);
  const section = parseAdminSection(search);
  if (section === "overview") return returnPath;
  const url = new URL(returnPath, STORE_ORIGIN);
  url.searchParams.set(ADMIN_RESUME_PARAMETER, section);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function getAdminStoreResumeSnapshot(): string {
  return typeof window === "undefined"
    ? getServerAdminStoreReturnSnapshot()
    : buildAdminStoreResumeHref(window.location.search);
}

export function getServerAdminStoreReturnSnapshot(): string {
  return "/";
}

export function getStorefrontHashSnapshot(): string {
  return typeof window === "undefined" ? "" : window.location.hash;
}

export function getServerStorefrontHashSnapshot(): string {
  return "";
}

export function subscribeToStorefrontHash(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  window.addEventListener("popstate", onChange);
  return () => {
    window.removeEventListener("hashchange", onChange);
    window.removeEventListener("popstate", onChange);
  };
}
