"use client";
import Link from "next/link";
import styles from "./admin-dashboard.module.css";
import { AdminMenuIcon, sectionShortLabels } from "./admin-navigation";
import { AdminWorkspaceContext } from "./admin-workspace-context";

export function AdminWorkspaceHeader({
  context,
}: Readonly<{ context: AdminWorkspaceContext }>) {
  const {
    locale,
    activeSection,
    setLocale,
    languageLabels,
    storeReturnPath,
    copy,
    adminName,
  } = context;
  return (
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
  );
}
