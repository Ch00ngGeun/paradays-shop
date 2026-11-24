"use client";
import adminSharedStyles from "./admin-shared.module.css";
import { useLocale } from "@/contexts/locale-context";
import { type AdminSection } from "@/lib/admin-ui/navigation";
import { getOcrInputErrorMessage } from "@/lib/admin-ui/ocr-input-validation";
import type { AdminProductDraft } from "@/lib/admin-ui/types";
import { getOcrRequestErrorMessage } from "@/lib/commerce/admin-api-client-ocr-errors";
import type { Locale } from "@/types/store";
import styles from "./admin-dashboard.module.css";
import { AdminMenuIcon } from "./admin-navigation";
import { AdminNotice, AdminStatusBadge } from "./admin-status";

/** 비동기 결과 문구는 두 언어를 함께 저장하고 화면에 그릴 때 현재 언어로 고릅니다. */
export type LocalizedText = string | Readonly<Record<Locale, string>>;

export function localizedText(text: LocalizedText, locale: Locale) {
  return typeof text === "string" ? text : text[locale];
}

export function localizedOcrRequestError(error: unknown): LocalizedText | undefined {
  const ko = getOcrRequestErrorMessage(error, "ko");
  const en = getOcrRequestErrorMessage(error, "en");
  return ko && en ? { ko, en } : undefined;
}

export function localizedOcrInputError(error: unknown): LocalizedText | undefined {
  const ko = getOcrInputErrorMessage(error, "ko");
  const en = getOcrInputErrorMessage(error, "en");
  return ko && en ? { ko, en } : undefined;
}

export type Notice =
  | Readonly<{ kind: "error"; message: LocalizedText }>
  | Readonly<{ kind: "success"; message: LocalizedText }>
  | null;

export type MarketingChannel = "email" | "sms" | "push";

export type OcrState = "idle" | "connection-needed" | "recognizing" | "review";

export type OperationActivity = Readonly<{
  key: string;
  section: AdminSection;
  status: "working" | "draft" | "complete" | "attention";
  detail: LocalizedText;
  at: number;
  editorId?: string;
}>;

export const operationStatusLabels = {
  ko: {
    working: "작업 중",
    draft: "임시저장",
    complete: "완료",
    attention: "확인 필요",
  },
  en: {
    working: "In progress",
    draft: "Draft",
    complete: "Done",
    attention: "Needs review",
  },
} as const;

/** Capture wall-clock time only when an administrator event is handled, never in render. */
export function operationEventTime() {
  return Date.now();
}

export const operationIconTone: Record<AdminSection, string> = {
  overview: "blue",
  products: "purple",
  inventory: "blue",
  sales: "green",
  brands: "purple",
  members: "purple",
  coupons: "amber",
  marketing: "blue",
  ocr: "green",
};

export const emptyProductDraft: AdminProductDraft = {
  name: "",
  brand: "",
  category: "Deck",
  sku: "",
  price: "",
  compareAtPrice: "",
  stock: "",
  imageUrl: "/images/product-placeholder.svg",
  sizes: "",
  description: "",
  // 실수로 미검토 상품이 고객에게 노출되지 않도록 새 상품은 초안으로 시작합니다.
  isVisible: false,
  isFeatured: false,
};

export const moneyFormatter = new Intl.NumberFormat("ko-KR", {
  style: "currency",
  currency: "KRW",
  maximumFractionDigits: 0,
});

export function MetricCard({
  icon,
  label,
  note,
  value,
}: Readonly<{ icon?: AdminSection; label: string; note: string; value: string }>) {
  return (
    <article className={styles.metricCard}>
      {icon ? (
        <div
          className={styles.metricIcon}
          data-tone={icon === "inventory" ? "purple" : operationIconTone[icon]}
        >
          <AdminMenuIcon section={icon} cart={icon === "overview"} />
        </div>
      ) : null}
      <p>{label}</p>
      <strong>{value}</strong>
      <span>{note}</span>
    </article>
  );
}

