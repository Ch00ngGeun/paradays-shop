"use client";
import adminAccessPanelStyles from "./admin-access-panel.module.css";
import { useLocale } from "@/contexts/locale-context";
import { subscribeToAdminSection } from "@/lib/admin-ui/navigation";
import {
  getAdminStoreReturnSnapshot,
  getServerAdminStoreReturnSnapshot,
} from "@/lib/admin-ui/store-return";
import Link from "next/link";
import { useSyncExternalStore } from "react";
import styles from "./admin-dashboard.module.css";

/** 정적 export에서 노출 가능한 UX 가드입니다. 실제 데이터 API도 admin group을 별도 검증해야 합니다. */
export function AdminAccessPanel({
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
    <section className={adminAccessPanelStyles.accessPage} aria-live="polite">
      <div className={adminAccessPanelStyles.accessTopBar}>
        <Link className={styles.homeLink} href={storeReturnPath}>
          {copy.adminBackToStore}
        </Link>
      </div>
      <section className={adminAccessPanelStyles.accessPanel}>
        <p className={adminAccessPanelStyles.eyebrow}>{eyebrow}</p>
        <h1>{title}</h1>
        <p>{description}</p>
        {loading ? <span className={styles.loadingLine}>{loadingLabel}</span> : null}
        {action ? <div className={styles.accessAction}>{action}</div> : null}
      </section>
    </section>
  );
}
