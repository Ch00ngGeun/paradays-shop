import type { Locale } from "@/types/store";
import {
  validSalesDay,
  type DayReport,
  type SaleEntry,
  type SalesCommand,
  type StockPreview,
} from "@/lib/commerce/admin-sales-api-client";

export type Row = {
  productId: string | null;
  name: string;
  option: string;
  quantity: string;
  unitAmount: string;
};
export type Draft = {
  entryId: string;
  expectedVersion: number;
  soldAt: string;
  method: SaleEntry["method"];
  reference: string;
  amount: string;
  memo: string;
  lines: Row[];
};
export type Attempt = { day: string; command: SalesCommand };
export type Notice = string | Readonly<Record<Locale, string>>;
export type Preview = {
  entryId: string;
  version: number;
  previewToken: string;
  preview: readonly StockPreview[];
};
export const pendingListeners = new Set<() => void>();
export const pendingCache = new Map<
  string,
  { raw: string | null; value: Attempt | null }
>();
export const subscribePending = (notify: () => void) => {
  pendingListeners.add(notify);
  return () => {
    pendingListeners.delete(notify);
  };
};
export function readPending(key: string): Attempt | null {
  try {
    const raw = sessionStorage.getItem(key),
      cached = pendingCache.get(key);
    if (cached?.raw === raw) return cached.value;
    const parsed: unknown = JSON.parse(raw ?? "null");
    const value =
      parsed &&
      typeof parsed === "object" &&
      "day" in parsed &&
      validSalesDay(parsed.day) &&
      "command" in parsed &&
      parsed.command &&
      typeof parsed.command === "object" &&
      "action" in parsed.command &&
      ["save", "post", "void", "reverse", "close", "reopen"].includes(
        String(parsed.command.action),
      )
        ? (parsed as Attempt)
        : null;
    pendingCache.set(key, { raw, value });
    return value;
  } catch {
    return null;
  }
}
export const money = (n: number, locale: Locale = "ko") =>
  locale === "ko"
    ? `${n.toLocaleString("ko-KR")}원`
    : `KRW ${n.toLocaleString("en-US")}`;
export const localTime = (iso: string) =>
  new Date(Date.parse(iso) + 9 * 3_600_000).toISOString().slice(0, 16);
export const today = () => localTime(new Date().toISOString()).slice(0, 10);
export const initialTime = (day: string) =>
  day === today() ? localTime(new Date().toISOString()) : `${day}T12:00`;
export const showTime = (iso: string, locale: Locale = "ko") =>
  new Intl.DateTimeFormat(locale === "ko" ? "ko-KR" : "en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(iso));
export const newId = () => `sale_${crypto.randomUUID()}`;
export const statusLabels = {
  ko: { DRAFT: "작성 중", POSTED: "완료", VOID: "폐기" },
  en: { DRAFT: "Draft", POSTED: "Posted", VOID: "Voided" },
};
export const methodLabels = {
  ko: { CARD: "카드", CASH: "현금", TRANSFER: "이체" },
  en: { CARD: "Card", CASH: "Cash", TRANSFER: "Transfer" },
};
export const methodOrder = ["CARD", "CASH", "TRANSFER"] as const;
export const methodNet = (totals: DayReport["totals"], method: SaleEntry["method"]) =>
  method === "CARD"
    ? totals.card
    : method === "CASH"
      ? totals.cash
      : (totals.transfer ?? 0);
export const warnings: Record<Locale, Record<string, string>> = {
  ko: {
    UNPOSTED_SALES: "작성 중 전표가 남아 있습니다.",
    UNMATCHED_OR_AMOUNT_MISMATCH:
      "상품 미매칭 또는 줄 합계와 전표 금액이 다른 작성 중 전표가 있습니다.",
    ONLINE_REFUND_HISTORY_UNAVAILABLE:
      "온라인 환불의 날짜별 근거가 부족합니다. 확인 전 마감할 수 없습니다.",
    ONLINE_CHANGED_AFTER_CLOSE:
      "마감 이후 온라인 매출이 바뀌었습니다. 이전 마감표와 현재 합계를 대조해 주세요.",
    ONLINE_APPROVAL_HISTORY_UNAVAILABLE:
      "온라인 승인시각의 근거가 부족합니다. 확인 전 마감할 수 없습니다.",
    ONLINE_REFUND_RESULT_PENDING:
      "온라인 환불 결과가 확인 대기 중입니다. 확정된 금액만 합계에 포함했습니다.",
    ONLINE_PAYMENT_RESULT_PENDING:
      "온라인 결제 결과가 확인 대기 중입니다. 확정된 금액만 합계에 포함했습니다.",
  },
  en: {
    UNPOSTED_SALES: "Draft sales slips remain.",
    UNMATCHED_OR_AMOUNT_MISMATCH:
      "A draft slip has unmatched products or a line total that differs from the slip amount.",
    ONLINE_REFUND_HISTORY_UNAVAILABLE:
      "There is not enough per-day evidence for online refunds. You cannot close before checking.",
    ONLINE_CHANGED_AFTER_CLOSE:
      "Online sales changed after closing. Compare the previous closing sheet with the current totals.",
    ONLINE_APPROVAL_HISTORY_UNAVAILABLE:
      "There is not enough evidence for online approval times. You cannot close before checking.",
    ONLINE_REFUND_RESULT_PENDING:
      "Online refund results are pending. Only confirmed amounts are included in the totals.",
    ONLINE_PAYMENT_RESULT_PENDING:
      "Online payment results are pending. Only confirmed amounts are included in the totals.",
  },
};
export const onlineKind = (kind: string, locale: Locale) =>
  kind === "APPROVAL"
    ? locale === "ko"
      ? "승인"
      : "Approval"
    : locale === "ko"
      ? "환불"
      : "Refund";
export const timeBasis = (basis: string, locale: Locale) =>
  basis === "OBSERVED"
    ? locale === "ko"
      ? "서버 확인시각 기준"
      : "Server-observed time"
    : locale === "ko"
      ? "결제 제공자 시각 기준"
      : "Payment provider time";
/** 서버가 일마감에 붙이는 고정 사유만 번역함. 관리자가 입력한 재개방 사유는 데이터라 그대로 둠. */
export const historyReason = (
  h: Readonly<{ action: string; reason: string }>,
  locale: Locale,
) =>
  locale === "en" && h.action === "CLOSE" && h.reason === "매출 대조 확인"
    ? "Sales reconciliation confirmed"
    : h.reason;
export const lineSum = (rows: readonly Row[]) =>
  rows.reduce((s, l) => s + Number(l.quantity) * Number(l.unitAmount), 0);
export const draftOf = (e: SaleEntry): Draft => ({
  entryId: e.entryId,
  expectedVersion: e.version,
  soldAt: localTime(e.soldAt),
  method: e.method,
  reference: e.reference,
  amount: String(e.amount),
  memo: e.memo,
  lines: e.lines.map((l) => ({
    ...l,
    quantity: String(l.quantity),
    unitAmount: String(l.unitAmount),
  })),
});
export const isWhole = (v: string, min = 0, max = 100_000_000) =>
  v.trim() !== "" &&
  Number.isSafeInteger(Number(v)) &&
  Number(v) >= min &&
  Number(v) <= max;
