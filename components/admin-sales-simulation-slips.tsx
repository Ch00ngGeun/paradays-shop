"use client";
import type { Dispatch, SetStateAction } from "react";
import {
  saveTestSale,
  TEST_SALES_PRODUCTS,
  type TestProductId,
  type TestSaleEntry,
  type TestSaleInput,
  type TestSalesState,
} from "@/lib/admin-ui/sales-ledger-simulation";
import type { Locale } from "@/types/store";
import styles from "./admin-sales-ledger.module.css";
import {
  blank,
  inputOf,
  methodLabels,
  rowOf,
  type Editor,
  type Notice,
} from "./admin-sales-simulation-model";

export function SimulationSlipList({
  locale,
  isKorean,
  won,
  state,
  setEditor,
  setDirty,
  open,
  clearChecks,
  choose,
  sample,
}: Readonly<{
  locale: Locale;
  isKorean: boolean;
  won: (n: number) => string;
  state: TestSalesState;
  setEditor: Dispatch<SetStateAction<Editor>>;
  setDirty: Dispatch<SetStateAction<boolean>>;
  open: boolean;
  clearChecks: () => void;
  choose: (entry: TestSaleEntry) => void;
  sample: (method: TestSaleInput["method"]) => void;
}>) {
  return (
    <section
      className={styles.block}
      aria-label={isKorean ? "모의 전표 목록" : "Mock slip list"}
    >
      <div className={styles.headingRow}>
        <h3>{isKorean ? "모의 전표 · 판매 시간순" : "Mock slips · By sale time"}</h3>
        <button
          type="button"
          disabled={!open}
          onClick={() => {
            setEditor(blank());
            setDirty(true);
            clearChecks();
          }}
        >
          {isKorean ? "새 모의 전표" : "New mock slip"}
        </button>
      </div>
      <p>
        {isKorean
          ? "예시 버튼은 입력란만 채웁니다. 직접 상품·옵션·수량·단가·금액을 편집하고 저장·확정할 수 있습니다. 실제 승인번호나 개인정보를 입력하지 마세요."
          : "Example buttons only fill the form. You can edit products, options, quantities, unit prices and amounts yourself, then save and post. Do not enter real approval numbers or personal data."}
      </p>
      <div className={styles.actions}>
        <button type="button" disabled={!open} onClick={() => sample("CARD")}>
          {isKorean ? "카드 예시 불러오기" : "Load card example"}
        </button>
        <button type="button" disabled={!open} onClick={() => sample("CASH")}>
          {isKorean ? "현금 예시 불러오기" : "Load cash example"}
        </button>
        <button type="button" disabled={!open} onClick={() => sample("TRANSFER")}>
          {isKorean ? "이체 예시 불러오기" : "Load transfer example"}
        </button>
      </div>
      <div className={styles.tableWrap}>
        <table>
          <caption>
            {isKorean ? "합성 TEST 판매 전표" : "Synthetic TEST sales slips"}
          </caption>
          <thead>
            <tr>
              <th>{isKorean ? "가상 시각" : "Virtual time"}</th>
              <th>{isKorean ? "수단" : "Method"}</th>
              <th>{isKorean ? "TEST 참조번호" : "TEST reference"}</th>
              <th>{isKorean ? "가상금액" : "Virtual amount"}</th>
              <th>{isKorean ? "상태" : "Status"}</th>
              <th>{isKorean ? "선택" : "Select"}</th>
            </tr>
          </thead>
          <tbody>
            {state.entries.map((entry) => (
              <tr key={entry.id}>
                <td>{entry.time}</td>
                <td>
                  <span className={styles.methodChip} data-method={entry.method}>
                    {methodLabels[locale][entry.method]}
                  </span>
                </td>
                <td>{entry.reference}</td>
                <td>{won(entry.amount)}</td>
                <td>
                  <span className={styles.entryStatus} data-state={entry.status}>
                    {entry.status === "DRAFT"
                      ? isKorean
                        ? "모의 작성 중"
                        : "Mock draft"
                      : isKorean
                        ? "모의 완료"
                        : "Mock posted"}
                  </span>
                </td>
                <td>
                  <button
                    type="button"
                    aria-label={
                      isKorean
                        ? `${entry.id} 모의 전표 선택`
                        : `Select mock slip ${entry.id}`
                    }
                    onClick={() => choose(entry)}
                  >
                    {isKorean ? "상세" : "Details"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!state.entries.length ? (
          <p>{isKorean ? "저장된 모의 전표가 없습니다." : "No mock slips saved."}</p>
        ) : null}
      </div>
    </section>
  );
}
export function SimulationSlipEditor({
  locale,
  isKorean,
  won,
  editor,
  dirty,
  selected,
  editable,
  sum,
  change,
  perform,
  choose,
}: Readonly<{
  locale: Locale;
  isKorean: boolean;
  won: (n: number) => string;
  editor: Editor;
  dirty: boolean;
  selected: TestSaleEntry | undefined;
  editable: boolean;
  sum: number;
  change: (value: Partial<Editor>) => void;
  perform: (
    operation: (previous: TestSalesState) => TestSalesState,
    message: Notice,
  ) => TestSalesState | null;
  choose: (entry: TestSaleEntry) => void;
}>) {
  return (
    <section
      className={styles.block}
      aria-label={isKorean ? "모의 전표 입력" : "Mock slip entry"}
    >
      <h3>
        {isKorean
          ? "1. 카드·현금 수기 입력 → 모의 초안 저장"
          : "1. Enter card and cash by hand → Save mock draft"}
      </h3>
      <p>
        {editor.id ?? (isKorean ? "아직 저장하지 않은 모의 전표" : "Unsaved mock slip")}{" "}
        ·{" "}
        {
          (selected?.status === "POSTED"
            ? {
                ko: "모의 완료 전표는 수정할 수 없습니다.",
                en: "A posted mock slip cannot be edited.",
              }
            : dirty
              ? {
                  ko: "입력 변경분을 먼저 저장해 주세요.",
                  en: "Save your changes first.",
                }
              : {
                  ko: "저장된 모의 작성 중 전표입니다.",
                  en: "This is a saved mock draft slip.",
                })[locale]
        }
      </p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!editable) return;
          const next = perform(
            (previous) =>
              saveTestSale(
                previous,
                inputOf(editor),
                editor.id ? { id: editor.id, version: editor.version! } : undefined,
              ),
            {
              ko: "모의 초안을 저장했습니다. 가상 재고·매출은 아직 바뀌지 않았습니다.",
              en: "Saved the mock draft. Virtual stock and sales have not changed yet.",
            },
          );
          if (next) {
            const saved = next.entries.find(
              (e) =>
                e.id === editor.id ||
                (!editor.id &&
                  e.reference === editor.reference.trim().toUpperCase() &&
                  e.method === editor.method),
            )!;
            choose(saved);
          }
        }}
      >
        <fieldset className={styles.fieldset} disabled={!editable}>
          <div className={styles.fields}>
            <label>
              {isKorean ? "가상 판매시각" : "Virtual sale time"}
              <input
                type="time"
                required
                value={editor.time}
                onChange={(event) => change({ time: event.target.value })}
              />
            </label>
            <label>
              {isKorean ? "모의 결제수단" : "Mock payment method"}
              <select
                value={editor.method}
                onChange={(event) =>
                  change({ method: event.target.value as Editor["method"] })
                }
              >
                {(["CARD", "CASH", "TRANSFER"] as const).map((method) => (
                  <option key={method} value={method}>
                    {methodLabels[locale][method]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {isKorean ? "TEST 전표 참조번호" : "TEST slip reference"}
              <input
                required
                maxLength={45}
                pattern="TEST_[A-Za-z0-9_-]{1,40}"
                value={editor.reference}
                onChange={(event) => change({ reference: event.target.value })}
              />
            </label>
            <label>
              {isKorean ? "가상 전표 금액 (원)" : "Virtual slip amount (KRW)"}
              <input
                type="number"
                min="1"
                max="100000000"
                step="1"
                required
                value={editor.amount}
                onChange={(event) => change({ amount: event.target.value })}
              />
            </label>
          </div>
          <div className={styles.lines}>
            {editor.lines.map((line, index) => {
              const product = TEST_SALES_PRODUCTS.find((p) => p.id === line.productId)!;
              const update = (value: Partial<Editor["lines"][number]>) =>
                change({
                  lines: editor.lines.map((row, i) =>
                    i === index ? { ...row, ...value } : row,
                  ),
                });
              return (
                <div className={styles.line} key={index}>
                  <strong>
                    {isKorean ? "합성 TEST 상품" : "Synthetic TEST product"} {index + 1}
                  </strong>
                  <label>
                    {isKorean ? "모의 상품" : "Mock product"} {index + 1}
                    <select
                      value={line.productId}
                      onChange={(event) =>
                        update(rowOf(event.target.value as TestProductId))
                      }
                    >
                      {TEST_SALES_PRODUCTS.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    {isKorean ? "모의 옵션" : "Mock option"} {index + 1}
                    <select
                      value={line.option}
                      onChange={(event) => update({ option: event.target.value })}
                    >
                      {product.options.map((option) => (
                        <option key={option} value={option}>
                          {option}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    {isKorean ? "모의 수량" : "Mock quantity"} {index + 1}
                    <input
                      type="number"
                      min="1"
                      max="10000"
                      step="1"
                      required
                      value={line.quantity}
                      onChange={(event) => update({ quantity: event.target.value })}
                    />
                  </label>
                  <label>
                    {isKorean
                      ? `모의 단가 ${index + 1} (원)`
                      : `Mock unit price ${index + 1} (KRW)`}
                    <input
                      type="number"
                      min="0"
                      max="100000000"
                      step="1"
                      required
                      value={line.unitAmount}
                      onChange={(event) => update({ unitAmount: event.target.value })}
                    />
                  </label>
                  <button
                    type="button"
                    aria-label={
                      isKorean
                        ? `모의 상품 ${index + 1} 삭제`
                        : `Delete mock product ${index + 1}`
                    }
                    onClick={() =>
                      change({ lines: editor.lines.filter((_, i) => i !== index) })
                    }
                  >
                    {isKorean ? "삭제" : "Delete"}
                  </button>
                </div>
              );
            })}
            <button
              type="button"
              disabled={editor.lines.length >= 20}
              onClick={() =>
                change({ lines: [...editor.lines, rowOf("TEST_PRODUCT_DECK")] })
              }
            >
              {isKorean ? "합성 TEST 상품 추가" : "Add synthetic TEST product"}
            </button>
          </div>
          <p>
            {isKorean ? "상품 줄 합계" : "Line total"}:{" "}
            <output aria-label={isKorean ? "모의 상품 줄 합계" : "Mock line total"}>
              {Number.isFinite(sum)
                ? won(sum)
                : isKorean
                  ? "입력 확인 필요"
                  : "Check input"}
            </output>{" "}
            {isKorean
              ? "· 전표 금액과 같아야 확정할 수 있습니다. 상품 미연결 초안은 저장할 수 있습니다."
              : "· It must equal the slip amount to post. Drafts without linked products can be saved."}
          </p>
          <button type="submit">
            {isKorean ? "모의 초안 저장" : "Save mock draft"}
          </button>
        </fieldset>
      </form>
    </section>
  );
}
