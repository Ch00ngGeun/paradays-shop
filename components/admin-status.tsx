import type { ReactNode } from "react";
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
  /** Additional context; the visible status name is always retained. */
  label?: string;
  children?: ReactNode;
  className?: string;
}

export interface AdminNoticeProps {
  status: AdminStatus;
  title?: string;
  children?: ReactNode;
  /** Opt in only for a notice that changes while the user is on the page. */
  announce?: "off" | "polite" | "assertive";
  className?: string;
}

export interface StockStatusBadgeProps {
  stock: number | undefined;
  className?: string;
}

const statusDetails: Record<AdminStatus, { severity: AdminSeverity; label: string }> = {
  urgent: { severity: "danger", label: "긴급" },
  blocking: { severity: "danger", label: "진행 불가" },
  danger: { severity: "danger", label: "오류" },
  success: { severity: "success", label: "완료" },
  attention: { severity: "warning", label: "확인 필요" },
  warning: { severity: "warning", label: "주의" },
  neutral: { severity: "neutral", label: "안내" },
};

const severityClasses: Record<AdminSeverity, string> = {
  danger: styles.danger,
  success: styles.success,
  warning: styles.warning,
  neutral: styles.neutral,
};

const stockDetails: Record<StockStatus, { severity: AdminSeverity; label: string }> = {
  normal: { severity: "success", label: "정상" },
  low: { severity: "warning", label: "주의" },
  outOfStock: { severity: "neutral", label: "품절" },
  unknown: { severity: "warning", label: "확인 필요" },
};

/** Unknown or invalid quantities must never imply that stock is healthy. */
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
}: Readonly<AdminStatusBadgeProps>) {
  const details = statusDetails[status];
  return (
    <StatusBadge
      status={status}
      severity={details.severity}
      label={
        label && label !== details.label ? `${details.label} · ${label}` : details.label
      }
      className={className}
    >
      {children}
    </StatusBadge>
  );
}

export function StockStatusBadge({
  stock,
  className,
}: Readonly<StockStatusBadgeProps>) {
  const status = getStockStatus(stock);
  const details = stockDetails[status];
  return (
    <StatusBadge
      stockStatus={status}
      severity={details.severity}
      label={details.label}
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
}: Readonly<AdminNoticeProps>) {
  const details = statusDetails[status];
  // Only explicitly announced urgent or blocking errors interrupt a screen reader.
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
          {details.label}
          {title && title !== details.label ? ` · ${title}` : null}
        </strong>
        {children !== undefined && children !== null ? (
          <div className={styles.message}>{children}</div>
        ) : null}
      </div>
    </div>
  );
}
