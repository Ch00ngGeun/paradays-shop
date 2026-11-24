"use client";
import type { Dispatch, SetStateAction } from "react";
import type { Locale } from "@/types/store";
import {
  type DayReport,
  type SalesCommand,
} from "@/lib/commerce/admin-sales-api-client";
import styles from "./admin-sales-ledger.module.css";
import { AdminNotice } from "./admin-status";
import {
  historyReason,
  money,
  newId,
  onlineKind,
  showTime,
  timeBasis,
} from "./admin-sales-ledger-model";

export function SalesClosePanel({
  isKorean,
  locale,
  day,
  report,
  cashCompared,
  setCashCompared,
  closeConfirmed,
  setCloseConfirmed,
  reopenReason,
  setReopenReason,
  locked,
  open,
  run,
  canClose,
}: Readonly<{
  isKorean: boolean;
  locale: Locale;
  day: string;
  report: DayReport;
  cashCompared: string;
  setCashCompared: Dispatch<SetStateAction<string>>;
  closeConfirmed: boolean;
  setCloseConfirmed: Dispatch<SetStateAction<boolean>>;
  reopenReason: string;
  setReopenReason: Dispatch<SetStateAction<string>>;
  locked: boolean;
  open: boolean;
  run: (targetDay: string, command: SalesCommand, retry?: boolean) => Promise<void>;
  canClose: boolean;
}>) {
  return (
    <section
      className={`${styles.block} ${styles.closePanel}`}
      aria-label={isKorean ? "일마감" : "Daily close"}
      data-admin-guide="sales.close"
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
            {isKorean ? "현금 순매출 수기 대조액" : "Handwritten cash net sales amount"}
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
                .map(([label, amount]) => `${label} ${money(Number(amount), locale)}`)
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
  );
}
