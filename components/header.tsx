// 역할: 레퍼런스 순서의 상단 내비게이션, 입력 방식별 Menu, Search와 Cart 진입을 조율합니다.
"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  Suspense,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FocusEvent,
  type KeyboardEvent,
} from "react";

import { useAuth } from "@/contexts/auth-context";
import { useCart } from "@/contexts/cart-context";
import { useCatalogFilter } from "@/contexts/catalog-filter-context";
import { useLocale } from "@/contexts/locale-context";
import { useTheme } from "@/contexts/theme-context";
import { menuGroups, menuLeafTops, menuRootAll } from "@/data/navigation";

import { useHeaderScroll } from "@/hooks/use-header-scroll";
import { rememberAuthReturnPath } from "@/lib/auth/return-path";
import {
  buildAdminEntryHref,
  getServerStorefrontHashSnapshot,
  getStorefrontHashSnapshot,
  subscribeToStorefrontHash,
} from "@/lib/admin-ui/store-return";

import { LogoPlaceholder } from "./logo-placeholder";
import { SearchModal } from "./search-modal";
import styles from "./header.module.css";

/** 전역 고정 헤더: 언어 전환, 데스크톱/모바일 내비, 오버레이(메뉴·검색)를 한곳에서 관리합니다. */
export function Header() {
  const pathname = usePathname();
  // 관리자 화면은 스토어 Home·Menu·Cart·Search 마스트헤드가 필요 없음
  const isAdminRoute = pathname === "/admin" || pathname.startsWith("/admin/");

  const { isAuthenticated, user } = useAuth();
  const { itemCount } = useCart();
  const { isSelected, toggleFilter } = useCatalogFilter();
  const { copy, locale, setLocale } = useLocale();
  const { theme, toggleTheme } = useTheme();
  // PC·모바일 공통 Menu 드롭다운 열림 여부 (모바일은 별도 드로어 없이 동일 UI)
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  // 페이드아웃이 끝날 때까지 드롭다운 DOM을 유지합니다.
  const [isMenuMounted, setIsMenuMounted] = useState(false);
  const [isMenuVisible, setIsMenuVisible] = useState(false);
  // 검색 오버레이
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  // hover 메뉴를 쓸 수 있는 정밀 포인터인지 여부 (모바일은 클릭만)
  const [hasFinePointer, setHasFinePointer] = useState(false);
  // 좁은 화면에서는 모바일 패널에만 드롭다운을 렌더합니다.
  const [isNarrowViewport, setIsNarrowViewport] = useState(false);
  const menuClusterRef = useRef<HTMLDivElement | null>(null);
  // Menu → 드롭다운 이동 시 잠깐의 빈 구간에서 닫히지 않도록 지연 타이머
  const menuCloseTimeoutRef = useRef<number | null>(null);
  // 아래로 스크롤 시 숨기고, 살짝 올리면 다시 표시 (메뉴·검색 열린 동안·관리자 경로는 고정 노출)
  const isHeaderHidden = useHeaderScroll(isAdminRoute || isMenuOpen || isSearchOpen);
  // 현재 로케일에 맞는 언어 토글 라벨
  const languageLabels =
    locale === "en" ? { ko: "KOR", en: "ENG" } : { ko: "한국어", en: "영어" };

  // hover 가능한 정밀 포인터만 데스크톱 hover 메뉴를 사용하게 분리합니다.
  useEffect(() => {
    const hoverQuery = window.matchMedia("(hover: hover) and (pointer: fine)");
    const narrowQuery = window.matchMedia("(max-width: 767px)");
    const updatePointerCapability = () => setHasFinePointer(hoverQuery.matches);
    const updateViewport = () => setIsNarrowViewport(narrowQuery.matches);

    updatePointerCapability();
    updateViewport();
    hoverQuery.addEventListener("change", updatePointerCapability);
    narrowQuery.addEventListener("change", updateViewport);

    return () => {
      hoverQuery.removeEventListener("change", updatePointerCapability);
      narrowQuery.removeEventListener("change", updateViewport);
    };
  }, []);

  // 메뉴 스크림과 같은 --ui-fade-duration으로 드롭다운을 페이드인/아웃합니다.
  useEffect(() => {
    let outerFrame = 0;
    let innerFrame = 0;

    if (isMenuOpen) {
      outerFrame = window.requestAnimationFrame(() => {
        setIsMenuMounted(true);
        innerFrame = window.requestAnimationFrame(() => setIsMenuVisible(true));
      });
    } else {
      outerFrame = window.requestAnimationFrame(() => setIsMenuVisible(false));
    }

    return () => {
      window.cancelAnimationFrame(outerFrame);
      window.cancelAnimationFrame(innerFrame);
    };
  }, [isMenuOpen]);

  // reduced-motion 등으로 transitionend가 없을 때도 닫힌 뒤 DOM을 정리합니다.
  useEffect(() => {
    if (isMenuOpen || isMenuVisible || !isMenuMounted) {
      return;
    }

    const timeout = window.setTimeout(() => setIsMenuMounted(false), 320);
    return () => window.clearTimeout(timeout);
  }, [isMenuOpen, isMenuVisible, isMenuMounted]);

  // 언마운트 시 메뉴 닫기 타이머를 정리합니다.
  useEffect(() => {
    return () => {
      if (menuCloseTimeoutRef.current !== null) {
        window.clearTimeout(menuCloseTimeoutRef.current);
      }
    };
  }, []);

  // 메뉴가 열린 채 아래로 스크롤하면 자동으로 닫음.
  useEffect(() => {
    if (!isMenuOpen) {
      return;
    }

    let lastScrollY = window.scrollY;
    let ticking = false;

    const handleScroll = () => {
      if (ticking) {
        return;
      }

      ticking = true;
      window.requestAnimationFrame(() => {
        const currentScrollY = Math.max(0, window.scrollY);
        const delta = currentScrollY - lastScrollY;

        if (delta > 6) {
          if (menuCloseTimeoutRef.current !== null) {
            window.clearTimeout(menuCloseTimeoutRef.current);
            menuCloseTimeoutRef.current = null;
          }
          setIsMenuOpen(false);
        }

        lastScrollY = currentScrollY;
        ticking = false;
      });
    };

    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, [isMenuOpen]);

  /** Menu 드롭다운을 닫습니다. */
  const closeMenu = () => {
    setIsMenuOpen(false);
  };

  /** Menu 열림을 토글합니다 (모바일·데스크톱 클릭 공통). */
  const toggleMenu = () => {
    setIsMenuOpen((isOpen) => !isOpen);
  };

  /** Escape로 닫고, ArrowDown으로 드롭다운 첫 항목에 포커스를 옮깁니다. */
  const handleMenuKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Escape") {
      closeMenu();
      event.currentTarget.focus();
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setIsMenuOpen(true);
      window.requestAnimationFrame(() => {
        menuClusterRef.current
          ?.querySelector<HTMLButtonElement>("[data-menu-item]")
          ?.focus();
      });
    }
  };

  /** 포커스가 트리거와 드롭다운을 모두 벗어난 경우에만 메뉴를 닫습니다. */
  const handleMenuBlur = (event: FocusEvent<HTMLDivElement>) => {
    const nextFocusedElement = event.relatedTarget as Node | null;

    if (!event.currentTarget.contains(nextFocusedElement)) {
      closeMenu();
    }
  };

  /** hover로 메뉴를 열 때 대기 중인 닫기 타이머를 취소합니다. (정밀 포인터만) */
  const handleMenuPointerEnter = () => {
    if (!hasFinePointer) {
      return;
    }

    if (menuCloseTimeoutRef.current !== null) {
      window.clearTimeout(menuCloseTimeoutRef.current);
      menuCloseTimeoutRef.current = null;
    }

    setIsMenuOpen(true);
  };

  // Menu 닫기 지연도 페이드 시간과 맞춤 (0.28s)
  const MENU_FADE_MS = 280;

  /** 트리거↔드롭다운 사이 빈 구간을 지나도 바로 닫히지 않게 짧게 지연합니다. */
  const handleMenuPointerLeave = () => {
    if (!hasFinePointer) {
      return;
    }

    menuCloseTimeoutRef.current = window.setTimeout(() => {
      closeMenu();
      menuCloseTimeoutRef.current = null;
    }, MENU_FADE_MS);
  };

  /** 필터 항목 토글 — 다중 선택, 메뉴는 열어 둔 채 유지 */
  const handleMenuSelection = (itemId: string) => {
    toggleFilter(itemId);
  };

  /** Menu 트리거 + 드롭다운 본문 (PC·모바일 동일 스타일 공유) */
  const menuDropdown = isMenuMounted ? (
    <div
      className={
        isMenuVisible
          ? `${styles.menuDropdown} ${styles.menuDropdownVisible}`
          : styles.menuDropdown
      }
      id="store-menu-dropdown"
      onTransitionEnd={(event) => {
        if (
          event.target !== event.currentTarget ||
          event.propertyName !== "opacity" ||
          isMenuOpen ||
          isMenuVisible
        ) {
          return;
        }

        setIsMenuMounted(false);
      }}
    >
      {/* 상단: All | Clothes | SkateBoard | SALE */}
      <section className={`${styles.leafTopSection} ${styles.menuAll}`}>
        <button
          aria-pressed={isSelected(menuRootAll.id)}
          className={styles.leafTopButton}
          data-menu-item
          onClick={() => handleMenuSelection(menuRootAll.id)}
          type="button"
        >
          {menuRootAll.label[locale]}
        </button>
      </section>

      {menuGroups
        .filter((group) => group.id !== "brand")
        .map((group) => (
          <section
            className={
              group.id === "clothes"
                ? styles.menuClothes
                : group.id === "skateboard"
                  ? styles.menuSkate
                  : undefined
            }
            key={group.id}
          >
            <p className={styles.groupHeading}>{group.label[locale]}</p>
            {group.items.map((item) => (
              <button
                aria-pressed={isSelected(item.id)}
                data-menu-item
                key={item.id}
                onClick={() => handleMenuSelection(item.id)}
                type="button"
              >
                {item.label[locale]}
              </button>
            ))}
          </section>
        ))}

      {menuLeafTops.map((item) => (
        <section
          className={`${styles.leafTopSection} ${styles.menuSale}`}
          key={item.id}
        >
          <button
            aria-pressed={isSelected(item.id)}
            className={styles.leafTopButton}
            data-menu-item
            onClick={() => handleMenuSelection(item.id)}
            type="button"
          >
            {item.label[locale]}
          </button>
        </section>
      ))}

      {/* 하단: Brand — Clothes 아래부터 가로로 펼쳐 스크롤 없이 표시 */}
      {menuGroups
        .filter((group) => group.id === "brand")
        .map((group) => (
          <section className={styles.brandSection} key={group.id}>
            <p className={styles.groupHeading}>{group.label[locale]}</p>
            <div className={styles.brandItems}>
              {group.items.map((item) => (
                <button
                  aria-pressed={isSelected(item.id)}
                  data-menu-item
                  key={item.id}
                  onClick={() => handleMenuSelection(item.id)}
                  type="button"
                >
                  {item.label[locale]}
                </button>
              ))}
            </div>
          </section>
        ))}
    </div>
  ) : null;

  if (isAdminRoute) {
    return null;
  }

  return (
    <>
      <header
        className={
          isHeaderHidden ? `${styles.header} ${styles.headerHidden}` : styles.header
        }
      >
        {/* 좌상단: Sign / Login (로그인 시 마이페이지 / 유저이름 [/ 관리자페이지]) */}
        <nav aria-label="Account" className={styles.authNav}>
          {isAuthenticated && user ? (
            <>
              <Link
                aria-current={pathname === "/account" ? "page" : undefined}
                href="/account"
              >
                {copy.myPage}
              </Link>
              <span aria-hidden="true" className={styles.authNavSep}>
                /
              </span>
              <span className={styles.authNavUser}>
                {user.displayName?.trim() || user.email || user.username}
              </span>
              {user.groups.includes("admin") ? (
                <>
                  <span aria-hidden="true" className={styles.authNavSep}>
                    /
                  </span>
                  <Suspense
                    fallback={
                      <Link href={buildAdminEntryHref(pathname)}>{copy.adminPage}</Link>
                    }
                  >
                    <AdminEntryLink pathname={pathname} label={copy.adminPage} />
                  </Suspense>
                </>
              ) : null}
            </>
          ) : (
            <>
              <Link
                aria-current={pathname === "/signup" ? "page" : undefined}
                href="/signup"
                onClick={() => rememberAuthReturnPath()}
              >
                {copy.authNavSign}
              </Link>
              <span aria-hidden="true" className={styles.authNavSep}>
                /
              </span>
              <Link
                aria-current={pathname === "/login" ? "page" : undefined}
                href="/login"
                onClick={() => rememberAuthReturnPath()}
              >
                {copy.authNavLogin}
              </Link>
            </>
          )}
        </nav>

        {/* 우상단: 언어 전환 + 아래 호버로 살짝 나오는 테마 토글 */}
        <div className={styles.utilitySwitch}>
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
          <div className={styles.themeSlot}>
            <button
              aria-label={theme === "dark" ? copy.themeToLight : copy.themeToDark}
              aria-pressed={theme === "dark"}
              className={
                theme === "dark"
                  ? `${styles.themeToggle} ${styles.themeToggleDark}`
                  : styles.themeToggle
              }
              onClick={toggleTheme}
              type="button"
            >
              <span aria-hidden="true" className={styles.themeIcon}>
                {theme === "dark" ? (
                  <svg
                    fill="none"
                    viewBox="0 0 16 16"
                    xmlns="http://www.w3.org/2000/svg"
                  >
                    <circle
                      cx="8"
                      cy="8"
                      r="3.1"
                      stroke="currentColor"
                      strokeWidth="1.2"
                    />
                    <path
                      d="M8 1.4v1.5M8 13.1v1.5M1.4 8h1.5M13.1 8h1.5M3.3 3.3l1.1 1.1M11.6 11.6l1.1 1.1M12.7 3.3l-1.1 1.1M4.4 11.6l-1.1 1.1"
                      stroke="currentColor"
                      strokeLinecap="round"
                      strokeWidth="1.2"
                    />
                  </svg>
                ) : (
                  <svg
                    fill="none"
                    viewBox="0 0 16 16"
                    xmlns="http://www.w3.org/2000/svg"
                  >
                    <path
                      d="M10.1 2.35A5.85 5.85 0 1 0 13.65 11.1 6.15 6.15 0 1 1 10.1 2.35Z"
                      stroke="currentColor"
                      strokeLinejoin="round"
                      strokeWidth="1.2"
                    />
                  </svg>
                )}
              </span>
              <span className={styles.themeLabel}>
                {theme === "dark" ? "light" : "dark"}
              </span>
            </button>
          </div>
        </div>

        {/* 데스크톱 단일행: Home·Menu | 로고 | Cart·Search */}
        <div className={styles.mainBar}>
          <nav className={styles.desktopLeft} aria-label="Primary navigation">
            <Link href="/" onClick={closeMenu}>
              {copy.home}
            </Link>
            <div
              className={styles.menuCluster}
              onBlur={handleMenuBlur}
              onPointerEnter={handleMenuPointerEnter}
              onPointerLeave={handleMenuPointerLeave}
              ref={menuClusterRef}
            >
              <button
                aria-controls="store-menu-dropdown"
                aria-expanded={isMenuOpen}
                aria-haspopup="true"
                className={isMenuOpen ? styles.menuTriggerActive : styles.menuTrigger}
                onClick={toggleMenu}
                onKeyDown={handleMenuKeyDown}
                type="button"
              >
                {copy.menu}
              </button>
              {!isNarrowViewport ? menuDropdown : null}
            </div>
          </nav>

          <Link
            aria-label="PARADAYS home"
            className={styles.brand}
            href="/"
            onClick={closeMenu}
          >
            <LogoPlaceholder />
          </Link>

          <nav className={styles.desktopRight} aria-label="Store controls">
            <Link href="/cart" onClick={closeMenu}>
              {copy.cart} <span aria-label={`${itemCount} items`}>({itemCount})</span>
            </Link>
            <button
              onClick={() => {
                closeMenu();
                setIsSearchOpen(true);
              }}
              type="button"
            >
              {copy.search}
            </button>
          </nav>
        </div>

        {/* 좁은 화면: 로고 아래 Home·Menu·Cart·Search — Menu는 PC와 같은 드롭다운을 클릭으로 연다 */}
        <nav aria-label="Primary navigation" className={styles.mobileNav}>
          <Link href="/" onClick={closeMenu}>
            {copy.home}
          </Link>
          <div className={styles.mobileMenuCluster}>
            <button
              aria-controls="store-menu-dropdown"
              aria-expanded={isMenuOpen}
              aria-haspopup="true"
              className={isMenuOpen ? styles.menuTriggerActive : styles.menuTrigger}
              onClick={toggleMenu}
              type="button"
            >
              {copy.menu}
            </button>
          </div>
          <Link href="/cart" onClick={closeMenu}>
            {copy.cart} <span aria-label={`${itemCount} items`}>({itemCount})</span>
          </Link>
          <button
            onClick={() => {
              closeMenu();
              setIsSearchOpen(true);
            }}
            type="button"
          >
            {copy.search}
          </button>
        </nav>

        {/* 모바일에서만 헤더 하단에 PC와 동일 스타일 드롭다운을 붙입니다. */}
        <div className={styles.mobileMenuPanel}>
          {isNarrowViewport ? menuDropdown : null}
        </div>
      </header>

      {/* 메뉴 스크림: 항상 두고 opacity로 페이드 (상품 호버와 동일 --ui-fade-duration) */}
      <button
        aria-hidden={!isMenuOpen}
        aria-label="Close menu"
        className={
          isMenuOpen
            ? `${styles.menuScrim} ${styles.menuScrimVisible}`
            : styles.menuScrim
        }
        onClick={closeMenu}
        tabIndex={isMenuOpen ? 0 : -1}
        type="button"
      />
      {/* 고정 헤더 높이만큼 본문 시작점을 확보해 첫 콘텐츠가 가려지지 않게 합니다. */}
      <div aria-hidden="true" className={styles.headerSpacer} />
      <SearchModal isOpen={isSearchOpen} onClose={() => setIsSearchOpen(false)} />
    </>
  );
}

/** query 기반 신규 상품도 현재 상세 위치를 갖는 실제 링크로 만들어 새 탭 동작을 유지합니다. */
function AdminEntryLink({
  pathname,
  label,
}: Readonly<{ pathname: string; label: string }>) {
  const searchParams = useSearchParams();
  const hash = useSyncExternalStore(
    subscribeToStorefrontHash,
    getStorefrontHashSnapshot,
    getServerStorefrontHashSnapshot,
  );
  const search = searchParams.toString();
  return (
    <Link href={buildAdminEntryHref(`${pathname}${search ? `?${search}` : ""}${hash}`)}>
      {label}
    </Link>
  );
}
