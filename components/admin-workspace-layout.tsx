"use client";
import Link from "next/link";
import styles from "./admin-dashboard.module.css";
import { AdminMenuIcon, sectionItems, sectionShortLabels } from "./admin-navigation";
import { AdminWorkspaceContext } from "./admin-workspace-context";
import { AdminWorkspaceHeader } from "./admin-workspace-header";
import { AdminWorkspacePanels } from "./admin-workspace-panels";

export function AdminWorkspaceLayout({
  context,
}: Readonly<{ context: AdminWorkspaceContext }>) {
  const {
    locale,
    activeSection,
    storeReturnPath,
    copy,
    isOpsMenuOpen,
    isMenuButtonHidden,
    setIsOpsMenuOpen,
    menuButtonRef,
    isDesktopAdmin,
    isMenuVisible,
    menuDrawerRef,
    selectSection,
    moveSectionFocus,
  } = context;
  return (
    <section
      className={styles.adminPage}
      aria-label={locale === "ko" ? "PARADAYS 관리자 화면" : "PARADAYS admin"}
    >
      <AdminWorkspaceHeader context={context} />

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

      <AdminWorkspacePanels context={context} />
    </section>
  );
}
