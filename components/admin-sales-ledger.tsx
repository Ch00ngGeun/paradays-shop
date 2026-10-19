"use client";
import { useRef, useState, useSyncExternalStore } from "react";
import { useAuth } from "@/contexts/auth-context";
import type { AdminCatalogListItem } from "@/lib/admin-ui/types";
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
  method: "CARD" | "CASH";
  reference: string;
  amount: string;
  memo: string;
  lines: Row[];
};
type Attempt = { day: string; command: SalesCommand };
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
const money = (n: number) => `${n.toLocaleString("ko-KR")}원`;
const localTime = (iso: string) =>
  new Date(Date.parse(iso) + 9 * 3_600_000).toISOString().slice(0, 16);
const today = () => localTime(new Date().toISOString()).slice(0, 10);
const initialTime = (day: string) =>
  day === today() ? localTime(new Date().toISOString()) : `${day}T12:00`;
const showTime = (iso: string) =>
  new Intl.DateTimeFormat("ko-KR", {
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
const statusLabels = { DRAFT: "보류 초안", POSTED: "확정", VOID: "폐기" };
const warnings: Record<string, string> = {
  UNPOSTED_SALES: "확정하지 않은 초안이 남아 있습니다.",
  UNMATCHED_OR_AMOUNT_MISMATCH:
    "상품 미매칭 또는 줄 합계와 전표 금액이 다른 초안이 있습니다.",
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
};
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
}: Readonly<{ products: readonly AdminCatalogListItem[] }>) {
  const { isAuthenticated, status, user } = useAuth();
  if (status !== "authenticated" || !isAuthenticated || !user?.groups.includes("admin"))
    return null;
  return <SalesModeSession key={user.sub} products={products} />;
}
function SalesModeSession({
  products,
}: Readonly<{ products: readonly AdminCatalogListItem[] }>) {
  const [mode, setMode] = useState<"choose" | "real" | "simulation">("choose");
  const [acknowledged, setAcknowledged] = useState(false);
  function chooseMode() {
    setMode("choose");
    setAcknowledged(false);
  }
  if (mode === "simulation")
    return (
      <section className={styles.simulationShell} aria-label="모의 매출·일마감">
        <div className={styles.simulationModeBadge}>
          <span aria-hidden="true">◇</span> 연습 중 · 실제 변경 없음
        </div>
        <AdminSalesSimulationPanel onExit={chooseMode} />
      </section>
    );
  if (mode === "real")
    return <ActualSalesLedgerPanel products={products} onExit={chooseMode} />;
  return (
    <section className={styles.panel} aria-labelledby="sales-mode-title">
      <header className={styles.header}>
        <h2 id="sales-mode-title">매출·일마감 모드 선택</h2>
        <p>연습과 실제 운영을 구분해 시작하세요.</p>
      </header>
      <div className={styles.modeCards}>
        <section className={`${styles.block} ${styles.modeCard}`}>
          <span className={styles.simulationModeBadge}>
            <span aria-hidden="true">◇</span> 실제 변경 없음
          </span>
          <h3>연습하기</h3>
          <p>가상 상품으로 카드·현금 판매부터 재고 반영·일마감까지 연습합니다.</p>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            실제 장부와 재고를 바꾸지 않는 모의 체험임을 확인했습니다
          </label>
          <button
            className={styles.primary}
            type="button"
            disabled={!acknowledged}
            onClick={() => {
              if (acknowledged) setMode("simulation");
            }}
          >
            모의 매출·일마감 체험
          </button>
          <details className={styles.inlineHelp}>
            <summary>연습 데이터 보관 안내</summary>
            <p>
              브라우저 메모리의 합성 TEST 상품·전표만 사용합니다. 메뉴 이동 시 유지되며
              초기화·종료·새로고침·로그아웃·계정 교체 시 폐기됩니다. 실제
              상품·장부·온라인 매출은 조회하거나 변경하지 않습니다.
            </p>
          </details>
        </section>
        <section className={`${styles.block} ${styles.modeCard}`}>
          <span className={styles.actualModeBadge}>
            <span aria-hidden="true">●</span> 실제 장부·재고 변경
          </span>
          <h3>실제 운영</h3>
          <p className={styles.warning}>
            판매를 확정하면 실제 재고가 차감됩니다. 연습하려면 ‘연습하기’를 선택하세요.
          </p>
          <p className={styles.muted}>기존 미확정 요청은 실제 운영에서 확인합니다.</p>
          <button
            aria-label="실제 운영 열기 · 실제 매출·일마감 열기"
            className={styles.primary}
            type="button"
            onClick={() => setMode("real")}
          >
            실제 운영 열기
          </button>
        </section>
      </div>
    </section>
  );
}
function ActualSalesLedgerPanel({
  products,
  onExit,
}: Readonly<{ products: readonly AdminCatalogListItem[]; onExit: () => void }>) {
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
  const [notice, setNotice] = useState("");
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
        setNotice(
          "장부를 다시 조회했습니다. 미확정 요청의 전표·마감 상태를 직접 확인한 뒤 잠금을 해제하거나 같은 요청을 재시도해 주세요.",
        );
      } else setNotice("한국 시간 기준 장부를 조회했습니다.");
    } catch {
      setReport(null);
      setNotice(
        "장부를 조회하지 못했습니다. 로그인·권한·연결을 확인하고 다시 조회해 주세요. 미완료 집계로 마감하지 않습니다.",
      );
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
    setResolutionRead(false);
    setResolutionConfirmed(false);
    if (mutation && !retry) remember({ day: targetDay, command: frozen });
    try {
      const result = await client().operate(targetDay, frozen);
      if ("preview" in result) {
        setPreview(result);
        setStockConfirmed(false);
        setNotice("아래 재고 변동을 확인한 뒤 판매를 확정해 주세요.");
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
          setNotice(
            "요청 처리 응답은 확인했습니다. 최신 합계 조회가 실패했으므로 장부를 다시 조회해 주세요.",
          );
          return;
        }
      }
      setDay(targetDay);
      setNotice(
        frozen.action === "save"
          ? "초안을 보관했습니다. 아직 매출·재고에 반영되지 않았습니다."
          : "처리 결과를 서버 장부에서 확인했습니다.",
      );
    } catch (error) {
      const uncertain =
        mutation && (!(error instanceof AdminSalesError) || error.resultUncertain);
      if (!uncertain) remember(null);
      setNotice(
        uncertain
          ? "처리 결과가 확정되지 않았습니다. 다른 쓰기를 잠갔습니다. 같은 요청 재시도 또는 결과 재조회로 확인해 주세요."
          : error instanceof AdminSalesError && error.status === 401
            ? "관리자 로그인이 필요합니다."
            : `요청이 거절되었습니다${error instanceof AdminSalesError ? ` (${error.code})` : ""}. 최신 장부와 입력값을 확인해 주세요.`,
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
  return (
    <section className={styles.panel} aria-labelledby="sales-ledger-title">
      <header className={styles.header}>
        <div>
          <div className={styles.titleRow}>
            <h2 id="sales-ledger-title">매출·일마감 관리</h2>
            <span className={styles.actualModeBadge}>
              <span aria-hidden="true">●</span> 실제 운영 · 장부·재고 변경
            </span>
          </div>
          <p>카드·현금 전표와 하루 매출을 대조합니다. 날짜·시각은 한국 시간입니다.</p>
        </div>
        <button
          type="button"
          disabled={locked}
          onClick={() => {
            if (!busyRef.current && !attempt) onExit();
          }}
        >
          모드 선택으로 돌아가기
        </button>
      </header>
      {locked ? (
        <p className={styles.warning}>
          실제 요청이 진행 중이거나 결과 확인 대기 중입니다. 요청을 정리한 뒤 모드를
          변경할 수 있습니다.
        </p>
      ) : null}
      <form
        className={styles.toolbar}
        onSubmit={(e) => {
          e.preventDefault();
          void load();
        }}
      >
        <label>
          영업일 (한국 시간)
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
          장부 조회
        </button>
      </form>
      {notice ? (
        <p role="status" className={styles.notice}>
          {notice}
        </p>
      ) : null}
      {attempt ? (
        <section className={styles.warning} aria-label="미확정 요청 보호">
          <h3>처리 결과 확인 필요</h3>
          <p>
            영업일 {attempt.day} · 요청 {attempt.command.action} ·{" "}
            {"entryId" in attempt.command
              ? attempt.command.entryId
              : attempt.command.operationId}
          </p>
          <p>
            입력 변경·다른 전표 처리·마감을 잠갔습니다. 원래 요청의 번호와 내용을 그대로
            유지합니다.
          </p>
          <div className={styles.actions}>
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(attempt.day, attempt.command, true)}
            >
              같은 요청 재시도
            </button>
            <button type="button" disabled={busy} onClick={() => void load(true)}>
              결과 재조회
            </button>
          </div>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={resolutionConfirmed}
              disabled={!resolutionRead || busy}
              onChange={(e) => setResolutionConfirmed(e.target.checked)}
            />
            재조회한 장부에서 처리 결과를 직접 확인했습니다
          </label>
          <button
            type="button"
            disabled={!resolutionRead || !resolutionConfirmed || busy}
            onClick={() => {
              remember(null);
              setDraft(null);
              setSelectedId(null);
              setNotice(
                "직접 확인한 결과에 따라 미확정 요청 잠금을 해제했습니다. 필요한 전표를 다시 선택해 주세요.",
              );
            }}
          >
            미확정 요청 잠금 해제
          </button>
        </section>
      ) : null}
      {report ? (
        <div className={styles.reportStack}>
          <div className={styles.dayStatus}>
            <h3>
              {report.businessDay} ·{" "}
              {report.status === "CLOSED" ? "마감 완료" : "영업 중"}
            </h3>
            <span>
              조회 기준 {showTime(report.asOf)} · 버전 {report.version}
            </span>
          </div>
          <div className={styles.summaryGrid} aria-label="확정 순매출 요약">
            <article>
              <span aria-hidden="true" className={styles.metricSymbol}>
                ↗
              </span>
              <span>온라인 순매출</span>
              <strong>{money(report.totals.onlineNet)}</strong>
            </article>
            <article>
              <span aria-hidden="true" className={styles.metricSymbol}>
                ▣
              </span>
              <span>오프라인 카드 순매출</span>
              <strong>{money(report.totals.card)}</strong>
            </article>
            <article>
              <span aria-hidden="true" className={styles.metricSymbol}>
                ▤
              </span>
              <span>오프라인 현금 순매출</span>
              <strong>{money(report.totals.cash)}</strong>
            </article>
            <article>
              <span aria-hidden="true" className={styles.metricSymbol}>
                Σ
              </span>
              <span>통합 순매출</span>
              <strong>{money(report.totals.combinedNet)}</strong>
            </article>
          </div>
          {report.warnings.length ? (
            <div className={styles.warning} aria-label="마감 경고">
              <strong>마감 전 확인 필요</strong>
              <ul>
                {report.warnings.map((w) => (
                  <li key={w}>{warnings[w] ?? w}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {!report.complete ? (
            <p className={styles.warning}>
              집계가 완료되지 않았습니다. 최신 장부를 다시 조회한 뒤 마감해 주세요.
            </p>
          ) : null}
          <details className={`${styles.block} ${styles.reconciliationDetails}`}>
            <summary>확정 매출 대조표·집계 기준</summary>
            <div className={styles.tableWrap}>
              <table>
                <caption>확정 매출 대조표 · 원화</caption>
                <thead>
                  <tr>
                    <th scope="col">구분</th>
                    <th scope="col">총매출</th>
                    <th scope="col">반대전표·환불</th>
                    <th scope="col">순매출</th>
                  </tr>
                </thead>
                <tbody>
                  {(["CARD", "CASH"] as const).map((method) => {
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
                          오프라인 {method === "CARD" ? "카드" : "현금"}
                        </th>
                        <td>{money(gross)}</td>
                        <td>{money(refunds)}</td>
                        <td>
                          {money(
                            method === "CARD" ? report.totals.card : report.totals.cash,
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  <tr>
                    <th scope="row">오프라인 합계</th>
                    <td>
                      {money(report.totals.offlineNet + report.totals.offlineRefunds)}
                    </td>
                    <td>{money(report.totals.offlineRefunds)}</td>
                    <td>{money(report.totals.offlineNet)}</td>
                  </tr>
                  <tr>
                    <th scope="row">온라인</th>
                    <td>{money(report.totals.onlineGross)}</td>
                    <td>{money(report.totals.onlineRefunds)}</td>
                    <td>{money(report.totals.onlineNet)}</td>
                  </tr>
                  <tr className={styles.total}>
                    <th scope="row">온·오프라인 통합</th>
                    <td>
                      {money(
                        report.totals.offlineNet +
                          report.totals.offlineRefunds +
                          report.totals.onlineGross,
                      )}
                    </td>
                    <td>
                      {money(
                        report.totals.offlineRefunds + report.totals.onlineRefunds,
                      )}
                    </td>
                    <td>{money(report.totals.combinedNet)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p>
              미확인 거래는 합계에서 제외됩니다. 일마감 전에 결제·환불 결과를 확정해야
              합니다.
            </p>
            <p>
              이 장부는 온라인+오프라인 통합 승인 총액·환불·순매출 기준입니다. 홈의 오늘
              매출은 기존 현재 PAID 온라인 주문 요약 기준이므로 이 장부의 통합 합계와
              다릅니다.
            </p>
          </details>
          <div className={styles.ledgerWorkspace}>
            <div className={styles.ledgerMain}>
              <section className={styles.block}>
                <div className={styles.headingRow}>
                  <h3>오프라인 전표 · 판매 시간순</h3>
                  <button
                    aria-label="판매 등록 · 새 전표"
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
                    <span aria-hidden="true">＋</span> 판매 등록
                  </button>
                </div>
                <p>
                  초안·폐기 전표는 합계에서 제외됩니다. 카드번호·고객 개인정보는
                  입력하지 마세요.
                </p>
                <div className={styles.tableWrap}>
                  <table>
                    <caption>오프라인 판매 전표</caption>
                    <thead>
                      <tr>
                        <th>판매시각 (한국 시간)</th>
                        <th>구분</th>
                        <th>전표</th>
                        <th>금액</th>
                        <th>상태</th>
                        <th>열기</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.entries.map((e) => (
                        <tr key={e.entryId} data-testid={`ledger-entry-${e.entryId}`}>
                          <td>{showTime(e.soldAt)}</td>
                          <td>
                            {e.method === "CARD" ? "카드" : "현금"}{" "}
                            {e.kind === "REVERSAL" ? "반대전표" : "판매"}
                          </td>
                          <td>
                            <strong>{e.reference}</strong>
                            <span className={styles.entryProductSummary}>
                              {e.lines
                                .slice(0, 2)
                                .map(
                                  (line) =>
                                    `${line.name || "미매칭"} · ${line.quantity}개`,
                                )
                                .join(" / ")}
                              {e.lines.length > 2 ? ` 외 ${e.lines.length - 2}줄` : ""}
                            </span>
                          </td>
                          <td>{money(e.kind === "REVERSAL" ? -e.amount : e.amount)}</td>
                          <td>
                            <span className={styles.entryStatus} data-state={e.status}>
                              {statusLabels[e.status]}
                            </span>
                          </td>
                          <td>
                            <button
                              type="button"
                              aria-label={`${e.status === "DRAFT" ? "이어서 작성" : "상세"} · ${e.entryId} 전표 선택`}
                              disabled={locked}
                              onClick={() => {
                                setObservedNow(Date.now());
                                selectEntry(e);
                              }}
                            >
                              {e.status === "DRAFT" ? "이어서 작성" : "상세"}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!report.entries.length ? <p>등록된 전표가 없습니다.</p> : null}
                </div>
                <ol className={styles.workflow} aria-label="판매 등록 순서">
                  <li aria-current={draft && !preview ? "step" : undefined}>
                    <span>1</span> 판매 입력
                  </li>
                  <li aria-current={preview ? "step" : undefined}>
                    <span>2</span> 재고 확인
                  </li>
                  <li>
                    <span>3</span> 판매 확정
                  </li>
                </ol>
              </section>
              {draft ? (
                <section className={styles.block} aria-label="판매 전표 편집">
                  <h3>{draft.expectedVersion ? "보류 초안 수정" : "새 판매 전표"}</h3>
                  <p className={styles.muted}>
                    전표 번호 {draft.entryId} · 저장은 보류 초안이며 재고를 바꾸지
                    않습니다.
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
                          판매일시 (한국 시간)
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
                          결제 구분
                          <select
                            value={draft.method}
                            onChange={(e) =>
                              updateDraft({ method: e.target.value as Draft["method"] })
                            }
                          >
                            <option value="CARD">카드</option>
                            <option value="CASH">현금</option>
                          </select>
                        </label>
                        <label>
                          전표 참조번호
                          <input
                            value={draft.reference}
                            maxLength={64}
                            required
                            placeholder="CARD-001 / CASH-001"
                            onChange={(e) => updateDraft({ reference: e.target.value })}
                          />
                        </label>
                        <label>
                          전표 금액
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
                          메모
                          <textarea
                            value={draft.memo}
                            maxLength={300}
                            onChange={(e) => updateDraft({ memo: e.target.value })}
                          />
                        </label>
                      </div>
                      <div className={styles.matching}>
                        <label>
                          상품 이름 검색
                          <input
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                            placeholder="상품명을 입력하세요"
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
                                    name: p.name,
                                    option: options.length === 1 ? options[0] : "",
                                    quantity: "1",
                                    unitAmount: String(p.price),
                                  },
                                ]);
                                setSearch("");
                              }}
                            >
                              {p.name} 연결
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
                          미매칭 줄 추가
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
                                  ? "상품 연결됨"
                                  : "미매칭 · 재고 반영 불가"}
                              </strong>
                              <label>
                                {index + 1}번 상품명
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
                                {index + 1}번 옵션
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
                                    <option value="">옵션 선택</option>
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
                                {index + 1}번 수량
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
                                {index + 1}번 단가
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
                                aria-label={`${index + 1}번 줄 삭제`}
                                onClick={() =>
                                  updateRows(draft.lines.filter((_, n) => n !== index))
                                }
                              >
                                줄 삭제
                              </button>
                            </div>
                          );
                        })}
                      </div>
                      <p>
                        상품 줄 합계 {money(lineSum(draft.lines))}{" "}
                        <button
                          type="button"
                          disabled={!draft.lines.length}
                          onClick={() => {
                            setManualAmount(false);
                            updateDraft({ amount: String(lineSum(draft.lines)) });
                          }}
                        >
                          줄 합계를 전표 금액에 적용
                        </button>
                      </p>
                      {unmatched ? (
                        <p className={styles.warning}>
                          미매칭 상품·옵션이 있습니다. 초안 보관은 가능하며 재고 반영 전
                          연결해야 합니다.
                        </p>
                      ) : null}
                      {mismatched ? (
                        <p className={styles.warning}>
                          상품 줄 합계와 전표 금액이 다릅니다. 초안 보관은 가능하며 재고
                          반영 전 대조해야 합니다.
                        </p>
                      ) : null}
                      <button type="submit" disabled={!draftValid}>
                        초안 저장
                      </button>
                    </fieldset>
                  </form>
                  {selected?.status === "DRAFT" ? (
                    <>
                      <p>
                        {unsaved
                          ? "수정 내용을 초안 저장한 뒤 재고 미리보기를 요청해 주세요."
                          : "저장된 초안의 상품·수량을 다시 확인해 주세요."}
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
                        재고 반영 미리보기
                      </button>
                      <div className={styles.actions}>
                        <label>
                          보류 전표 폐기 사유
                          <input
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
                          초안 폐기
                        </button>
                      </div>
                    </>
                  ) : null}
                </section>
              ) : null}
              {preview ? (
                <section className={styles.block} aria-label="재고 변동 확인">
                  <h3>예정 재고 변동</h3>
                  <div className={styles.tableWrap}>
                    <table>
                      <caption>확정할 전표의 재고 변동</caption>
                      <thead>
                        <tr>
                          <th>상품</th>
                          <th>현재 총재고</th>
                          <th>예약</th>
                          <th>판매 가능</th>
                          <th>변동</th>
                          <th>반영 후</th>
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
                    상품·옵션·수량과 재고 변동을 확인했습니다
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
                    판매 확정·재고 반영
                  </button>
                </section>
              ) : null}
              {selected && selected.status !== "DRAFT" ? (
                <section className={styles.block} aria-label="확정 전표 상세">
                  <h3>
                    {selected.reference} · {statusLabels[selected.status]}
                  </h3>
                  <p>
                    판매시각 {showTime(selected.soldAt)} · {money(selected.amount)} ·{" "}
                    {selected.memo || "메모 없음"}
                  </p>
                  <ul>
                    {selected.lines.map((l, i) => (
                      <li key={i}>
                        {l.name || "미매칭"} · {l.option || "옵션 없음"} · {l.quantity}
                        개 × {money(l.unitAmount)}
                      </li>
                    ))}
                  </ul>
                  {selected.kind === "REVERSAL" ? (
                    <p>
                      원전표 {selected.original?.businessDay} /{" "}
                      {selected.original?.entryId} ·{" "}
                      {selected.restocked
                        ? "입고·검수 확인 후 재고 복원됨"
                        : "금액 반대전표만 기록됨 · 재고 복원 없음"}
                    </p>
                  ) : null}
                  {selected.status === "POSTED" && selected.kind === "SALE" ? (
                    <div className={styles.reversal}>
                      <h4>원전표 전체 반대전표</h4>
                      <p>
                        원전표를 고치지 않고 전체 금액의 반대전표를 기록합니다. 실제
                        카드 취소·현금 환급은 별도로 처리하며, 검수 확인을 선택한
                        경우에만 전 수량을 복원합니다.
                      </p>
                      <div className={styles.fields}>
                        <label>
                          반대전표 영업일
                          <input
                            type="date"
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
                          반대전표 판매일시 (한국 시간)
                          <input
                            type="datetime-local"
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
                          반대전표 사유
                          <input
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
                        실물 입고·검수 완료 및 재판매 가능을 확인했습니다
                      </label>
                      <label className={styles.check}>
                        <input
                          type="checkbox"
                          checked={reverseConfirmed}
                          disabled={locked}
                          onChange={(e) => setReverseConfirmed(e.target.checked)}
                        />
                        원전표 전체 금액의 반대전표임을 확인했습니다
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
                        반대전표 기록
                      </button>
                    </div>
                  ) : null}
                </section>
              ) : null}
              <details className={styles.block}>
                <summary>온라인 집계 근거 {report.onlineEvents.length}건</summary>
                <p>
                  온라인 거래는 행별 시각 출처를 표시합니다. 결제 제공자 시각의 근거가
                  부족한 거래는 서버가 확인한 시각으로 집계하며 실제 거래 발생시각을
                  뜻하지 않습니다.
                </p>
                <ul>
                  {report.onlineEvents.map((e, i) => (
                    <li key={`${e.orderId}-${i}`}>
                      {showTime(e.occurredAt)} · {e.orderId} ·{" "}
                      {e.kind === "APPROVAL" ? "승인" : "환불"} · {money(e.amount)} ·{" "}
                      {e.timeBasis === "OBSERVED"
                        ? "서버 확인시각 기준"
                        : "결제 제공자 시각 기준"}
                    </li>
                  ))}
                </ul>
              </details>
            </div>
            <section
              className={`${styles.block} ${styles.closePanel}`}
              aria-label="일마감"
            >
              <h3>일마감 대조</h3>
              <dl className={styles.closeTotals}>
                <div>
                  <dt>온라인 순매출</dt>
                  <dd>{money(report.totals.onlineNet)}</dd>
                </div>
                <div>
                  <dt>카드 순매출</dt>
                  <dd>{money(report.totals.card)}</dd>
                </div>
                <div>
                  <dt>현금 순매출</dt>
                  <dd>{money(report.totals.cash)}</dd>
                </div>
                <div>
                  <dt>통합 순매출</dt>
                  <dd>{money(report.totals.combinedNet)}</dd>
                </div>
              </dl>
              {report.entries.some((entry) => entry.status === "DRAFT") ? (
                <p className={styles.warning}>
                  확정 대기 전표{" "}
                  {report.entries.filter((entry) => entry.status === "DRAFT").length}건
                </p>
              ) : null}
              <p>
                현금 대조액은 현금 판매에서 반대전표를 뺀 순매출이며 금고
                잔액·시재·입금액이 아닙니다.
              </p>
              <p>
                카드 원문과 현금 수기장부를 대조하고, 온라인 주문을 오프라인 전표에도
                중복 기록하지 않았는지 직접 확인해 주세요.
              </p>
              {open ? (
                <>
                  <label>
                    현금 순매출 수기 대조액
                    <input
                      type="number"
                      step="1"
                      value={cashCompared}
                      disabled={locked}
                      onChange={(e) => {
                        setCashCompared(e.target.value);
                        setCloseConfirmed(false);
                      }}
                    />
                  </label>
                  <p>
                    장부 현금 순매출 {money(report.totals.cash)} · 통합 순매출{" "}
                    {money(report.totals.combinedNet)}
                  </p>
                  <label className={styles.check}>
                    <input
                      type="checkbox"
                      checked={closeConfirmed}
                      disabled={locked || !!report.warnings.length}
                      onChange={(e) => setCloseConfirmed(e.target.checked)}
                    />
                    온라인·오프라인 매출과 경고를 모두 확인했습니다
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
                    선택일 장부 마감
                  </button>
                  {!canClose ? (
                    <p className={styles.closeReason}>
                      {locked
                        ? "진행 중이거나 미확정인 요청을 먼저 확인하세요."
                        : !report.complete
                          ? "최신 집계가 완료되어야 마감할 수 있습니다."
                          : report.warnings.length
                            ? "마감 경고를 먼저 확인하세요."
                            : report.entries.some((entry) => entry.status === "DRAFT")
                              ? "확정 대기 전표를 먼저 확인하세요."
                              : cashCompared.trim() === "" ||
                                  Number(cashCompared) !== report.totals.cash
                                ? "현금 순매출 대조액을 확인하세요."
                                : "매출과 경고 확인 항목을 체크해 주세요."}
                    </p>
                  ) : null}
                </>
              ) : (
                <>
                  <p>
                    마감된 영업일은 전표 쓰기가 잠깁니다. 변경이 필요하면 사유를 남겨
                    재개방한 뒤 다시 마감해 주세요.
                  </p>
                  <label>
                    재개방 사유
                    <input
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
                    마감 재개방
                  </button>
                </>
              )}
              <p className={styles.muted}>일마감은 재고를 다시 차감하지 않습니다.</p>
              <details className={styles.closeHistory}>
                <summary>마감표·재개방 이력</summary>
                <h4>마감표 이력 {report.snapshots.length}건</h4>
                {report.snapshots.map((s) => (
                  <details key={s.snapshotId}>
                    <summary>
                      {showTime(s.closedAt)} · 통합 순매출 {money(s.totals.combinedNet)}
                    </summary>
                    <p>
                      마감 번호 {s.snapshotId} · 버전 {s.version}
                    </p>
                    <p>
                      {s.entryManifest
                        ? `마감 당시 전표 ${s.entryCount}건의 근거를 보관했습니다.`
                        : "마감 당시 전표 근거가 제공되지 않았습니다."}
                    </p>
                    <p>
                      카드 순매출 {money(s.totals.card)} · 현금 순매출{" "}
                      {money(s.totals.cash)} · 오프라인 반대전표{" "}
                      {money(s.totals.offlineRefunds)} · 온라인 총매출{" "}
                      {money(s.totals.onlineGross)} · 온라인 환불{" "}
                      {money(s.totals.onlineRefunds)} · 온라인 순매출{" "}
                      {money(s.totals.onlineNet)} · 현금 대조액{" "}
                      {money(s.cashComparedAmount)}
                    </p>
                    <ul>
                      {s.onlineEvents.map((e, i) => (
                        <li key={`${e.orderId}-${i}`}>
                          {showTime(e.occurredAt)} · {e.orderId} ·{" "}
                          {e.kind === "APPROVAL" ? "승인" : "환불"} · {money(e.amount)}{" "}
                          ·{" "}
                          {e.timeBasis === "OBSERVED"
                            ? "서버 확인시각 기준"
                            : "결제 제공자 시각 기준"}
                        </li>
                      ))}
                    </ul>
                  </details>
                ))}
                <h4>마감·재개방 기록</h4>
                <ul>
                  {report.history.map((h, i) => (
                    <li key={`${h.at}-${i}`}>
                      {showTime(h.at)} · {h.action === "CLOSE" ? "마감" : "재개방"} ·{" "}
                      {h.reason}
                    </li>
                  ))}
                </ul>
              </details>
            </section>
          </div>
        </div>
      ) : (
        <p className={styles.empty}>
          영업일을 선택해 장부를 조회해 주세요. 조회가 완료되면 전표 기록과 일마감을
          시작할 수 있습니다.
        </p>
      )}
    </section>
  );
}