export function QuickAction({
  actionLabel,
  guide,
  icon,
  label,
  note,
  needsAttention = false,
  onClick,
  primary = false,
  value,
}: Readonly<{
  actionLabel: string;
  /** 화면 안내가 짚는 기준점 이름(data-admin-guide) */
  guide?: string;
  icon: AdminSection;
  label: string;
  note: string;
  needsAttention?: boolean;
  onClick: () => void;
  primary?: boolean;
  value?: string;
}>) {
  const { locale } = useLocale();
  return (
    <article className={styles.overviewTask} data-admin-guide={guide}>
      <div className={styles.taskIcon} data-tone={operationIconTone[icon]}>
        <AdminMenuIcon section={icon} />
      </div>
      <div className={adminSharedStyles.taskDescription}>
        <h3>
          {label}
          {value !== undefined ? (
            <span className={adminSharedStyles.taskCount}>{value}</span>
          ) : null}
          {needsAttention ? (
            <AdminStatusBadge locale={locale} status="attention" />
          ) : null}
        </h3>
        <p>{note}</p>
      </div>
      <button
        className={primary ? styles.primaryButton : styles.secondaryButton}
        onClick={onClick}
        type="button"
      >
        {actionLabel}
        <span aria-hidden="true">→</span>
      </button>
    </article>
  );
}

export function EmptyState({
  description,
  title,
}: Readonly<{ description: string; title: string }>) {
  return (
    <div className={styles.emptyState}>
      <strong>{title}</strong>
      <p>{description}</p>
    </div>
  );
}

export function NoticeMessage({ notice }: Readonly<{ notice: Exclude<Notice, null> }>) {
  const { locale } = useLocale();
  return (
    <div role={notice.kind === "error" ? "alert" : "status"}>
      <AdminNotice
        locale={locale}
        status={notice.kind === "error" ? "warning" : "neutral"}
      >
        {localizedText(notice.message, locale)}
      </AdminNotice>
    </div>
  );
}

export function channelLabel(channel: MarketingChannel, locale: Locale = "ko") {
  if (channel === "email") {
    return locale === "ko" ? "이메일" : "Email";
  }

  return channel === "sms" ? "SMS" : locale === "ko" ? "푸시" : "Push";
}

export function parsePositiveNumber(value: string) {
  const parsed = Number(value.replaceAll(",", ""));

  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function couponExpiryIso(value: string): string | undefined | null {
  if (!value) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const timestamp = Date.parse(`${value}+09:00`);
  if (!Number.isFinite(timestamp)) return null;
  const roundTrip = new Date(timestamp + 9 * 60 * 60 * 1_000)
    .toISOString()
    .slice(0, 16);
  return roundTrip === value ? new Date(timestamp).toISOString() : null;
}

export function campaignDraftValidation(
  title: string,
  body: string,
  channelCount: number,
): LocalizedText | null {
  if (channelCount < 1 || channelCount > 3)
    return {
      ko: "초안에 포함할 채널을 하나 이상 선택해 주세요.",
      en: "Select at least one channel to include in the draft.",
    };
  if (!title.trim() || title.trim().length > 160)
    return {
      ko: "캠페인 제목은 1–160자로 입력해 주세요.",
      en: "Enter a campaign title of 1–160 characters.",
    };
  if (!body.trim() || body.trim().length > 8_000)
    return {
      ko: "메시지는 1–8,000자로 입력해 주세요.",
      en: "Enter a message of 1–8,000 characters.",
    };
  return null;
}

export function couponDraftValidation(
  name: string,
  code: string,
  type: "percent" | "amount",
  value: string,
  expiresAt: string,
): LocalizedText | null {
  if (!name.trim() || name.trim().length > 120)
    return {
      ko: "쿠폰명은 1–120자로 입력해 주세요.",
      en: "Enter a coupon name of 1–120 characters.",
    };
  if (!/^[A-Z0-9][A-Z0-9_-]{2,31}$/.test(code.trim().toUpperCase()))
    return {
      ko: "쿠폰 코드는 영문·숫자로 시작하는 3–32자의 영문·숫자·_·-만 사용할 수 있습니다.",
      en: "A coupon code is 3–32 characters of letters, numbers, _ or -, starting with a letter or number.",
    };
  const amount = Number(value.trim());
  if (
    !/^\d+$/.test(value.trim()) ||
    !Number.isSafeInteger(amount) ||
    amount < 1 ||
    amount > (type === "percent" ? 100 : 100_000_000)
  )
    return type === "percent"
      ? {
          ko: "할인율은 1–100 사이의 정수만 입력해 주세요.",
          en: "Enter the discount rate as a whole number from 1 to 100.",
        }
      : {
          ko: "할인 금액은 1–100,000,000원 사이의 정수만 입력해 주세요.",
          en: "Enter the discount amount as a whole number from 1 to 100,000,000 KRW.",
        };
  if (couponExpiryIso(expiresAt) === null)
    return {
      ko: "만료 시각을 실제 존재하는 날짜와 한국 시간으로 입력해 주세요.",
      en: "Enter the expiry as a real date and time in Korea time.",
    };
  return null;
}
