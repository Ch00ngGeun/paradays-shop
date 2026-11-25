// 역할: 모의 매출 연습의 재고 확정, 모의 일마감, 마감 스냅샷 목록 패널을 그립니다.
"use client";
import type { Dispatch, RefObject, SetStateAction } from "react";
import {
  closeTestSales,
  postTestSale,
  previewTestStock,
  reopenTestSales,
  TestSalesError,
  testSalesTotals,
  type TestSaleEntry,
  type TestSalesState,
  type TestStockPreview,
} from "@/lib/admin-ui/sales-ledger-simulation";
import styles from "./admin-sales-ledger.module.css";
import { type Editor, type Notice } from "./admin-sales-simulation-model";

export function SimulationStockPosting({
  isKorean,
  current,
  editor,
  dirty,
  preview,
  setPreview,
  stockConfirmed,
  setStockConfirmed,
  setNotice,
  setFailed,
  open,
  selected,
  perform,
  choose,
}: Readonly<{
  isKorean: boolean;
  current: RefObject<TestSalesState>;
  editor: Editor;
  dirty: boolean;
  preview: TestStockPreview | null;
  setPreview: Dispatch<SetStateAction<TestStockPreview | null>>;
  stockConfirmed: boolean;
  setStockConfirmed: Dispatch<SetStateAction<boolean>>;
  setNotice: Dispatch<SetStateAction<Notice>>;
  setFailed: Dispatch<SetStateAction<boolean>>;
  open: boolean;
  selected: TestSaleEntry | undefined;
  perform: (
    operation: (previous: TestSalesState) => TestSalesState,
    message: Notice,
  ) => TestSalesState | null;
  choose: (entry: TestSaleEntry) => void;
}>) {
  return (
    <section
      className={styles.block}
      aria-label={isKorean ? "모의 재고 확정" : "Mock stock posting"}
    >
      <h3>
        {isKorean
          ? "2. 가상 재고 예정표 → 명시 확인 → 모의 판매 확정"
          : "2. Virtual stock plan → Explicit check → Post mock sale"}
      </h3>
      <button
        type="button"
        disabled={!open || dirty || selected?.status !== "DRAFT"}
        onClick={() => {
          try {
            setPreview(previewTestStock(current.current, editor.id!));
            setStockConfirmed(false);
            setFailed(false);
            setNotice({
              ko: "가상 재고 예정표입니다. 수량을 확인한 뒤 확인란을 선택해 주세요.",
              en: "This is the virtual stock plan. Check the quantities, then tick the confirmation.",
            });
          } catch (error) {
            setPreview(null);
            setStockConfirmed(false);
            setFailed(true);
            setNotice(
              error instanceof TestSalesError
                ? error.localized
                : {
                    ko: "예정표를 확인하지 못했습니다.",
                    en: "Could not check the plan.",
                  },
            );
          }
        }}
      >
        {isKorean ? "가상 재고 예정표 확인" : "Check virtual stock plan"}
      </button>
      {preview ? (
        <>
          <div className={styles.tableWrap}>
            <table>
              <caption>
                {isKorean
                  ? "가상 재고 예정표 · 아직 차감되지 않음"
                  : "Virtual stock plan · Not deducted yet"}
              </caption>
              <thead>
                <tr>
                  <th>{isKorean ? "합성 상품" : "Synthetic product"}</th>
                  <th>{isKorean ? "현재 가상 재고" : "Current virtual stock"}</th>
                  <th>{isKorean ? "차감할 수량" : "Quantity to deduct"}</th>
                  <th>{isKorean ? "확정 후 재고" : "Stock after posting"}</th>
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((row) => (
                  <tr key={row.productId}>
                    <td>{row.name}</td>
                    <td>
                      {row.before}
                      {isKorean ? "개" : ""}
                    </td>
                    <td>
                      -{row.quantity}
                      {isKorean ? "개" : ""}
                    </td>
                    <td>
                      {row.after}
                      {isKorean ? "개" : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={stockConfirmed}
              onChange={(event) => setStockConfirmed(event.target.checked)}
            />
            {isKorean
              ? "예정표의 가상 재고 차감을 확인했습니다"
              : "I checked the virtual stock deduction in the plan"}
          </label>
          <button
            type="button"
            disabled={!stockConfirmed || dirty || !open}
            onClick={() => {
              const next = perform(
                (previous) => postTestSale(previous, preview, stockConfirmed),
                {
                  ko: "모의 판매를 확정했습니다. 가상 재고를 한 번 차감하고 확정 매출에 반영했습니다.",
                  en: "Posted the mock sale. Virtual stock was deducted once and added to posted sales.",
                },
              );
              if (next) choose(next.entries.find((e) => e.id === preview.entryId)!);
            }}
          >
            {isKorean ? "모의 판매 확정" : "Post mock sale"}
          </button>
        </>
      ) : (
        <p>
          {isKorean
            ? "저장된 초안을 선택하면 예정표를 확인할 수 있습니다."
            : "Select a saved draft to check the plan."}
        </p>
      )}
    </section>
  );
}
export function SimulationDailyClose({
  isKorean,
  won,
  dirty,
  cashCompared,
  setCashCompared,
  closeConfirmed,
  setCloseConfirmed,
  reopenReason,
  setReopenReason,
  totals,
  open,
  draftCount,
  canClose,
  clearChecks,
  perform,
}: Readonly<{
  isKorean: boolean;
  won: (n: number) => string;
  dirty: boolean;
  cashCompared: string;
  setCashCompared: Dispatch<SetStateAction<string>>;
  closeConfirmed: boolean;
  setCloseConfirmed: Dispatch<SetStateAction<boolean>>;
  reopenReason: string;
  setReopenReason: Dispatch<SetStateAction<string>>;
  totals: ReturnType<typeof testSalesTotals>;
  open: boolean;
  draftCount: number;
  canClose: boolean;
  clearChecks: () => void;
  perform: (
    operation: (previous: TestSalesState) => TestSalesState,
    message: Notice,
  ) => TestSalesState | null;
}>) {
  return (
    <section
      className={styles.block}
      aria-label={isKorean ? "모의 일마감" : "Mock daily close"}
    >
      <h3>
        {isKorean
          ? "3. 합계·현금 대조 → 모의 일마감"
          : "3. Totals and cash check → Mock daily close"}
      </h3>
      <p>
        {isKorean
          ? `현금 대조는 가상 현금 판매액 ${won(totals.cash)} 기준이며 금고 잔액이 아닙니다. 카드·이체 금액은 현금 대조에 포함하지 않습니다. 모의 온라인 매출은 합성 0원입니다.`
          : `The cash check is based on virtual cash sales of ${won(totals.cash)}, not the safe balance. Card and transfer amounts are not included. Mock online sales are a synthetic KRW 0.`}
      </p>
      {draftCount ? (
        <p className={styles.warning}>
          {isKorean
            ? `모의 작성 중 전표 ${draftCount}건이 있어 마감할 수 없습니다.`
            : `${draftCount} mock draft slips remain, so the day cannot be closed.`}
        </p>
      ) : null}
      {dirty ? (
        <p>
          {isKorean
            ? "저장하지 않은 입력이 있습니다. 저장·확정하거나 기존 전표를 다시 선택해 주세요."
            : "There is unsaved input. Save and post it, or select an existing slip again."}
        </p>
      ) : null}
      <label>
        {isKorean ? "모의 현금 수기 대조액 (원)" : "Mock handwritten cash amount (KRW)"}
        <input
          type="number"
          min="0"
          step="1"
          disabled={!open}
          required
          value={cashCompared}
          onChange={(event) => {
            setCashCompared(event.target.value);
            setCloseConfirmed(false);
          }}
        />
      </label>
      <label className={styles.check}>
        <input
          type="checkbox"
          disabled={!open}
          checked={closeConfirmed}
          onChange={(event) => setCloseConfirmed(event.target.checked)}
        />
        {isKorean
          ? "모의 합계와 현금 대조액을 확인했습니다"
          : "I checked the mock totals and cash amount"}
      </label>
      <button
        type="button"
        disabled={!canClose}
        onClick={() => {
          if (!canClose) return;
          const next = perform(
            (previous) =>
              closeTestSales(previous, Number(cashCompared), closeConfirmed),
            {
              ko: "모의 일마감을 완료했습니다. 가상 재고는 다시 차감하지 않았습니다.",
              en: "Finished the mock daily close. Virtual stock was not deducted again.",
            },
          );
          if (next) clearChecks();
        }}
      >
        {isKorean ? "모의 일마감 확정" : "Confirm mock daily close"}
      </button>
      {!open ? (
        <>
          <label>
            {isKorean ? "모의 재개방 사유" : "Mock reopen reason"}
            <input
              required
              value={reopenReason}
              maxLength={85}
              onChange={(event) => setReopenReason(event.target.value)}
            />
          </label>
          <button
            type="button"
            onClick={() => {
              const next = perform(
                (previous) => reopenTestSales(previous, reopenReason),
                {
                  ko: "모의 영업일을 재개방했습니다. 이전 마감본과 가상 재고는 유지했습니다.",
                  en: "Reopened the mock business day. Earlier closing sheets and virtual stock were kept.",
                },
              );
              if (next) clearChecks();
            }}
          >
            {isKorean ? "모의 영업일 재개방" : "Reopen mock business day"}
          </button>
        </>
      ) : null}
    </section>
  );
}
export function SimulationSnapshots({
  isKorean,
  won,
  state,
}: Readonly<{
  isKorean: boolean;
  won: (n: number) => string;
  state: TestSalesState;
}>) {
  return (
    <section
      className={styles.block}
      aria-label={isKorean ? "모의 마감 스냅샷" : "Mock closing snapshots"}
    >
      <h3>
        {isKorean
          ? "가상 마감본 · 당시 확인값"
          : "Virtual closing sheets · Values at closing"}
      </h3>
      {!state.snapshots.length ? (
        <p>
          {isKorean ? "아직 모의 마감본이 없습니다." : "No mock closing sheets yet."}
        </p>
      ) : null}
      {state.snapshots.map((snapshot) => (
        <div key={snapshot.id} className={styles.notice}>
          <h4>{snapshot.id}</h4>
          <p>
            {isKorean
              ? `모의 카드 ${won(snapshot.totals.card)} · 현금 ${won(snapshot.totals.cash)} · 이체 ${won(snapshot.totals.transfer)} · 온라인 합성 0원 · 통합 ${won(snapshot.totals.combined)}`
              : `Mock card ${won(snapshot.totals.card)} · Cash ${won(snapshot.totals.cash)} · Transfer ${won(snapshot.totals.transfer)} · Online synthetic KRW 0 · Combined ${won(snapshot.totals.combined)}`}
          </p>
          <p>
            {isKorean
              ? `확인 현금 ${won(snapshot.cashCompared)} · 모의 완료 전표 ${snapshot.entryIds.length}건 · 가상 데크 ${snapshot.stock.TEST_PRODUCT_DECK}개 · 가상 그립 ${snapshot.stock.TEST_PRODUCT_GRIP}개`
              : `Checked cash ${won(snapshot.cashCompared)} · Mock posted slips ${snapshot.entryIds.length} · Virtual decks ${snapshot.stock.TEST_PRODUCT_DECK} · Virtual grips ${snapshot.stock.TEST_PRODUCT_GRIP}`}
          </p>
          <p>
            {isKorean
              ? `전표 목록: ${snapshot.entryIds.join(", ") || "없음"} · 마감 재차감 0개`
              : `Slips: ${snapshot.entryIds.join(", ") || "None"} · Deducted again at closing: 0`}
          </p>
        </div>
      ))}
      {state.reopenReasons.map((reason, index) => (
        <p key={index}>
          {isKorean ? "가상 재개방 기록" : "Virtual reopen record"} {index + 1}:{" "}
          {reason}
        </p>
      ))}
    </section>
  );
}
