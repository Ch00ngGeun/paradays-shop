// 역할: 매출 원장의 오프라인 전표 목록(판매 시간순), 판매 확정 전 예정 재고 변동표, 전표 상세와 원전표 반대전표 기록 화면을 그립니다.
"use client";
import type { Dispatch, SetStateAction } from "react";
import type { Locale } from "@/types/store";
import {
  validSalesDay,
  type DayReport,
  type SaleEntry,
  type SalesCommand,
} from "@/lib/commerce/admin-sales-api-client";
import styles from "./admin-sales-ledger.module.css";
import {
  type Draft,
  type Preview,
  initialTime,
  money,
  newId,
  showTime,
  statusLabels,
  methodLabels,
  today,
} from "./admin-sales-ledger-model";

export function SalesEntryList({
  isKorean,
  locale,
  day,
  report,
  draft,
  setDraft,
  setSelectedId,
  setSearch,
  setManualAmount,
  preview,
  setObservedNow,
  locked,
  open,
  clearConfirmation,
  selectEntry,
}: Readonly<{
  isKorean: boolean;
  locale: Locale;
  day: string;
  report: DayReport;
  draft: Draft | null;
  setDraft: Dispatch<SetStateAction<Draft | null>>;
  setSelectedId: Dispatch<SetStateAction<string | null>>;
  setSearch: Dispatch<SetStateAction<string>>;
  setManualAmount: Dispatch<SetStateAction<boolean>>;
  preview: Preview | null;
  setObservedNow: Dispatch<SetStateAction<number>>;
  locked: boolean;
  open: boolean;
  clearConfirmation: () => void;
  selectEntry: (e: SaleEntry) => void;
}>) {
  return (
    <section className={styles.block}>
      <div className={styles.headingRow}>
        <h3>
          {isKorean ? "오프라인 전표 · 판매 시간순" : "Offline slips · By sale time"}
        </h3>
        <button
          aria-label={isKorean ? "판매 등록 · 새 전표" : "Register sale · New slip"}
          className={styles.primary}
          data-admin-guide="sales.newEntry"
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
          <span aria-hidden="true">＋</span> {isKorean ? "판매 등록" : "Register sale"}
        </button>
      </div>
      <p>
        {isKorean
          ? "작성 중·폐기 전표는 합계에서 제외됩니다. 카드번호·고객 개인정보는 입력하지 마세요."
          : "Draft and voided slips are excluded from totals. Do not enter card numbers or customer personal data."}
      </p>
      <div className={styles.tableWrap}>
        <table>
          <caption>{isKorean ? "오프라인 판매 전표" : "Offline sales slips"}</caption>
          <thead>
            <tr>
              <th>{isKorean ? "판매시각 (한국 시간)" : "Sale time (Korea time)"}</th>
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
                <td>{money(e.kind === "REVERSAL" ? -e.amount : e.amount, locale)}</td>
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
          <p>{isKorean ? "등록된 전표가 없습니다." : "No slips registered."}</p>
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
  );
}
export function SalesStockPreview({
  isKorean,
  day,
  preview,
  stockConfirmed,
  setStockConfirmed,
  locked,
  open,
  run,
}: Readonly<{
  isKorean: boolean;
  day: string;
  preview: Preview;
  stockConfirmed: boolean;
  setStockConfirmed: Dispatch<SetStateAction<boolean>>;
  locked: boolean;
  open: boolean;
  run: (targetDay: string, command: SalesCommand, retry?: boolean) => Promise<void>;
}>) {
  return (
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
  );
}
export function SalesEntryDetail({
  isKorean,
  locale,
  reverseReason,
  setReverseReason,
  reverseDay,
  setReverseDay,
  reverseTime,
  setReverseTime,
  reverseConfirmed,
  setReverseConfirmed,
  restock,
  setRestock,
  observedNow,
  setObservedNow,
  selected,
  locked,
  run,
}: Readonly<{
  isKorean: boolean;
  locale: Locale;
  reverseReason: string;
  setReverseReason: Dispatch<SetStateAction<string>>;
  reverseDay: string;
  setReverseDay: Dispatch<SetStateAction<string>>;
  reverseTime: string;
  setReverseTime: Dispatch<SetStateAction<string>>;
  reverseConfirmed: boolean;
  setReverseConfirmed: Dispatch<SetStateAction<boolean>>;
  restock: boolean;
  setRestock: Dispatch<SetStateAction<boolean>>;
  observedNow: number;
  setObservedNow: Dispatch<SetStateAction<number>>;
  selected: SaleEntry;
  locked: boolean;
  run: (targetDay: string, command: SalesCommand, retry?: boolean) => Promise<void>;
}>) {
  return (
    <section
      className={styles.block}
      aria-label={isKorean ? "판매 전표 상세" : "Sales slip details"}
    >
      <h3>
        {selected.reference} · {statusLabels[locale][selected.status]}
      </h3>
      <p>
        {isKorean ? "판매시각" : "Sale time"} {showTime(selected.soldAt, locale)} ·{" "}
        {money(selected.amount, locale)} ·{" "}
        {selected.memo || (isKorean ? "메모 없음" : "No memo")}
      </p>
      <ul>
        {selected.lines.map((l, i) => (
          <li key={i}>
            {l.name || (isKorean ? "미매칭" : "Unmatched")} ·{" "}
            {l.option || (isKorean ? "옵션 없음" : "No option")} ·{" "}
            {isKorean ? `${l.quantity}개` : l.quantity} × {money(l.unitAmount, locale)}
          </li>
        ))}
      </ul>
      {selected.kind === "REVERSAL" ? (
        <p>
          {isKorean ? "원전표" : "Original slip"} {selected.original?.businessDay} /{" "}
          {selected.original?.entryId} ·{" "}
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
            {isKorean ? "원전표 전체 반대전표" : "Full reversal of the original slip"}
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
              Date.parse(`${reverseTime}+09:00`) < Date.parse(selected.soldAt) ||
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
  );
}
