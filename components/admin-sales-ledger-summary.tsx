"use client";
import type { Dispatch, SetStateAction } from "react";
import type { Locale } from "@/types/store";
import {
  validSalesDay,
  type DayReport,
  type SalesCommand,
} from "@/lib/commerce/admin-sales-api-client";
import styles from "./admin-sales-ledger.module.css";
import { AdminNotice } from "./admin-status";
import {
  type Attempt,
  type Draft,
  type Notice,
  methodLabels,
  methodNet,
  methodOrder,
  money,
  onlineKind,
  showTime,
  today,
  timeBasis,
  warnings,
} from "./admin-sales-ledger-model";

export function SalesDayToolbar({
  isKorean,
  day,
  setDay,
  locked,
  load,
  setReport,
  setDraft,
  setSelectedId,
  clearConfirmation,
}: Readonly<{
  isKorean: boolean;
  day: string;
  setDay: Dispatch<SetStateAction<string>>;
  locked: boolean;
  load: (resolving?: boolean) => Promise<void>;
  setReport: Dispatch<SetStateAction<DayReport | null>>;
  setDraft: Dispatch<SetStateAction<Draft | null>>;
  setSelectedId: Dispatch<SetStateAction<string | null>>;
  clearConfirmation: () => void;
}>) {
  return (
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
          data-admin-guide="sales.day"
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
  );
}
export function SalesPendingAttempt({
  isKorean,
  locale,
  setDraft,
  setSelectedId,
  resolutionRead,
  resolutionConfirmed,
  setResolutionConfirmed,
  busy,
  setNotice,
  setNoticeKind,
  attempt,
  remember,
  load,
  run,
}: Readonly<{
  isKorean: boolean;
  locale: Locale;
  setDraft: Dispatch<SetStateAction<Draft | null>>;
  setSelectedId: Dispatch<SetStateAction<string | null>>;
  resolutionRead: boolean;
  resolutionConfirmed: boolean;
  setResolutionConfirmed: Dispatch<SetStateAction<boolean>>;
  busy: boolean;
  setNotice: Dispatch<SetStateAction<Notice>>;
  setNoticeKind: Dispatch<SetStateAction<"neutral" | "attention">>;
  attempt: Attempt;
  remember: (value: Attempt | null) => void;
  load: (resolving?: boolean) => Promise<void>;
  run: (targetDay: string, command: SalesCommand, retry?: boolean) => Promise<void>;
}>) {
  return (
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
  );
}
export function SalesReportSummary({
  isKorean,
  locale,
  report,
}: Readonly<{
  isKorean: boolean;
  locale: Locale;
  report: DayReport;
}>) {
  return (
    <>
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
          <span>{isKorean ? "오프라인 카드 순매출" : "Offline card net sales"}</span>
          <strong>{money(report.totals.card, locale)}</strong>
        </article>
        <article>
          <span aria-hidden="true" className={styles.metricSymbol}>
            ▤
          </span>
          <span>{isKorean ? "오프라인 현금 순매출" : "Offline cash net sales"}</span>
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
                      {isKorean ? "오프라인" : "Offline"} {methodLabels[locale][method]}
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
    </>
  );
}
export function SalesOnlineEvents({
  isKorean,
  locale,
  report,
}: Readonly<{
  isKorean: boolean;
  locale: Locale;
  report: DayReport;
}>) {
  return (
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
  );
}
