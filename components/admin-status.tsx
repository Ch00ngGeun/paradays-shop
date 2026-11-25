// 역할: 관리자 공통 상태 표시. 상태 배지·재고 상태 배지·안내 상자와 재고 수량의 상태 판정을 한·영 이름과 함께 제공합니다.
import type { ReactNode } from "react";

import type { Locale } from "@/types/store";

import styles from "./admin-status.module.css";

export type AdminSeverity = "danger" | "success" | "warning" | "neutral";
export type AdminStatus =
  | "urgent"
  | "blocking"
  | "danger"
  | "success"
  | "attention"
  | "warning"
  | "neutral";
export type StockStatus = "normal" | "low" | "outOfStock" | "unknown";

export interface AdminStatusBadgeProps {
  status: AdminStatus;
  /** 추가 설명입니다. 화면에 보이는 상태 이름은 항상 그대로 둡니다. */
  label?: string;
  children?: ReactNode;
  className?: string;
  locale?: Locale;
}

export interface AdminNoticeProps {
  status: AdminStatus;
  title?: string;
  children?: ReactNode;
  /** 사용자가 화면에 있는 동안 바뀌는 안내에만 켭니다. */
  announce?: "off" | "polite" | "assertive";
  className?: string;
  locale?: Locale;
}

export interface StockStatusBadgeProps {
  stock: number | undefined;
  className?: string;
  locale?: Locale;
}

type StatusDetail = { severity: AdminSeverity; label: Record<Locale, string> };

const statusDetails: Record<AdminStatus, StatusDetail> = {
  urgent: { severity: "danger", label: { ko: "긴급", en: "Urgent" } },
  blocking: { severity: "danger", label: { ko: "진행 불가", en: "Blocked" } },
  danger: { severity: "danger", label: { ko: "오류", en: "Error" } },
  success: { severity: "success", label: { ko: "완료", en: "Done" } },
  attention: { severity: "warning", label: { ko: "확인 필요", en: "Needs review" } },
  warning: { severity: "warning", label: { ko: "주의", en: "Warning" } },
  neutral: { severity: "neutral", label: { ko: "안내", en: "Info" } },
};

const severityClasses: Record<AdminSeverity, string> = {
  danger: styles.danger,
  success: styles.success,
  warning: styles.warning,
  neutral: styles.neutral,
};

const stockDetails: Record<StockStatus, StatusDetail> = {
  normal: { severity: "success", label: { ko: "정상", en: "In stock" } },
  low: { severity: "warning", label: { ko: "주의", en: "Low" } },
  outOfStock: { severity: "neutral", label: { ko: "품절", en: "Sold out" } },
  unknown: { severity: "warning", label: { ko: "확인 필요", en: "Needs review" } },
};

/** 알 수 없거나 잘못된 수량을 정상 재고로 보이게 하지 않습니다. */
export function getStockStatus(stock: number | undefined): StockStatus {
  if (
    typeof stock !== "number" ||
    !Number.isFinite(stock) ||
    !Number.isInteger(stock) ||
    stock < 0
  ) {
    return "unknown";
  }
  if (stock === 0) return "outOfStock";
  return stock <= 5 ? "low" : "normal";
}

function StatusBadge({
  severity,
  label,
  children,
  className,
  status,
  stockStatus,
}: Readonly<{
  severity: AdminSeverity;
  label: string;
  children?: ReactNode;
  className?: string;
  status?: AdminStatus;
  stockStatus?: StockStatus;
}>) {
  return (
    <span
      className={[styles.badge, severityClasses[severity], className]
        .filter(Boolean)
        .join(" ")}
      data-status={status}
      data-stock-status={stockStatus}
      data-severity={severity}
    >
      <span aria-hidden="true" className={styles.dot} />
      <span className={styles.badgeText}>
        <span className={styles.label}>{label}</span>
        {children !== undefined && children !== null ? (
          <span className={styles.badgeDetails}> · {children}</span>
        ) : null}
      </span>
    </span>
  );
}

export function AdminStatusBadge({
  status,
  label,
  children,
  className,
  locale = "ko",
}: Readonly<AdminStatusBadgeProps>) {
  const details = statusDetails[status];
  const name = details.label[locale];
  return (
    <StatusBadge
      status={status}
      severity={details.severity}
      label={label && label !== name ? `${name} · ${label}` : name}
      className={className}
    >
      {children}
    </StatusBadge>
  );
}

export function StockStatusBadge({
  stock,
  className,
  locale = "ko",
}: Readonly<StockStatusBadgeProps>) {
  const status = getStockStatus(stock);
  const details = stockDetails[status];
  return (
    <StatusBadge
      stockStatus={status}
      severity={details.severity}
      label={details.label[locale]}
      className={className}
    />
  );
}

function StatusIcon({ severity }: Readonly<{ severity: AdminSeverity }>) {
  return (
    <svg
      className={styles.icon}
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {severity === "warning" ? (
        <>
          <path d="M12 3 2 21h20L12 3Z" />
          <path d="M12 9v5m0 3v.1" />
        </>
      ) : (
        <>
          <circle cx="12" cy="12" r="9" />
          {severity === "success" ? (
            <path d="m8 12 3 3 5-6" />
          ) : severity === "danger" ? (
            <path d="M12 7v6m0 4v.1" />
          ) : (
            <path d="M12 7v.1m0 4v6" />
          )}
        </>
      )}
    </svg>
  );
}

export function AdminNotice({
  status,
  title,
  children,
  announce = "off",
  className,
  locale = "ko",
}: Readonly<AdminNoticeProps>) {
  const details = statusDetails[status];
  const name = details.label[locale];
  // assertive로 명시한 긴급·진행 불가·오류(심각도 danger) 안내만 화면 낭독을 끊고 읽게 합니다(role=alert).
  const role =
    announce === "off"
      ? undefined
      : announce === "assertive" && details.severity === "danger"
        ? "alert"
        : "status";

  return (
    <div
      className={[styles.notice, severityClasses[details.severity], className]
        .filter(Boolean)
        .join(" ")}
      data-status={status}
      data-severity={details.severity}
      role={role}
      aria-atomic={role ? true : undefined}
    >
      <StatusIcon severity={details.severity} />
      <div className={styles.content}>
        <strong className={styles.heading}>
          {name}
          {title && title !== name ? ` · ${title}` : null}
        </strong>
        {children !== undefined && children !== null ? (
          <div className={styles.message}>{children}</div>
        ) : null}
      </div>
    </div>
  );
}
