"use client";
import { useRef, useState, useSyncExternalStore } from "react";
import { useAuth } from "@/contexts/auth-context";
import type { AdminCatalogListItem } from "@/lib/admin-ui/types";
import type { Locale } from "@/types/store";
import {
  AdminSalesError,
  createAdminSalesApiClient,
  validSalesDay,
  type DayReport,
  type SaleEntry,
  type SalesCommand,
  type StockPreview,
} from "@/lib/commerce/admin-sales-api-client";
import styles from "./admin-sales-ledger.module.css";
import { AdminSalesSimulationPanel } from "./admin-sales-simulation";
import { AdminStepper, type AdminStep } from "./admin-stepper";
import { AdminNotice } from "./admin-status";

type Row = {
  productId: string | null;
  name: string;
  option: string;
  quantity: string;
  unitAmount: string;
};
type Draft = {
  entryId: string;
  expectedVersion: number;
  soldAt: string;
  method: SaleEntry["method"];
  reference: string;
  amount: string;
  memo: string;
  lines: Row[];
};
type Attempt = { day: string; command: SalesCommand };
type Notice = string | Readonly<Record<Locale, string>>;
type Preview = {
  entryId: string;
  version: number;
  previewToken: string;
  preview: readonly StockPreview[];
};
const pendingListeners = new Set<() => void>();
const pendingCache = new Map<string, { raw: string | null; value: Attempt | null }>();
const subscribePending = (notify: () => void) => {
  pendingListeners.add(notify);
  return () => {
    pendingListeners.delete(notify);
  };
};
function readPending(key: string): Attempt | null {
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
const money = (n: number, locale: Locale = "ko") =>
  locale === "ko"
    ? `${n.toLocaleString("ko-KR")}원`
    : `KRW ${n.toLocaleString("en-US")}`;
const localTime = (iso: string) =>
  new Date(Date.parse(iso) + 9 * 3_600_000).toISOString().slice(0, 16);
const today = () => localTime(new Date().toISOString()).slice(0, 10);
const initialTime = (day: string) =>
  day === today() ? localTime(new Date().toISOString()) : `${day}T12:00`;
const showTime = (iso: string, locale: Locale = "ko") =>
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
const newId = () => `sale_${crypto.randomUUID()}`;
const statusLabels = {
  ko: { DRAFT: "작성 중", POSTED: "완료", VOID: "폐기" },
  en: { DRAFT: "Draft", POSTED: "Posted", VOID: "Voided" },
};
const methodLabels = {
  ko: { CARD: "카드", CASH: "현금", TRANSFER: "이체" },
  en: { CARD: "Card", CASH: "Cash", TRANSFER: "Transfer" },
};
const methodOrder = ["CARD", "CASH", "TRANSFER"] as const;
const methodNet = (totals: DayReport["totals"], method: SaleEntry["method"]) =>
  method === "CARD"
    ? totals.card
    : method === "CASH"
      ? totals.cash
      : (totals.transfer ?? 0);
const warnings: Record<Locale, Record<string, string>> = {
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
const onlineKind = (kind: string, locale: Locale) =>
  kind === "APPROVAL"
    ? locale === "ko"
      ? "승인"
      : "Approval"
    : locale === "ko"
      ? "환불"
      : "Refund";
const timeBasis = (basis: string, locale: Locale) =>
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
const lineSum = (rows: readonly Row[]) =>
  rows.reduce((s, l) => s + Number(l.quantity) * Number(l.unitAmount), 0);
const draftOf = (e: SaleEntry): Draft => ({
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
const isWhole = (v: string, min = 0, max = 100_000_000) =>
  v.trim() !== "" &&
  Number.isSafeInteger(Number(v)) &&
  Number(v) >= min &&
  Number(v) <= max;

/** Kept mounted by the dashboard so unresolved commands survive menu changes. */
export function AdminSalesLedgerPanel({
  products,
  locale = "ko",
}: Readonly<{ products: readonly AdminCatalogListItem[]; locale?: Locale }>) {
  const { isAuthenticated, status, user } = useAuth();
  if (status !== "authenticated" || !isAuthenticated || !user?.groups.includes("admin"))
    return null;
  return <SalesModeSession key={user.sub} products={products} locale={locale} />;
}
function SalesModeSession({
  products,
  locale,
}: Readonly<{ products: readonly AdminCatalogListItem[]; locale: Locale }>) {
  const isKorean = locale === "ko";
  const [mode, setMode] = useState<"choose" | "real" | "simulation">("choose");
  const [acknowledged, setAcknowledged] = useState(false);
  function chooseMode() {
    setMode("choose");
    setAcknowledged(false);
  }
  if (mode === "simulation")
    return (
      <section
        className={styles.simulationShell}
        aria-label={isKorean ? "모의 매출·일마감" : "Mock sales and daily close"}
      >
        <div className={styles.simulationModeBadge}>
          <span aria-hidden="true">◇</span>{" "}
          {isKorean ? "연습 중 · 실제 변경 없음" : "Practicing · No real changes"}
        </div>
        <AdminSalesSimulationPanel onExit={chooseMode} locale={locale} />
      </section>
    );
  if (mode === "real")
    return (
      <ActualSalesLedgerPanel products={products} onExit={chooseMode} locale={locale} />
    );
  return (
    <section className={styles.panel} aria-labelledby="sales-mode-title">
      <header className={styles.header}>
        <h2 id="sales-mode-title">
          {isKorean ? "매출·일마감 모드 선택" : "Choose sales and daily close mode"}
        </h2>
        <p>
          {isKorean
            ? "연습과 실제 운영을 구분해 시작하세요."
            : "Start by choosing practice or real operations."}
        </p>
      </header>
      <div className={styles.modeCards}>
        <section className={`${styles.block} ${styles.modeCard}`}>
          <span className={styles.simulationModeBadge}>
            <span aria-hidden="true">◇</span>{" "}
            {isKorean ? "실제 변경 없음" : "No real changes"}
          </span>
          <h3>{isKorean ? "연습하기" : "Practice"}</h3>
          <p>
            {isKorean
              ? "가상 상품으로 카드·현금·이체 판매부터 재고 반영·일마감까지 연습합니다."
              : "Practice card, cash and transfer sales through stock updates and daily close with virtual products."}
          </p>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            {isKorean
              ? "실제 장부와 재고를 바꾸지 않는 모의 체험임을 확인했습니다"
              : "I confirm this mock practice does not change the real ledger or stock"}
          </label>
          <button
            className={styles.primary}
            type="button"
            disabled={!acknowledged}
            onClick={() => {
              if (acknowledged) setMode("simulation");
            }}
          >
            {isKorean ? "모의 매출·일마감 체험" : "Try mock sales and daily close"}
          </button>
          <details className={styles.inlineHelp}>
            <summary>
              {isKorean ? "연습 데이터 보관 안내" : "Practice data storage"}
            </summary>
            <p>
              {isKorean
                ? "브라우저 메모리의 합성 TEST 상품·전표만 사용합니다. 메뉴 이동 시 유지되며 초기화·종료·새로고침·로그아웃·계정 교체 시 폐기됩니다. 실제 상품·장부·온라인 매출은 조회하거나 변경하지 않습니다."
                : "Uses only synthetic TEST products and slips in browser memory. They persist across menus and are discarded on reset, end, refresh, sign-out or account switch. Real products, ledger and online sales are never read or changed."}
            </p>
          </details>
        </section>
        <section className={`${styles.block} ${styles.modeCard}`}>
          <span className={styles.actualModeBadge}>
            <span aria-hidden="true">●</span>{" "}
            {isKorean ? "실제 장부·재고 변경" : "Changes real ledger and stock"}
          </span>
          <h3>{isKorean ? "실제 운영" : "Real operations"}</h3>
          <AdminNotice status="attention" locale={locale}>
            {isKorean
              ? "판매를 확정하면 실제 재고가 차감됩니다. 연습하려면 ‘연습하기’를 선택하세요."
              : "Posting a sale deducts real stock. To practice, choose ‘Practice’."}
          </AdminNotice>
          <p className={styles.muted}>
            {isKorean
              ? "기존 미확정 요청은 실제 운영에서 확인합니다."
              : "Check earlier unconfirmed requests in real operations."}
          </p>
          <button
            aria-label={
              isKorean
                ? "실제 운영 열기 · 실제 매출·일마감 열기"
                : "Open real operations · Open real sales and daily close"
            }
            className={styles.primary}
            type="button"
            onClick={() => setMode("real")}
          >
            {isKorean ? "실제 운영 열기" : "Open real operations"}
          </button>
        </section>
      </div>
    </section>
  );
}
function ActualSalesLedgerPanel({
  products,
  onExit,
  locale,
}: Readonly<{
  products: readonly AdminCatalogListItem[];
  onExit: () => void;
  locale: Locale;
}>) {
  const isKorean = locale === "ko";
  const { getAccessToken, user } = useAuth();
  const [day, setDay] = useState(today);
  const [report, setReport] = useState<DayReport | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [manualAmount, setManualAmount] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [stockConfirmed, setStockConfirmed] = useState(false);
  const [voidReason, setVoidReason] = useState("");
  const [reverseReason, setReverseReason] = useState("");
  const [reverseDay, setReverseDay] = useState(today);
  const [reverseTime, setReverseTime] = useState(() => initialTime(today()));
  const [reverseConfirmed, setReverseConfirmed] = useState(false);
  const [restock, setRestock] = useState(false);
  const [cashCompared, setCashCompared] = useState("");
  const [closeConfirmed, setCloseConfirmed] = useState(false);
  const [reopenReason, setReopenReason] = useState("");
  const [memoryAttempt, setMemoryAttempt] = useState<Attempt | null>(null);
  const [resolutionRead, setResolutionRead] = useState(false);
  const [resolutionConfirmed, setResolutionConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [observedNow, setObservedNow] = useState(Date.now);
  const busyRef = useRef(false);
  const [notice, setNotice] = useState<Notice>("");
  const [noticeKind, setNoticeKind] = useState<"neutral" | "attention">("neutral");
  const storageKey = `paradays.admin-sales.pending.${user?.sub ?? "admin"}`;
  const storedAttempt = useSyncExternalStore(
    subscribePending,
    () => readPending(storageKey),
    () => null,
  );
  const attempt = storedAttempt ?? memoryAttempt;
  const selected = report?.entries.find((e) => e.entryId === selectedId);
  const locked = busy || !!attempt;
  const open = report?.status === "OPEN";
  const client = () =>
    createAdminSalesApiClient({ authorizationTokenProvider: { getAccessToken } });
  function remember(value: Attempt | null) {
    setMemoryAttempt(value);
    try {
      if (value) sessionStorage.setItem(storageKey, JSON.stringify(value));
      else sessionStorage.removeItem(storageKey);
    } catch {
      /* The in-memory lock still protects this mounted panel. */
    }
    for (const notify of pendingListeners) notify();
  }
  function clearConfirmation() {
    setPreview(null);
    setStockConfirmed(false);
    setVoidReason("");
    setReverseReason("");
    setRestock(false);
    setReverseConfirmed(false);
    setCloseConfirmed(false);
    setCashCompared("");
    setReopenReason("");
  }
  function selectEntry(e: SaleEntry) {
    if (locked) return;
    setSelectedId(e.entryId);
    setDraft(e.status === "DRAFT" ? draftOf(e) : null);
    setManualAmount(true);
    setSearch("");
    clearConfirmation();
    setReverseDay(today());
    setReverseTime(initialTime(today()));
  }
  async function load(resolving = false) {
    if (busyRef.current) return;
    const pending = attempt;
    const targetDay = pending?.day ?? day;
    setObservedNow(Date.now());
    busyRef.current = true;
    setBusy(true);
    setNotice("");
    setNoticeKind("neutral");
    setResolutionConfirmed(false);
    try {
      const next = await client().getDay(targetDay);
      setDay(targetDay);
      setReport(next);
      setDraft(null);
      setSelectedId(null);
      clearConfirmation();
      if (pending || resolving) {
        setResolutionRead(true);
        setNotice({
          ko: "장부를 다시 조회했습니다. 미확정 요청의 전표·마감 상태를 직접 확인한 뒤 잠금을 해제하거나 같은 요청을 재시도해 주세요.",
          en: "Reloaded the ledger. Check the slip and close status of the unconfirmed request yourself, then release the lock or retry the same request.",
        });
      } else
        setNotice({
          ko: "한국 시간 기준 장부를 조회했습니다.",
          en: "Loaded the ledger in Korea time.",
        });
    } catch {
      setReport(null);
      setNoticeKind("attention");
      setNotice({
        ko: "장부를 조회하지 못했습니다. 로그인·권한·연결을 확인하고 다시 조회해 주세요. 미완료 집계로 마감하지 않습니다.",
        en: "Could not load the ledger. Check sign-in, permissions and connection, then load again. Incomplete totals are never closed.",
      });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  async function run(targetDay: string, command: SalesCommand, retry = false) {
    if (busyRef.current || (attempt && !retry)) return;
    const frozen = JSON.parse(JSON.stringify(command)) as SalesCommand;
    setObservedNow(Date.now());
    const mutation = frozen.action !== "preview";
    busyRef.current = true;
    setBusy(true);
    setNotice("");
    setNoticeKind("neutral");
    setResolutionRead(false);
    setResolutionConfirmed(false);
    if (mutation && !retry) remember({ day: targetDay, command: frozen });
    try {
      const result = await client().operate(targetDay, frozen);
      if ("preview" in result) {
        setPreview(result);
        setStockConfirmed(false);
        setNoticeKind("attention");
        setNotice({
          ko: "아래 재고 변동을 확인한 뒤 판매를 확정해 주세요.",
          en: "Check the stock changes below, then post the sale.",
        });
        return;
      }
      remember(null);
      clearConfirmation();
      if ("report" in result) {
        setReport(result.report);
        setDraft(null);
        setSelectedId(null);
      } else {
        setSelectedId(result.entry.entryId);
        setDraft(result.entry.status === "DRAFT" ? draftOf(result.entry) : null);
        setManualAmount(true);
        try {
          setReport(await client().getDay(targetDay));
        } catch {
          setReport(null);
          setNoticeKind("attention");
          setNotice({
            ko: "요청 처리 응답은 확인했습니다. 최신 합계 조회가 실패했으므로 장부를 다시 조회해 주세요.",
            en: "The request response was confirmed, but loading the latest totals failed. Load the ledger again.",
          });
          return;
        }
      }
      setDay(targetDay);
      setNotice(
        frozen.action === "save"
          ? {
              ko: "초안을 보관했습니다. 아직 매출·재고에 반영되지 않았습니다.",
              en: "Saved the draft. It is not yet reflected in sales or stock.",
            }
          : {
              ko: "처리 결과를 서버 장부에서 확인했습니다.",
              en: "Confirmed the result in the server ledger.",
            },
      );
    } catch (error) {
      const uncertain =
        mutation && (!(error instanceof AdminSalesError) || error.resultUncertain);
      if (!uncertain) remember(null);
      setNoticeKind("attention");
      setNotice(
        uncertain
          ? {
              ko: "처리 결과가 확정되지 않았습니다. 다른 쓰기를 잠갔습니다. 같은 요청 재시도 또는 결과 재조회로 확인해 주세요.",
              en: "The result is not confirmed. Other writes are locked. Check by retrying the same request or reloading the result.",
            }
          : error instanceof AdminSalesError && error.status === 401
            ? { ko: "관리자 로그인이 필요합니다.", en: "Admin sign-in is required." }
            : {
                ko: `요청이 거절되었습니다${error instanceof AdminSalesError ? ` (${error.code})` : ""}. 최신 장부와 입력값을 확인해 주세요.`,
                en: `The request was rejected${error instanceof AdminSalesError ? ` (${error.code})` : ""}. Check the latest ledger and your input.`,
              },
      );
      setPreview(null);
      setStockConfirmed(false);
      setCloseConfirmed(false);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  function updateDraft(patch: Partial<Draft>) {
    setDraft((current) => (current ? { ...current, ...patch } : null));
    setPreview(null);
    setStockConfirmed(false);
  }
  function updateRows(lines: Row[]) {
    if (!draft) return;
    updateDraft({
      lines,
      ...(!manualAmount ? { amount: String(lineSum(lines)) } : {}),
    });
  }
  const draftValid =
    !!draft &&
    draft.soldAt.startsWith(`${day}T`) &&
    Number.isFinite(Date.parse(`${draft.soldAt}+09:00`)) &&
    Date.parse(`${draft.soldAt}+09:00`) <= observedNow &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]{2,63}$/.test(draft.reference) &&
    isWhole(draft.amount, 1) &&
    draft.lines.every((l) => isWhole(l.quantity, 1, 10_000) && isWhole(l.unitAmount));
  const unmatched =
    !!draft &&
    (!draft.lines.length ||
      draft.lines.some((l) => !l.productId || !l.name.trim() || !l.option));
  const mismatched = !!draft && lineSum(draft.lines) !== Number(draft.amount);
  const unsaved =
    !!draft &&
    (!selected || JSON.stringify(draft) !== JSON.stringify(draftOf(selected)));
  const results = search.trim()
    ? products
        .filter((p) =>
          p.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
        )
        .slice(0, 12)
    : [];
  const canClose =
    open &&
    report.complete &&
    !report.warnings.length &&
    !report.entries.some((e) => e.status === "DRAFT") &&
    cashCompared.trim() !== "" &&
    Number.isSafeInteger(Number(cashCompared)) &&
    Number(cashCompared) === report.totals.cash &&
    closeConfirmed &&
    !locked;
  const hasDrafts = !!report?.entries.some((e) => e.status === "DRAFT");
  const closed = report?.status === "CLOSED";
  const ledgerSteps: AdminStep[] = [
    {
      label: isKorean ? "장부 조회" : "Load ledger",
      state: report ? "complete" : "current",
    },
    {
      label: isKorean ? "판매 전표 정리" : "Settle sales slips",
      state: !report ? "upcoming" : hasDrafts ? "current" : "complete",
    },
    {
      label: isKorean ? "일마감" : "Daily close",
      state: !report || hasDrafts ? "upcoming" : closed ? "complete" : "current",
    },
  ];
  return (
    <section className={styles.panel} aria-labelledby="sales-ledger-title">
      <AdminStepper
        label={isKorean ? "실제 매출 작업 흐름" : "Real sales workflow"}
        steps={ledgerSteps}
        locale={locale}
      />
      <header className={styles.header}>
        <div>
          <div className={styles.titleRow}>
            <h2 id="sales-ledger-title">
              {isKorean ? "매출·일마감 관리" : "Sales and daily close"}
            </h2>
            <span className={styles.actualModeBadge}>
              <span aria-hidden="true">●</span>{" "}
              {isKorean
                ? "실제 운영 · 장부·재고 변경"
                : "Real operations · Changes ledger and stock"}
            </span>
          </div>
          <p>
            {isKorean
              ? "카드·현금·이체 전표와 하루 매출을 대조합니다. 날짜·시각은 한국 시간입니다."
              : "Reconcile card, cash and transfer slips with the day's sales. Dates and times are in Korea time."}
          </p>
        </div>
        <button
          type="button"
          disabled={locked}
          onClick={() => {
            if (!busyRef.current && !attempt) onExit();
          }}
        >
          {isKorean ? "모드 선택으로 돌아가기" : "Back to mode selection"}
        </button>
      </header>
      {locked ? (
        <AdminNotice status="neutral" locale={locale}>
          {isKorean
            ? "실제 요청이 진행 중이거나 결과 확인 대기 중입니다. 요청을 정리한 뒤 모드를 변경할 수 있습니다."
            : "A real request is in progress or awaiting its result. Resolve it before changing modes."}
        </AdminNotice>
      ) : null}
      <form
        className={styles.toolbar}
        onSubmit={(e) => {
          e.preventDefault();
          void load();
        }}
      >
        <label>
          {isKorean ? "영업일 (한국 시간)" : "Business day (Korea time)"}
          <input
            type="date"
            value={day}
            max={today()}
            disabled={locked}
            required
            onChange={(e) => {
              setDay(e.target.value);
              setReport(null);
              setDraft(null);
              setSelectedId(null);
              clearConfirmation();
            }}
          />
        </label>
        <button type="submit" disabled={locked || !validSalesDay(day)}>
          {isKorean ? "장부 조회" : "Load ledger"}
        </button>
      </form>
      {notice ? (
        <div role="status">
          <AdminNotice status={noticeKind} locale={locale}>
            {typeof notice === "string" ? notice : notice[locale]}
          </AdminNotice>
        </div>
      ) : null}
      {attempt ? (
        <section
          aria-label={isKorean ? "미확정 요청 보호" : "Unconfirmed request protection"}
        >
          <AdminNotice status="blocking" locale={locale}>
            <h3>{isKorean ? "처리 결과 확인 필요" : "Result check needed"}</h3>
            <p>
              {isKorean ? "영업일" : "Business day"} {attempt.day} ·{" "}
              {isKorean ? "요청" : "Request"} {attempt.command.action} ·{" "}
              {"entryId" in attempt.command
                ? attempt.command.entryId
                : attempt.command.operationId}
            </p>
            <p>
              {isKorean
                ? "입력 변경·다른 전표 처리·마감을 잠갔습니다. 원래 요청의 번호와 내용을 그대로 유지합니다."
                : "Input changes, other slips and closing are locked. The original request number and content are kept as is."}
            </p>
            <div className={styles.actions}>
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(attempt.day, attempt.command, true)}
              >
                {isKorean ? "같은 요청 재시도" : "Retry the same request"}
              </button>
              <button type="button" disabled={busy} onClick={() => void load(true)}>
                {isKorean ? "결과 재조회" : "Reload result"}
              </button>
            </div>
            <label className={styles.check}>
              <input
                type="checkbox"
                checked={resolutionConfirmed}
                disabled={!resolutionRead || busy}
                onChange={(e) => setResolutionConfirmed(e.target.checked)}
              />
              {isKorean
                ? "재조회한 장부에서 처리 결과를 직접 확인했습니다"
                : "I checked the result myself in the reloaded ledger"}
            </label>
            <button
              type="button"
              disabled={!resolutionRead || !resolutionConfirmed || busy}
              onClick={() => {
                remember(null);
                setDraft(null);
                setSelectedId(null);
                setNoticeKind("neutral");
                setNotice({
                  ko: "직접 확인한 결과에 따라 미확정 요청 잠금을 해제했습니다. 필요한 전표를 다시 선택해 주세요.",
                  en: "Released the unconfirmed request lock based on your check. Select the slip you need again.",
                });
              }}
            >
              {isKorean ? "미확정 요청 잠금 해제" : "Release unconfirmed request lock"}
            </button>
          </AdminNotice>
        </section>
      ) : null}
      {report ? (
        <div className={styles.reportStack}>
          <div className={styles.dayStatus}>
            <h3>
              {report.businessDay} ·{" "}
              {report.status === "CLOSED"
                ? isKorean
                  ? "마감 완료"
                  : "Closed"
                : isKorean
                  ? "영업 중"
                  : "Open"}
            </h3>
            <span>
              {isKorean ? "조회 기준" : "As of"} {showTime(report.asOf, locale)} ·{" "}
              {isKorean ? "버전" : "Version"} {report.version}
            </span>
          </div>
          <div
            className={styles.summaryGrid}
            aria-label={isKorean ? "확정 순매출 요약" : "Confirmed net sales summary"}
          >
            <article>
              <span aria-hidden="true" className={styles.metricSymbol}>
                ↗
              </span>
              <span>{isKorean ? "온라인 순매출" : "Online net sales"}</span>
              <strong>{money(report.totals.onlineNet, locale)}</strong>
            </article>
            <article>
              <span aria-hidden="true" className={styles.metricSymbol}>
                ▣
              </span>
              <span>
                {isKorean ? "오프라인 카드 순매출" : "Offline card net sales"}
              </span>
              <strong>{money(report.totals.card, locale)}</strong>
            </article>
            <article>
              <span aria-hidden="true" className={styles.metricSymbol}>
                ▤
              </span>
              <span>
                {isKorean ? "오프라인 현금 순매출" : "Offline cash net sales"}
              </span>
              <strong>{money(report.totals.cash, locale)}</strong>
            </article>
            <article>
              <span aria-hidden="true" className={styles.metricSymbol}>
                ⇄
              </span>
              <span>
                {isKorean ? "오프라인 이체 순매출" : "Offline transfer net sales"}
              </span>
              <strong>{money(report.totals.transfer ?? 0, locale)}</strong>
            </article>
            <article>
              <span aria-hidden="true" className={styles.metricSymbol}>
                Σ
              </span>
              <span>{isKorean ? "통합 순매출" : "Combined net sales"}</span>
              <strong>{money(report.totals.combinedNet, locale)}</strong>
            </article>
          </div>
          {report.warnings.length ? (
            <div aria-label={isKorean ? "마감 경고" : "Closing warnings"}>
              <AdminNotice
                status="attention"
                title={isKorean ? "마감 전 확인 필요" : "Check before closing"}
                locale={locale}
              >
                <ul>
                  {report.warnings.map((w) => (
                    <li key={w}>{warnings[locale][w] ?? w}</li>
                  ))}
                </ul>
              </AdminNotice>
            </div>
          ) : null}
          {!report.complete ? (
            <AdminNotice status="attention" locale={locale}>
              {isKorean
                ? "집계가 완료되지 않았습니다. 최신 장부를 다시 조회한 뒤 마감해 주세요."
                : "Totals are not complete. Reload the latest ledger before closing."}
            </AdminNotice>
          ) : null}
          <details className={`${styles.block} ${styles.reconciliationDetails}`}>
            <summary>
              {isKorean
                ? "확정 매출 대조표·집계 기준"
                : "Confirmed sales reconciliation · Totals basis"}
            </summary>
            <div className={styles.tableWrap}>
              <table>
                <caption>
                  {isKorean
                    ? "확정 매출 대조표 · 원화"
                    : "Confirmed sales reconciliation · KRW"}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">{isKorean ? "구분" : "Type"}</th>
                    <th scope="col">{isKorean ? "총매출" : "Gross sales"}</th>
                    <th scope="col">
                      {isKorean ? "반대전표·환불" : "Reversals · Refunds"}
                    </th>
                    <th scope="col">{isKorean ? "순매출" : "Net sales"}</th>
                  </tr>
                </thead>
                <tbody>
                  {methodOrder.map((method) => {
                    const sales = report.entries.filter(
                      (e) => e.status === "POSTED" && e.method === method,
                    );
                    const gross = sales
                        .filter((e) => e.kind === "SALE")
                        .reduce((s, e) => s + e.amount, 0),
                      refunds = sales
                        .filter((e) => e.kind === "REVERSAL")
                        .reduce((s, e) => s + e.amount, 0);
                    return (
                      <tr key={method}>
                        <th scope="row">
                          {isKorean ? "오프라인" : "Offline"}{" "}
                          {methodLabels[locale][method]}
                        </th>
                        <td>{money(gross, locale)}</td>
                        <td>{money(refunds, locale)}</td>
                        <td>{money(methodNet(report.totals, method), locale)}</td>
                      </tr>
                    );
                  })}
                  <tr>
                    <th scope="row">{isKorean ? "오프라인 합계" : "Offline total"}</th>
                    <td>
                      {money(
                        report.totals.offlineNet + report.totals.offlineRefunds,
                        locale,
                      )}
                    </td>
                    <td>{money(report.totals.offlineRefunds, locale)}</td>
                    <td>{money(report.totals.offlineNet, locale)}</td>
                  </tr>
                  <tr>
                    <th scope="row">{isKorean ? "온라인" : "Online"}</th>
                    <td>{money(report.totals.onlineGross, locale)}</td>
                    <td>{money(report.totals.onlineRefunds, locale)}</td>
                    <td>{money(report.totals.onlineNet, locale)}</td>
                  </tr>
                  <tr className={styles.total}>
                    <th scope="row">
                      {isKorean ? "온·오프라인 통합" : "Online and offline combined"}
                    </th>
                    <td>
                      {money(
                        report.totals.offlineNet +
                          report.totals.offlineRefunds +
                          report.totals.onlineGross,
                        locale,
                      )}
                    </td>
                    <td>
                      {money(
                        report.totals.offlineRefunds + report.totals.onlineRefunds,
                        locale,
                      )}
                    </td>
                    <td>{money(report.totals.combinedNet, locale)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p>
              {isKorean
                ? "미확인 거래는 합계에서 제외됩니다. 일마감 전에 결제·환불 결과를 확정해야 합니다."
                : "Unconfirmed transactions are excluded from totals. Payment and refund results must be confirmed before the daily close."}
            </p>
            <p>
              {isKorean
                ? "이 장부는 온라인+오프라인 통합 승인 총액·환불·순매출 기준입니다. 홈의 오늘 매출은 기존 현재 PAID 온라인 주문 요약 기준이므로 이 장부의 통합 합계와 다릅니다."
                : "This ledger is based on combined online and offline approved totals, refunds and net sales. Today's sales on the home screen use the current PAID online order summary, so they differ from this ledger's combined total."}
            </p>
          </details>
          <div className={styles.ledgerWorkspace}>
            <div className={styles.ledgerMain}>
              <section className={styles.block}>
                <div className={styles.headingRow}>
                  <h3>
                    {isKorean
                      ? "오프라인 전표 · 판매 시간순"
                      : "Offline slips · By sale time"}
                  </h3>
                  <button
                    aria-label={
                      isKorean ? "판매 등록 · 새 전표" : "Register sale · New slip"
                    }
                    className={styles.primary}
                    type="button"
                    disabled={!open || locked}
                    onClick={() => {
                      setObservedNow(Date.now());
                      setSelectedId(null);
                      setDraft({
                        entryId: newId(),
                        expectedVersion: 0,
                        soldAt: initialTime(day),
                        method: "CARD",
                        reference: "",
                        amount: "",
                        memo: "",
                        lines: [],
                      });
                      setManualAmount(false);
                      setSearch("");
                      clearConfirmation();
                    }}
                  >
                    <span aria-hidden="true">＋</span>{" "}
                    {isKorean ? "판매 등록" : "Register sale"}
                  </button>
                </div>
                <p>
                  {isKorean
                    ? "작성 중·폐기 전표는 합계에서 제외됩니다. 카드번호·고객 개인정보는 입력하지 마세요."
                    : "Draft and voided slips are excluded from totals. Do not enter card numbers or customer personal data."}
                </p>
                <div className={styles.tableWrap}>
                  <table>
                    <caption>
                      {isKorean ? "오프라인 판매 전표" : "Offline sales slips"}
                    </caption>
                    <thead>
                      <tr>
                        <th>
                          {isKorean ? "판매시각 (한국 시간)" : "Sale time (Korea time)"}
                        </th>
                        <th>{isKorean ? "구분" : "Type"}</th>
                        <th>{isKorean ? "전표" : "Slip"}</th>
                        <th>{isKorean ? "금액" : "Amount"}</th>
                        <th>{isKorean ? "상태" : "Status"}</th>
                        <th>{isKorean ? "열기" : "Open"}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.entries.map((e) => (
                        <tr key={e.entryId} data-testid={`ledger-entry-${e.entryId}`}>
                          <td>{showTime(e.soldAt, locale)}</td>
                          <td>
                            <span className={styles.methodChip} data-method={e.method}>
                              {methodLabels[locale][e.method]}
                            </span>{" "}
                            {e.kind === "REVERSAL"
                              ? isKorean
                                ? "반대전표"
                                : "Reversal"
                              : isKorean
                                ? "판매"
                                : "Sale"}
                          </td>
                          <td>
                            <strong>{e.reference}</strong>
                            <span className={styles.entryProductSummary}>
                              {e.lines
                                .slice(0, 2)
                                .map(
                                  (line) =>
                                    `${line.name || (isKorean ? "미매칭" : "Unmatched")} · ${isKorean ? `${line.quantity}개` : `×${line.quantity}`}`,
                                )
                                .join(" / ")}
                              {e.lines.length > 2
                                ? isKorean
                                  ? ` 외 ${e.lines.length - 2}줄`
                                  : ` +${e.lines.length - 2} more`
                                : ""}
                            </span>
                          </td>
                          <td>
                            {money(
                              e.kind === "REVERSAL" ? -e.amount : e.amount,
                              locale,
                            )}
                          </td>
                          <td>
                            <span className={styles.entryStatus} data-state={e.status}>
                              {statusLabels[locale][e.status]}
                            </span>
                          </td>
                          <td>
                            <button
                              type="button"
                              aria-label={
                                isKorean
                                  ? `${e.status === "DRAFT" ? "이어서 작성" : "상세"} · ${e.entryId} 전표 선택`
                                  : `${e.status === "DRAFT" ? "Continue editing" : "Details"} · Select slip ${e.entryId}`
                              }
                              disabled={locked}
                              onClick={() => {
                                setObservedNow(Date.now());
                                selectEntry(e);
                              }}
                            >
                              {e.status === "DRAFT"
                                ? isKorean
                                  ? "이어서 작성"
                                  : "Continue editing"
                                : isKorean
                                  ? "상세"
                                  : "Details"}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!report.entries.length ? (
                    <p>
                      {isKorean ? "등록된 전표가 없습니다." : "No slips registered."}
                    </p>
                  ) : null}
                </div>
                <ol
                  className={styles.workflow}
                  aria-label={isKorean ? "판매 등록 순서" : "Sale registration steps"}
                >
                  <li aria-current={draft && !preview ? "step" : undefined}>
                    <span>1</span> {isKorean ? "판매 입력" : "Enter sale"}
                  </li>
                  <li aria-current={preview ? "step" : undefined}>
                    <span>2</span> {isKorean ? "재고 확인" : "Check stock"}
                  </li>
                  <li>
                    <span>3</span> {isKorean ? "판매 확정" : "Post sale"}
                  </li>
                </ol>
              </section>
              {draft ? (
                <section
                  className={styles.block}
                  aria-label={isKorean ? "판매 전표 편집" : "Edit sales slip"}
                >
                  <h3>
                    {draft.expectedVersion
                      ? isKorean
                        ? "작성 중 전표 수정"
                        : "Edit draft slip"
                      : isKorean
                        ? "새 판매 전표"
                        : "New sales slip"}
                  </h3>
                  <p className={styles.muted}>
                    {isKorean
                      ? `전표 번호 ${draft.entryId} · 저장은 작성 중 상태이며 재고를 바꾸지 않습니다.`
                      : `Slip number ${draft.entryId} · Saving keeps it as a draft and does not change stock.`}
                  </p>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (!draftValid) return;
                      void run(day, {
                        action: "save",
                        ...draft,
                        soldAt: `${draft.soldAt}+09:00`,
                        amount: Number(draft.amount),
                        lines: draft.lines.map((l) => ({
                          ...l,
                          quantity: Number(l.quantity),
                          unitAmount: Number(l.unitAmount),
                        })),
                      });
                    }}
                  >
                    <fieldset disabled={locked || !open} className={styles.fieldset}>
                      <div className={styles.fields}>
                        <label>
                          {isKorean
                            ? "판매일시 (한국 시간)"
                            : "Sale date and time (Korea time)"}
                          <input
                            type="datetime-local"
                            value={draft.soldAt}
                            min={`${day}T00:00`}
                            max={day === today() ? initialTime(day) : `${day}T23:59`}
                            required
                            onChange={(e) => {
                              setObservedNow(Date.now());
                              updateDraft({ soldAt: e.target.value });
                            }}
                          />
                        </label>
                        <label>
                          {isKorean ? "결제 구분" : "Payment method"}
                          <select
                            value={draft.method}
                            onChange={(e) =>
                              updateDraft({ method: e.target.value as Draft["method"] })
                            }
                          >
                            {methodOrder.map((method) => (
                              <option key={method} value={method}>
                                {methodLabels[locale][method]}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          {isKorean ? "전표 참조번호" : "Slip reference number"}
                          <input
                            value={draft.reference}
                            maxLength={64}
                            required
                            placeholder="CARD-001 / CASH-001 / TRANSFER-001"
                            onChange={(e) => updateDraft({ reference: e.target.value })}
                          />
                        </label>
                        <label>
                          {isKorean ? "전표 금액" : "Slip amount"}
                          <input
                            type="number"
                            min="1"
                            max="100000000"
                            step="1"
                            required
                            value={draft.amount}
                            onChange={(e) => {
                              setManualAmount(true);
                              updateDraft({ amount: e.target.value });
                            }}
                          />
                        </label>
                        <label className={styles.wide}>
                          {isKorean ? "메모" : "Memo"}
                          <textarea
                            value={draft.memo}
                            maxLength={300}
                            onChange={(e) => updateDraft({ memo: e.target.value })}
                          />
                        </label>
                      </div>
                      <div className={styles.matching}>
                        <label>
                          {isKorean ? "상품 이름 검색" : "Search product name"}
                          <input
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            placeholder={
                              isKorean ? "상품명을 입력하세요" : "Enter a product name"
                            }
                          />
                        </label>
                        <div className={styles.searchResults}>
                          {results.map((p) => (
                            <button
                              type="button"
                              key={p.id}
                              disabled={draft.lines.length >= 20}
                              onClick={() => {
                                const options = p.sizes
                                  .split(",")
                                  .map((s) => s.trim())
                                  .filter(Boolean);
                                updateRows([
                                  ...draft.lines,
                                  {
                                    productId: p.id,
                                    // The ledger server refuses control characters, so a two-line product name becomes one line.
                                    name: p.name.replace(/\s+/g, " ").trim(),
                                    option: options.length === 1 ? options[0] : "",
                                    quantity: "1",
                                    unitAmount: String(p.price),
                                  },
                                ]);
                                setSearch("");
                              }}
                            >
                              {p.name} {isKorean ? "연결" : "link"}
                            </button>
                          ))}
                        </div>
                        <button
                          type="button"
                          disabled={draft.lines.length >= 20}
                          onClick={() =>
                            updateRows([
                              ...draft.lines,
                              {
                                productId: null,
                                name: "",
                                option: "",
                                quantity: "1",
                                unitAmount: "0",
                              },
                            ])
                          }
                        >
                          {isKorean ? "미매칭 줄 추가" : "Add unmatched line"}
                        </button>
                      </div>
                      <div className={styles.lines}>
                        {draft.lines.map((l, index) => {
                          const p = products.find((p) => p.id === l.productId);
                          return (
                            <div className={styles.line} key={index}>
                              <strong>
                                {index + 1} ·{" "}
                                {l.productId
                                  ? isKorean
                                    ? "상품 연결됨"
                                    : "Product linked"
                                  : isKorean
                                    ? "미매칭 · 재고 반영 불가"
                                    : "Unmatched · Cannot update stock"}
                              </strong>
                              <label>
                                {isKorean
                                  ? `${index + 1}번 상품명`
                                  : `Line ${index + 1} product name`}
                                <input
                                  value={l.name}
                                  maxLength={160}
                                  readOnly={!!l.productId}
                                  onChange={(e) =>
                                    updateRows(
                                      draft.lines.map((r, n) =>
                                        n === index
                                          ? { ...r, name: e.target.value }
                                          : r,
                                      ),
                                    )
                                  }
                                />
                              </label>
                              <label>
                                {isKorean
                                  ? `${index + 1}번 옵션`
                                  : `Line ${index + 1} option`}
                                {p ? (
                                  <select
                                    value={l.option}
                                    onChange={(e) =>
                                      updateRows(
                                        draft.lines.map((r, n) =>
                                          n === index
                                            ? { ...r, option: e.target.value }
                                            : r,
                                        ),
                                      )
                                    }
                                  >
                                    <option value="">
                                      {isKorean ? "옵션 선택" : "Select option"}
                                    </option>
                                    {p.sizes
                                      .split(",")
                                      .map((s) => s.trim())
                                      .filter(Boolean)
                                      .map((s) => (
                                        <option key={s} value={s}>
                                          {s}
                                        </option>
                                      ))}
                                  </select>
                                ) : (
                                  <input
                                    value={l.option}
                                    maxLength={50}
                                    onChange={(e) =>
                                      updateRows(
                                        draft.lines.map((r, n) =>
                                          n === index
                                            ? { ...r, option: e.target.value }
                                            : r,
                                        ),
                                      )
                                    }
                                  />
                                )}
                              </label>
                              <label>
                                {isKorean
                                  ? `${index + 1}번 수량`
                                  : `Line ${index + 1} quantity`}
                                <input
                                  type="number"
                                  value={l.quantity}
                                  min="1"
                                  max="10000"
                                  step="1"
                                  required
                                  onChange={(e) =>
                                    updateRows(
                                      draft.lines.map((r, n) =>
                                        n === index
                                          ? { ...r, quantity: e.target.value }
                                          : r,
                                      ),
                                    )
                                  }
                                />
                              </label>
                              <label>
                                {isKorean
                                  ? `${index + 1}번 단가`
                                  : `Line ${index + 1} unit price`}
                                <input
                                  type="number"
                                  value={l.unitAmount}
                                  min="0"
                                  max="100000000"
                                  step="1"
                                  required
                                  onChange={(e) =>
                                    updateRows(
                                      draft.lines.map((r, n) =>
                                        n === index
                                          ? { ...r, unitAmount: e.target.value }
                                          : r,
                                      ),
                                    )
                                  }
                                />
                              </label>
                              <button
                                type="button"
                                aria-label={
                                  isKorean
                                    ? `${index + 1}번 줄 삭제`
                                    : `Delete line ${index + 1}`
                                }
                                onClick={() =>
                                  updateRows(draft.lines.filter((_, n) => n !== index))
                                }
                              >
                                {isKorean ? "줄 삭제" : "Delete line"}
                              </button>
                            </div>
                          );
                        })}
                      </div>
                      <p>
                        {isKorean ? "상품 줄 합계" : "Line total"}{" "}
                        {money(lineSum(draft.lines), locale)}{" "}
                        <button
                          type="button"
                          disabled={!draft.lines.length}
                          onClick={() => {
                            setManualAmount(false);
                            updateDraft({ amount: String(lineSum(draft.lines)) });
                          }}
                        >
                          {isKorean
                            ? "줄 합계를 전표 금액에 적용"
                            : "Apply line total to slip amount"}
                        </button>
                      </p>
                      {unmatched ? (
                        <AdminNotice status="warning" locale={locale}>
                          {isKorean
                            ? "미매칭 상품·옵션이 있습니다. 초안 보관은 가능하며 재고 반영 전 연결해야 합니다."
                            : "There are unmatched products or options. You can save the draft, but link them before updating stock."}
                        </AdminNotice>
                      ) : null}
                      {mismatched ? (
                        <AdminNotice status="warning" locale={locale}>
                          {isKorean
                            ? "상품 줄 합계와 전표 금액이 다릅니다. 초안 보관은 가능하며 재고 반영 전 대조해야 합니다."
                            : "The line total differs from the slip amount. You can save the draft, but reconcile them before updating stock."}
                        </AdminNotice>
                      ) : null}
                      <button type="submit" disabled={!draftValid}>
                        {isKorean ? "초안 저장" : "Save draft"}
                      </button>
                    </fieldset>
                  </form>
                  {selected?.status === "DRAFT" ? (
                    <>
                      <p>
                        {unsaved
                          ? isKorean
                            ? "수정 내용을 초안 저장한 뒤 재고 미리보기를 요청해 주세요."
                            : "Save your changes as a draft, then request the stock preview."
                          : isKorean
                            ? "저장된 초안의 상품·수량을 다시 확인해 주세요."
                            : "Check the saved draft's products and quantities again."}
                      </p>
                      <button
                        type="button"
                        disabled={locked || !open || unsaved || unmatched || mismatched}
                        onClick={() =>
                          void run(day, {
                            action: "preview",
                            entryId: selected.entryId,
                            version: selected.version,
                          })
                        }
                      >
                        {isKorean ? "재고 반영 미리보기" : "Preview stock changes"}
                      </button>
                      <div className={styles.actions}>
                        <label>
                          {isKorean
                            ? "보류 전표 폐기 사유"
                            : "Reason for voiding the held slip"}
                          <input
                            required
                            value={voidReason}
                            maxLength={300}
                            disabled={locked || !open}
                            onChange={(e) => setVoidReason(e.target.value)}
                          />
                        </label>
                        <button
                          type="button"
                          disabled={locked || !open || !voidReason.trim()}
                          onClick={() =>
                            void run(day, {
                              action: "void",
                              entryId: selected.entryId,
                              version: selected.version,
                              reason: voidReason.trim(),
                            })
                          }
                        >
                          {isKorean ? "초안 폐기" : "Void draft"}
                        </button>
                      </div>
                    </>
                  ) : null}
                </section>
              ) : null}
              {preview ? (
                <section
                  className={styles.block}
                  aria-label={isKorean ? "재고 변동 확인" : "Stock change check"}
                >
                  <h3>{isKorean ? "예정 재고 변동" : "Planned stock changes"}</h3>
                  <div className={styles.tableWrap}>
                    <table>
                      <caption>
                        {isKorean
                          ? "확정할 전표의 재고 변동"
                          : "Stock changes for the slip to post"}
                      </caption>
                      <thead>
                        <tr>
                          <th>{isKorean ? "상품" : "Product"}</th>
                          <th>{isKorean ? "현재 총재고" : "Current total stock"}</th>
                          <th>{isKorean ? "예약" : "Reserved"}</th>
                          <th>{isKorean ? "판매 가능" : "Available"}</th>
                          <th>{isKorean ? "변동" : "Change"}</th>
                          <th>{isKorean ? "반영 후" : "After"}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.preview.map((r) => (
                          <tr key={r.productId}>
                            <th>{r.name}</th>
                            <td>{r.quantity}</td>
                            <td>{r.reserved}</td>
                            <td>{r.available}</td>
                            <td>{r.delta}</td>
                            <td>{r.after}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <label className={styles.check}>
                    <input
                      type="checkbox"
                      checked={stockConfirmed}
                      disabled={locked}
                      onChange={(e) => setStockConfirmed(e.target.checked)}
                    />
                    {isKorean
                      ? "상품·옵션·수량과 재고 변동을 확인했습니다"
                      : "I checked the products, options, quantities and stock changes"}
                  </label>
                  <button
                    className={styles.primary}
                    type="button"
                    disabled={locked || !stockConfirmed || !open}
                    onClick={() =>
                      void run(day, {
                        action: "post",
                        entryId: preview.entryId,
                        version: preview.version,
                        previewToken: preview.previewToken,
                        confirmed: true,
                      })
                    }
                  >
                    {isKorean ? "판매 확정·재고 반영" : "Post sale · Update stock"}
                  </button>
                </section>
              ) : null}
              {selected && selected.status !== "DRAFT" ? (
                <section
                  className={styles.block}
                  aria-label={isKorean ? "판매 전표 상세" : "Sales slip details"}
                >
                  <h3>
                    {selected.reference} · {statusLabels[locale][selected.status]}
                  </h3>
                  <p>
                    {isKorean ? "판매시각" : "Sale time"}{" "}
                    {showTime(selected.soldAt, locale)} ·{" "}
                    {money(selected.amount, locale)} ·{" "}
                    {selected.memo || (isKorean ? "메모 없음" : "No memo")}
                  </p>
                  <ul>
                    {selected.lines.map((l, i) => (
                      <li key={i}>
                        {l.name || (isKorean ? "미매칭" : "Unmatched")} ·{" "}
                        {l.option || (isKorean ? "옵션 없음" : "No option")} ·{" "}
                        {isKorean ? `${l.quantity}개` : l.quantity} ×{" "}
                        {money(l.unitAmount, locale)}
                      </li>
                    ))}
                  </ul>
                  {selected.kind === "REVERSAL" ? (
                    <p>
                      {isKorean ? "원전표" : "Original slip"}{" "}
                      {selected.original?.businessDay} / {selected.original?.entryId} ·{" "}
                      {selected.restocked
                        ? isKorean
                          ? "입고·검수 확인 후 재고 복원됨"
                          : "Stock restored after receipt and inspection"
                        : isKorean
                          ? "금액 반대전표만 기록됨 · 재고 복원 없음"
                          : "Amount reversal only · No stock restored"}
                    </p>
                  ) : null}
                  {selected.status === "POSTED" && selected.kind === "SALE" ? (
                    <div className={styles.reversal}>
                      <h4>
                        {isKorean
                          ? "원전표 전체 반대전표"
                          : "Full reversal of the original slip"}
                      </h4>
                      <p>
                        {isKorean
                          ? "원전표를 고치지 않고 전체 금액의 반대전표를 기록합니다. 실제 카드 취소·현금 환급·이체 반환은 별도로 처리하며, 검수 확인을 선택한 경우에만 전 수량을 복원합니다."
                          : "Records a reversal for the full amount without editing the original slip. Actual card cancellations, cash refunds and transfer returns are handled separately, and all quantities are restored only when inspection is confirmed."}
                      </p>
                      <div className={styles.fields}>
                        <label>
                          {isKorean ? "반대전표 영업일" : "Reversal business day"}
                          <input
                            type="date"
                            required
                            value={reverseDay}
                            max={today()}
                            min={selected.businessDay}
                            disabled={locked}
                            onChange={(e) => {
                              setObservedNow(Date.now());
                              setReverseDay(e.target.value);
                              setReverseTime(initialTime(e.target.value));
                              setReverseConfirmed(false);
                              setRestock(false);
                            }}
                          />
                        </label>
                        <label>
                          {isKorean
                            ? "반대전표 판매일시 (한국 시간)"
                            : "Reversal date and time (Korea time)"}
                          <input
                            type="datetime-local"
                            required
                            value={reverseTime}
                            min={`${reverseDay}T00:00`}
                            max={
                              reverseDay === today()
                                ? initialTime(reverseDay)
                                : `${reverseDay}T23:59`
                            }
                            disabled={locked}
                            onChange={(e) => {
                              setObservedNow(Date.now());
                              setReverseTime(e.target.value);
                            }}
                          />
                        </label>
                        <label className={styles.wide}>
                          {isKorean ? "반대전표 사유" : "Reversal reason"}
                          <input
                            required
                            value={reverseReason}
                            maxLength={300}
                            disabled={locked}
                            onChange={(e) => setReverseReason(e.target.value)}
                          />
                        </label>
                      </div>
                      <label className={styles.check}>
                        <input
                          type="checkbox"
                          checked={restock}
                          disabled={locked}
                          onChange={(e) => setRestock(e.target.checked)}
                        />
                        {isKorean
                          ? "실물 입고·검수 완료 및 재판매 가능을 확인했습니다"
                          : "I confirmed the items were received, inspected and are resalable"}
                      </label>
                      <label className={styles.check}>
                        <input
                          type="checkbox"
                          checked={reverseConfirmed}
                          disabled={locked}
                          onChange={(e) => setReverseConfirmed(e.target.checked)}
                        />
                        {isKorean
                          ? "원전표 전체 금액의 반대전표임을 확인했습니다"
                          : "I confirm this reverses the full amount of the original slip"}
                      </label>
                      <button
                        type="button"
                        disabled={
                          locked ||
                          !reverseConfirmed ||
                          !reverseReason.trim() ||
                          !validSalesDay(reverseDay) ||
                          !reverseTime.startsWith(`${reverseDay}T`) ||
                          !Number.isFinite(Date.parse(`${reverseTime}+09:00`)) ||
                          Date.parse(`${reverseTime}+09:00`) <
                            Date.parse(selected.soldAt) ||
                          Date.parse(`${reverseTime}+09:00`) > observedNow
                        }
                        onClick={() =>
                          void run(reverseDay, {
                            action: "reverse",
                            entryId: newId(),
                            originalDay: selected.businessDay,
                            originalId: selected.entryId,
                            soldAt: `${reverseTime}+09:00`,
                            reason: reverseReason.trim(),
                            restockInspected: restock,
                            confirmed: true,
                          })
                        }
                      >
                        {isKorean ? "반대전표 기록" : "Record reversal"}
                      </button>
                    </div>
                  ) : null}
                </section>
              ) : null}
              <details className={styles.block}>
                <summary>
                  {isKorean
                    ? `온라인 집계 근거 ${report.onlineEvents.length}건`
                    : `Online totals evidence: ${report.onlineEvents.length}`}
                </summary>
                <p>
                  {isKorean
                    ? "온라인 거래는 행별 시각 출처를 표시합니다. 결제 제공자 시각의 근거가 부족한 거래는 서버가 확인한 시각으로 집계하며 실제 거래 발생시각을 뜻하지 않습니다."
                    : "Online transactions show the time source per row. Transactions without enough payment provider time evidence are counted at the server-observed time, which is not the actual transaction time."}
                </p>
                <ul>
                  {report.onlineEvents.map((e, i) => (
                    <li key={`${e.orderId}-${i}`}>
                      {showTime(e.occurredAt, locale)} · {e.orderId} ·{" "}
                      {onlineKind(e.kind, locale)} · {money(e.amount, locale)} ·{" "}
                      {timeBasis(e.timeBasis, locale)}
                    </li>
                  ))}
                </ul>
              </details>
            </div>
            <section
              className={`${styles.block} ${styles.closePanel}`}
              aria-label={isKorean ? "일마감" : "Daily close"}
            >
              <h3>{isKorean ? "일마감 대조" : "Daily close reconciliation"}</h3>
              <dl className={styles.closeTotals}>
                <div>
                  <dt>{isKorean ? "온라인 순매출" : "Online net sales"}</dt>
                  <dd>{money(report.totals.onlineNet, locale)}</dd>
                </div>
                <div>
                  <dt>{isKorean ? "카드 순매출" : "Card net sales"}</dt>
                  <dd>{money(report.totals.card, locale)}</dd>
                </div>
                <div>
                  <dt>{isKorean ? "현금 순매출" : "Cash net sales"}</dt>
                  <dd>{money(report.totals.cash, locale)}</dd>
                </div>
                <div>
                  <dt>{isKorean ? "이체 순매출" : "Transfer net sales"}</dt>
                  <dd>{money(report.totals.transfer ?? 0, locale)}</dd>
                </div>
                <div>
                  <dt>{isKorean ? "통합 순매출" : "Combined net sales"}</dt>
                  <dd>{money(report.totals.combinedNet, locale)}</dd>
                </div>
              </dl>
              {report.entries.some((entry) => entry.status === "DRAFT") ? (
                <AdminNotice status="attention" locale={locale}>
                  {isKorean ? "작성 중 전표" : "Draft slips"}{" "}
                  {report.entries.filter((entry) => entry.status === "DRAFT").length}
                  {isKorean ? "건" : ""}
                </AdminNotice>
              ) : null}
              <p>
                {isKorean
                  ? "현금 대조액은 현금 판매에서 반대전표를 뺀 순매출이며 금고 잔액·시재·입금액이 아닙니다. 카드·이체 금액은 현금 대조에 포함하지 않습니다."
                  : "The cash comparison amount is cash sales minus reversals, not the safe balance, cash on hand or deposits. Card and transfer amounts are not included in the cash comparison."}
              </p>
              <p>
                {isKorean
                  ? "카드 원문·이체 입금 내역과 현금 수기장부를 대조하고, 온라인 주문을 오프라인 전표에도 중복 기록하지 않았는지 직접 확인해 주세요."
                  : "Compare card records, transfer deposits and the handwritten cash book, and check yourself that no online order was also recorded as an offline slip."}
              </p>
              {open ? (
                <>
                  <label>
                    {isKorean
                      ? "현금 순매출 수기 대조액"
                      : "Handwritten cash net sales amount"}
                    <input
                      type="number"
                      step="1"
                      required
                      value={cashCompared}
                      disabled={locked}
                      onChange={(e) => {
                        setCashCompared(e.target.value);
                        setCloseConfirmed(false);
                      }}
                    />
                  </label>
                  <p>
                    {isKorean ? "장부 현금 순매출" : "Ledger cash net sales"}{" "}
                    {money(report.totals.cash, locale)} ·{" "}
                    {isKorean ? "통합 순매출" : "Combined net sales"}{" "}
                    {money(report.totals.combinedNet, locale)}
                  </p>
                  <label className={styles.check}>
                    <input
                      type="checkbox"
                      checked={closeConfirmed}
                      disabled={locked || !!report.warnings.length}
                      onChange={(e) => setCloseConfirmed(e.target.checked)}
                    />
                    {isKorean
                      ? "온라인·오프라인 매출과 경고를 모두 확인했습니다"
                      : "I checked all online and offline sales and warnings"}
                  </label>
                  <button
                    className={styles.primary}
                    type="button"
                    disabled={!canClose}
                    onClick={() =>
                      void run(day, {
                        action: "close",
                        operationId: newId(),
                        expectedVersion: report.version,
                        onlineFingerprint: report.onlineFingerprint,
                        cashComparedAmount: Number(cashCompared),
                        confirmed: true,
                      })
                    }
                  >
                    {isKorean ? "선택일 장부 마감" : "Close the selected day"}
                  </button>
                  {!canClose ? (
                    <p className={styles.closeReason}>
                      {
                        (locked
                          ? {
                              ko: "진행 중이거나 미확정인 요청을 먼저 확인하세요.",
                              en: "Check the in-progress or unconfirmed request first.",
                            }
                          : !report.complete
                            ? {
                                ko: "최신 집계가 완료되어야 마감할 수 있습니다.",
                                en: "The latest totals must be complete before closing.",
                              }
                            : report.warnings.length
                              ? {
                                  ko: "마감 경고를 먼저 확인하세요.",
                                  en: "Check the closing warnings first.",
                                }
                              : report.entries.some((entry) => entry.status === "DRAFT")
                                ? {
                                    ko: "작성 중 전표를 먼저 확인하세요.",
                                    en: "Check the draft slips first.",
                                  }
                                : cashCompared.trim() === "" ||
                                    Number(cashCompared) !== report.totals.cash
                                  ? {
                                      ko: "현금 순매출 대조액을 확인하세요.",
                                      en: "Check the cash net sales comparison amount.",
                                    }
                                  : {
                                      ko: "매출과 경고 확인 항목을 체크해 주세요.",
                                      en: "Tick the sales and warnings confirmation.",
                                    })[locale]
                      }
                    </p>
                  ) : null}
                </>
              ) : (
                <>
                  <p>
                    {isKorean
                      ? "마감된 영업일은 전표 쓰기가 잠깁니다. 변경이 필요하면 사유를 남겨 재개방한 뒤 다시 마감해 주세요."
                      : "Slip writing is locked for a closed business day. To make changes, reopen it with a reason and close it again."}
                  </p>
                  <label>
                    {isKorean ? "재개방 사유" : "Reopen reason"}
                    <input
                      required
                      value={reopenReason}
                      maxLength={300}
                      disabled={locked}
                      onChange={(e) => setReopenReason(e.target.value)}
                    />
                  </label>
                  <button
                    type="button"
                    disabled={locked || !reopenReason.trim()}
                    onClick={() =>
                      void run(day, {
                        action: "reopen",
                        operationId: newId(),
                        expectedVersion: report.version,
                        reason: reopenReason.trim(),
                      })
                    }
                  >
                    {isKorean ? "마감 재개방" : "Reopen day"}
                  </button>
                </>
              )}
              <p className={styles.muted}>
                {isKorean
                  ? "일마감은 재고를 다시 차감하지 않습니다."
                  : "The daily close does not deduct stock again."}
              </p>
              <details className={styles.closeHistory}>
                <summary>
                  {isKorean ? "마감표·재개방 이력" : "Closing sheets · Reopen history"}
                </summary>
                <h4>
                  {isKorean
                    ? `마감표 이력 ${report.snapshots.length}건`
                    : `Closing sheets: ${report.snapshots.length}`}
                </h4>
                {report.snapshots.map((s) => (
                  <details key={s.snapshotId}>
                    <summary>
                      {showTime(s.closedAt, locale)} ·{" "}
                      {isKorean ? "통합 순매출" : "Combined net sales"}{" "}
                      {money(s.totals.combinedNet, locale)}
                    </summary>
                    <p>
                      {isKorean ? "마감 번호" : "Closing number"} {s.snapshotId} ·{" "}
                      {isKorean ? "버전" : "Version"} {s.version}
                    </p>
                    <p>
                      {s.entryManifest
                        ? isKorean
                          ? `마감 당시 전표 ${s.entryCount}건의 근거를 보관했습니다.`
                          : `Kept evidence for ${s.entryCount} slips at closing.`
                        : isKorean
                          ? "마감 당시 전표 근거가 제공되지 않았습니다."
                          : "No slip evidence was provided at closing."}
                    </p>
                    <p>
                      {(isKorean
                        ? [
                            ["카드 순매출", s.totals.card],
                            ["현금 순매출", s.totals.cash],
                            ["이체 순매출", s.totals.transfer ?? 0],
                            ["오프라인 반대전표", s.totals.offlineRefunds],
                            ["온라인 총매출", s.totals.onlineGross],
                            ["온라인 환불", s.totals.onlineRefunds],
                            ["온라인 순매출", s.totals.onlineNet],
                            ["현금 대조액", s.cashComparedAmount],
                          ]
                        : [
                            ["Card net sales", s.totals.card],
                            ["Cash net sales", s.totals.cash],
                            ["Transfer net sales", s.totals.transfer ?? 0],
                            ["Offline reversals", s.totals.offlineRefunds],
                            ["Online gross sales", s.totals.onlineGross],
                            ["Online refunds", s.totals.onlineRefunds],
                            ["Online net sales", s.totals.onlineNet],
                            ["Cash comparison amount", s.cashComparedAmount],
                          ]
                      )
                        .map(
                          ([label, amount]) =>
                            `${label} ${money(Number(amount), locale)}`,
                        )
                        .join(" · ")}
                    </p>
                    <ul>
                      {s.onlineEvents.map((e, i) => (
                        <li key={`${e.orderId}-${i}`}>
                          {showTime(e.occurredAt, locale)} · {e.orderId} ·{" "}
                          {onlineKind(e.kind, locale)} · {money(e.amount, locale)} ·{" "}
                          {timeBasis(e.timeBasis, locale)}
                        </li>
                      ))}
                    </ul>
                  </details>
                ))}
                <h4>{isKorean ? "마감·재개방 기록" : "Close and reopen history"}</h4>
                <ul>
                  {report.history.map((h, i) => (
                    <li key={`${h.at}-${i}`}>
                      {showTime(h.at, locale)} ·{" "}
                      {h.action === "CLOSE"
                        ? isKorean
                          ? "마감"
                          : "Close"
                        : isKorean
                          ? "재개방"
                          : "Reopen"}{" "}
                      · {historyReason(h, locale)}
                    </li>
                  ))}
                </ul>
              </details>
            </section>
          </div>
        </div>
      ) : (
        <p className={styles.empty}>
          {isKorean
            ? "영업일을 선택해 장부를 조회해 주세요. 조회가 완료되면 전표 기록과 일마감을 시작할 수 있습니다."
            : "Select a business day and load the ledger. Once it loads you can record slips and run the daily close."}
        </p>
      )}
    </section>
  );
}
