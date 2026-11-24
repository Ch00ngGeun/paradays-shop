"use client";
import adminWorkspaceLayoutStyles from "./admin-workspace-layout.module.css";
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
        <div className={adminWorkspaceLayoutStyles.sidebarIntro}>
          <strong>PARADAYS</strong>
          <span>{locale === "ko" ? "관리자" : "Admin"}</span>
        </div>
        <button
          aria-controls="ops-menu-drawer"
          aria-expanded={isOpsMenuOpen}
          className={
            isMenuButtonHidden
              ? `${adminWorkspaceLayoutStyles.opsMenuButton} ${adminWorkspaceLayoutStyles.opsMenuButtonHidden}`
              : adminWorkspaceLayoutStyles.opsMenuButton
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
          className={adminWorkspaceLayoutStyles.opsMenuScrim}
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
            ? `${adminWorkspaceLayoutStyles.opsMenuDrawer} ${adminWorkspaceLayoutStyles.opsMenuDrawerOpen}`
            : adminWorkspaceLayoutStyles.opsMenuDrawer
        }
        id="ops-menu-drawer"
        inert={!isMenuVisible}
        ref={menuDrawerRef}
        role={isDesktopAdmin ? "navigation" : "dialog"}
      >
        <div className={adminWorkspaceLayoutStyles.opsMenuDrawerHeader}>
          <div className={adminWorkspaceLayoutStyles.sidebarBrand}>
            <strong>PARADAYS</strong>
            <span>{locale === "ko" ? "관리자" : "Admin"}</span>
          </div>
          <button
            aria-label={locale === "ko" ? "메뉴 닫기" : "Close menu"}
            className={adminWorkspaceLayoutStyles.opsMenuClose}
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
        <div
          className={adminWorkspaceLayoutStyles.tabList}
          role="tablist"
          aria-orientation="vertical"
        >
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
          className={adminWorkspaceLayoutStyles.sidebarStoreLink}
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
