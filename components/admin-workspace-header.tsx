// 역할: 관리자 워크스페이스 머리말. 현재 메뉴 위치(관리자 / 메뉴), 언어 전환, 좁은 화면용 스토어 복귀 링크와 관리자 이름 배지를 그립니다.
"use client";
import adminWorkspaceLayoutStyles from "./admin-workspace-layout.module.css";
import adminSharedStyles from "./admin-shared.module.css";
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
        <p className={adminWorkspaceLayoutStyles.adminBreadcrumb}>
          {locale === "ko" ? "관리자" : "Admin"}
          <span aria-hidden="true">/</span>
          {activeSection === "overview"
            ? locale === "ko"
              ? "홈"
              : "Home"
            : sectionShortLabels[locale][activeSection]}
        </p>
        <h1 className={adminSharedStyles.srOnly}>
          {locale === "ko" ? "스토어 운영" : "Store operations"}
        </h1>
      </div>
      <div className={adminWorkspaceLayoutStyles.headerActions}>
        <div
          className={adminWorkspaceLayoutStyles.languageSwitch}
          aria-label="Language"
        >
          <button
            aria-pressed={locale === "ko"}
            onClick={() => setLocale("ko")}
            type="button"
          >
            {languageLabels.ko}
          </button>
          <span aria-hidden="true" className={adminWorkspaceLayoutStyles.languageSep}>
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
        <div className={adminWorkspaceLayoutStyles.headerStatusRow}>
          <Link
            className={`${styles.homeLink} ${styles.mobileStoreLink}`}
            href={storeReturnPath}
          >
            {copy.adminBackToStore}
          </Link>
          <div className={adminWorkspaceLayoutStyles.securityBadge} title={adminName}>
            <AdminMenuIcon section="members" />
            {locale === "ko" ? "관리자" : "Administrator"}
          </div>
        </div>
      </div>
    </header>
  );
}
