// 역할: 실제 운영 매출 원장 화면. 영업일 리포트를 불러와 요약·전표 목록·전표 편집·재고 미리보기·전표 상세·온라인 이벤트·일마감 패널을 묶고, 원장 요청 실행과 결과 미확인 재시도를 관리합니다.
"use client";
import { useRef, useState, useSyncExternalStore } from "react";
import { useAuth } from "@/contexts/auth-context";
import type { AdminCatalogListItem } from "@/lib/admin-ui/types";
import type { Locale } from "@/types/store";
import {
  AdminSalesError,
  createAdminSalesApiClient,
  type DayReport,
  type SaleEntry,
  type SalesCommand,
} from "@/lib/commerce/admin-sales-api-client";
import styles from "./admin-sales-ledger.module.css";
import { AdminStepper, type AdminStep } from "./admin-stepper";
import { AdminNotice } from "./admin-status";
import {
  type Attempt,
  type Draft,
  type Notice,
  type Preview,
  type Row,
  draftOf,
  initialTime,
  isWhole,
  lineSum,
  pendingListeners,
  readPending,
  subscribePending,
  today,
} from "./admin-sales-ledger-model";
import { SalesLedgerHeader } from "./admin-sales-ledger";
import { SalesClosePanel } from "./admin-sales-ledger-close";
import { SalesDraftEditor } from "./admin-sales-ledger-draft";
import {
  SalesEntryDetail,
  SalesEntryList,
  SalesStockPreview,
} from "./admin-sales-ledger-entries";
import {
  SalesDayToolbar,
  SalesOnlineEvents,
  SalesPendingAttempt,
  SalesReportSummary,
} from "./admin-sales-ledger-summary";

export function ActualSalesLedgerPanel({
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
      <SalesLedgerHeader
        isKorean={isKorean}
        locale={locale}
        locked={locked}
        busyRef={busyRef}
        attempt={attempt}
        onExit={onExit}
      />
      {locked ? (
        <AdminNotice status="neutral" locale={locale}>
          {isKorean
            ? "실제 요청이 진행 중이거나 결과 확인 대기 중입니다. 요청을 정리한 뒤 모드를 변경할 수 있습니다."
            : "A real request is in progress or awaiting its result. Resolve it before changing modes."}
        </AdminNotice>
      ) : null}
      <SalesDayToolbar
        isKorean={isKorean}
        day={day}
        setDay={setDay}
        locked={locked}
        load={load}
        setReport={setReport}
        setDraft={setDraft}
        setSelectedId={setSelectedId}
        clearConfirmation={clearConfirmation}
      />
      {notice ? (
        <div role="status">
          <AdminNotice status={noticeKind} locale={locale}>
            {typeof notice === "string" ? notice : notice[locale]}
          </AdminNotice>
        </div>
      ) : null}
      {attempt ? (
        <SalesPendingAttempt
          isKorean={isKorean}
          locale={locale}
          setDraft={setDraft}
          setSelectedId={setSelectedId}
          resolutionRead={resolutionRead}
          resolutionConfirmed={resolutionConfirmed}
          setResolutionConfirmed={setResolutionConfirmed}
          busy={busy}
          setNotice={setNotice}
          setNoticeKind={setNoticeKind}
          attempt={attempt}
          remember={remember}
          load={load}
          run={run}
        />
      ) : null}
      {report ? (
        <div className={styles.reportStack}>
          <SalesReportSummary isKorean={isKorean} locale={locale} report={report} />
          <div className={styles.ledgerWorkspace}>
            <div className={styles.ledgerMain}>
              <SalesEntryList
                isKorean={isKorean}
                locale={locale}
                day={day}
                report={report}
                draft={draft}
                setDraft={setDraft}
                setSelectedId={setSelectedId}
                setSearch={setSearch}
                setManualAmount={setManualAmount}
                preview={preview}
                setObservedNow={setObservedNow}
                locked={locked}
                open={open}
                clearConfirmation={clearConfirmation}
                selectEntry={selectEntry}
              />
              {draft ? (
                <SalesDraftEditor
                  isKorean={isKorean}
                  locale={locale}
                  products={products}
                  day={day}
                  draft={draft}
                  search={search}
                  setSearch={setSearch}
                  setManualAmount={setManualAmount}
                  voidReason={voidReason}
                  setVoidReason={setVoidReason}
                  setObservedNow={setObservedNow}
                  selected={selected}
                  locked={locked}
                  open={open}
                  run={run}
                  updateDraft={updateDraft}
                  updateRows={updateRows}
                  draftValid={draftValid}
                  unmatched={unmatched}
                  mismatched={mismatched}
                  unsaved={unsaved}
                  results={results}
                />
              ) : null}
              {preview ? (
                <SalesStockPreview
                  isKorean={isKorean}
                  day={day}
                  preview={preview}
                  stockConfirmed={stockConfirmed}
                  setStockConfirmed={setStockConfirmed}
                  locked={locked}
                  open={open}
                  run={run}
                />
              ) : null}
              {selected && selected.status !== "DRAFT" ? (
                <SalesEntryDetail
                  isKorean={isKorean}
                  locale={locale}
                  reverseReason={reverseReason}
                  setReverseReason={setReverseReason}
                  reverseDay={reverseDay}
                  setReverseDay={setReverseDay}
                  reverseTime={reverseTime}
                  setReverseTime={setReverseTime}
                  reverseConfirmed={reverseConfirmed}
                  setReverseConfirmed={setReverseConfirmed}
                  restock={restock}
                  setRestock={setRestock}
                  observedNow={observedNow}
                  setObservedNow={setObservedNow}
                  selected={selected}
                  locked={locked}
                  run={run}
                />
              ) : null}
              <SalesOnlineEvents isKorean={isKorean} locale={locale} report={report} />
            </div>
            <SalesClosePanel
              isKorean={isKorean}
              locale={locale}
              day={day}
              report={report}
              cashCompared={cashCompared}
              setCashCompared={setCashCompared}
              closeConfirmed={closeConfirmed}
              setCloseConfirmed={setCloseConfirmed}
              reopenReason={reopenReason}
              setReopenReason={setReopenReason}
              locked={locked}
              open={open}
              run={run}
              canClose={canClose}
            />
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
