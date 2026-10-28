"use client";
import { useRef, useState } from "react";
import {
  closeTestSales,
  createTestSales,
  postTestSale,
  previewTestStock,
  reopenTestSales,
  saveTestSale,
  TEST_SALES_PRODUCTS,
  TestSalesError,
  testSalesTotals,
  type TestProductId,
  type TestSaleEntry,
  type TestSaleInput,
  type TestSalesState,
  type TestStockPreview,
} from "@/lib/admin-ui/sales-ledger-simulation";
import type { Locale } from "@/types/store";
import { AdminStepper, type AdminStep } from "./admin-stepper";
import styles from "./admin-sales-ledger.module.css";

const methodLabels = {
  ko: { CARD: "카드", CASH: "현금", TRANSFER: "이체" },
  en: { CARD: "Card", CASH: "Cash", TRANSFER: "Transfer" },
};
type Notice = string | Readonly<Record<Locale, string>>;
type Editor = {
  id?: string;
  version?: number;
  time: string;
  method: TestSaleInput["method"];
  reference: string;
  amount: string;
  lines: {
    productId: TestProductId;
    option: string;
    quantity: string;
    unitAmount: string;
  }[];
};
const money = (n: number, locale: Locale = "ko") =>
  locale === "ko"
    ? `${n.toLocaleString("ko-KR")}원`
    : `KRW ${n.toLocaleString("en-US")}`;
const blank = (): Editor => ({
  time: "09:00",
  method: "CARD",
  reference: "TEST_CARD_001",
  amount: "",
  lines: [],
});
const editorOf = (e: TestSaleEntry): Editor => ({
  ...e,
  lines: e.lines.map((line) => ({
    ...line,
    quantity: String(line.quantity),
    unitAmount: String(line.unitAmount),
  })),
  amount: String(e.amount),
});
const rowOf = (id: TestProductId) => {
  const product = TEST_SALES_PRODUCTS.find((p) => p.id === id)!;
  return {
    productId: id,
    option: product.options[0],
    quantity: "1",
    unitAmount: String(product.unitAmount),
  };
};
function inputOf(editor: Editor): TestSaleInput {
  if (
    !editor.amount.trim() ||
    editor.lines.some((line) => !line.quantity.trim() || !line.unitAmount.trim())
  )
    throw new TestSalesError({
      ko: "가상 금액·상품 수량·단가를 입력해 주세요.",
      en: "Enter the virtual amount, product quantities and unit prices.",
    });
  return {
    time: editor.time,
    method: editor.method,
    reference: editor.reference,
    amount: Number(editor.amount),
    lines: editor.lines.map((line) => ({
      ...line,
      quantity: Number(line.quantity),
      unitAmount: Number(line.unitAmount),
    })),
  };
}

/** No real products, tokens, transport or persistent browser data enter this panel. */
export function AdminSalesSimulationPanel({
  onExit,
  locale = "ko",
}: Readonly<{ onExit: () => void; locale?: Locale }>) {
  const isKorean = locale === "ko";
  const won = (n: number) => money(n, locale);
  const [state, setState] = useState(() => createTestSales(crypto.randomUUID()));
  const current = useRef(state);
  const [editor, setEditor] = useState<Editor>(blank);
  const [dirty, setDirty] = useState(true);
  const [preview, setPreview] = useState<TestStockPreview | null>(null);
  const [stockConfirmed, setStockConfirmed] = useState(false);
  const [cashCompared, setCashCompared] = useState("");
  const [closeConfirmed, setCloseConfirmed] = useState(false);
  const [reopenReason, setReopenReason] = useState("TEST_RECHECK");
  const [notice, setNotice] = useState<Notice>("");
  const [failed, setFailed] = useState(false);
  const totals = testSalesTotals(state);
  const open = state.status === "OPEN";
  const selected = state.entries.find((e) => e.id === editor.id);
  const editable = open && selected?.status !== "POSTED";
  const draftCount = state.entries.filter((e) => e.status === "DRAFT").length;
  const sum = editor.lines.reduce(
    (total, line) => total + Number(line.quantity) * Number(line.unitAmount),
    0,
  );
  const canClose =
    open &&
    !dirty &&
    !draftCount &&
    cashCompared.trim() !== "" &&
    Number.isSafeInteger(Number(cashCompared)) &&
    Number(cashCompared) === totals.cash &&
    closeConfirmed;
  function clearChecks() {
    setPreview(null);
    setStockConfirmed(false);
    setCashCompared("");
    setCloseConfirmed(false);
  }
  function change(value: Partial<Editor>) {
    setEditor((previous) => ({ ...previous, ...value }));
    setDirty(true);
    clearChecks();
  }
  function perform(
    operation: (previous: TestSalesState) => TestSalesState,
    message: Notice,
  ) {
    try {
      const next = operation(current.current);
      current.current = next;
      setState(next);
      setNotice(message);
      setFailed(false);
      return next;
    } catch (error) {
      setFailed(true);
      setNotice(
        error instanceof TestSalesError
          ? error.localized
          : {
              ko: "모의 계산을 완료하지 못했습니다. 초기화 후 다시 체험해 주세요.",
              en: "Could not finish the mock calculation. Reset and try again.",
            },
      );
      return null;
    }
  }
  function choose(entry: TestSaleEntry) {
    setEditor(editorOf(entry));
    setDirty(false);
    clearChecks();
  }
  function sample(method: TestSaleInput["method"]) {
    const card = method === "CARD";
    const next = state.entries.filter((e) => e.method === method).length + 1;
    setEditor({
      time: card ? "09:00" : method === "CASH" ? "10:00" : "11:00",
      method,
      reference: `TEST_${method}_${String(next).padStart(3, "0")}`,
      amount: card ? "20000" : "5000",
      lines: [
        {
          ...rowOf(card ? "TEST_PRODUCT_DECK" : "TEST_PRODUCT_GRIP"),
          quantity: card ? "2" : "1",
        },
      ],
    });
    setDirty(true);
    clearChecks();
    setFailed(false);
    setNotice({
      ko: "예시를 입력란에 채웠습니다. 내용을 편집한 뒤 초안 저장 → 예정표 확인 → 모의 판매 확정을 진행해 주세요.",
      en: "Filled the form with an example. Edit it, then save the draft → check the plan → post the mock sale.",
    });
  }
  function reset() {
    const initial = createTestSales(crypto.randomUUID());
    current.current = initial;
    setState(initial);
    setEditor(blank());
    setDirty(true);
    clearChecks();
    setReopenReason("TEST_RECHECK");
    setFailed(false);
    setNotice({
      ko: "모의 전표·마감본을 모두 폐기하고 가상 재고를 데크 10개·그립 5개로 초기화했습니다.",
      en: "Discarded all mock slips and closing sheets and reset virtual stock to 10 decks and 5 grips.",
    });
  }
  const postedCount = state.entries.length - draftCount;
  const simulationSteps: AdminStep[] = [
    {
      label: isKorean ? "모의 판매 입력" : "Enter mock sale",
      state: state.entries.length ? "complete" : open ? "current" : "upcoming",
    },
    {
      label: isKorean ? "모의 판매 확정" : "Post mock sale",
      state: !state.entries.length ? "upcoming" : draftCount ? "current" : "complete",
    },
    {
      label: isKorean ? "모의 일마감" : "Mock daily close",
      state: !open ? "complete" : postedCount && !draftCount ? "current" : "upcoming",
    },
  ];
  return (
    <section className={styles.panel} aria-labelledby="sales-simulation-title">
      <AdminStepper
        label={isKorean ? "모의 매출 작업 흐름" : "Mock sales workflow"}
        steps={simulationSteps}
        locale={locale}
      />
      <header className={styles.header}>
        <p className={styles.eyebrow}>TEST · BROWSER MEMORY ONLY</p>
        <h2 id="sales-simulation-title">
          {isKorean ? "모의 매출·일마감 체험" : "Mock sales and daily close practice"}
        </h2>
        <p role="note" className={styles.warning}>
          {isKorean
            ? "모의 전용입니다. 실제 장부·재고·온라인 주문·카드 결제와 연결되지 않습니다. 합성 TEST 상품·전표·가상금액만 사용하며 실제 매출 또는 재고 검증 결과가 아닙니다."
            : "Mock only. Not connected to the real ledger, stock, online orders or card payments. Uses only synthetic TEST products, slips and virtual amounts, and is not a real sales or stock check."}
        </p>
      </header>
      <p>
        {isKorean
          ? `가상 영업일 ${state.businessDay} 안의 시각만 연습합니다. 온라인 매출은 합성 0원이며 실제 온라인 매출을 조회하지 않습니다. 브라우저 메모리에서만 동작합니다. 메뉴를 옮겼다 돌아오면 유지되며 초기화·종료·새로고침·로그아웃·계정 교체 시 폐기됩니다.`
          : `Practice only times within virtual business day ${state.businessDay}. Online sales are a synthetic KRW 0 and real online sales are never read. Runs only in browser memory. It persists when you switch menus and is discarded on reset, end, refresh, sign-out or account switch.`}
      </p>
      <div className={styles.actions}>
        <button type="button" onClick={reset}>
          {isKorean ? "모의 데이터 초기화" : "Reset mock data"}
        </button>
        <button type="button" onClick={onExit}>
          {isKorean ? "모의 체험 종료" : "End mock practice"}
        </button>
      </div>
      {notice ? (
        <p
          role={failed ? "alert" : "status"}
          className={failed ? styles.warning : styles.notice}
        >
          {typeof notice === "string" ? notice : notice[locale]}
        </p>
      ) : null}
      <div className={styles.dayStatus}>
        <h3>
          {isKorean ? "가상 영업일" : "Virtual business day"} ·{" "}
          {open
            ? isKorean
              ? "영업 중"
              : "Open"
            : isKorean
              ? "모의 마감 완료"
              : "Mock closed"}
        </h3>
        <span>
          {isKorean
            ? `모의 작성 중 ${draftCount}건 · 모의 완료 ${state.entries.length - draftCount}건`
            : `Mock drafts ${draftCount} · Mock posted ${state.entries.length - draftCount}`}
        </span>
      </div>
      <section
        className={styles.block}
        aria-label={
          isKorean ? "가상 재고와 매출 합계" : "Virtual stock and sales totals"
        }
      >
        <h3>{isKorean ? "가상 재고·확정 매출" : "Virtual stock · Posted sales"}</h3>
        <div className={styles.fields}>
          <p>
            {isKorean ? "가상 데크 재고" : "Virtual deck stock"}:{" "}
            <output aria-label={isKorean ? "가상 데크 재고" : "Virtual deck stock"}>
              {state.stock.TEST_PRODUCT_DECK}
              {isKorean ? "개" : ""}
            </output>{" "}
            {isKorean ? "(처음 10개)" : "(started at 10)"}
          </p>
          <p>
            {isKorean ? "가상 그립 재고" : "Virtual grip stock"}:{" "}
            <output aria-label={isKorean ? "가상 그립 재고" : "Virtual grip stock"}>
              {state.stock.TEST_PRODUCT_GRIP}
              {isKorean ? "개" : ""}
            </output>{" "}
            {isKorean ? "(처음 5개)" : "(started at 5)"}
          </p>
          <p>
            {isKorean ? "모의 카드" : "Mock card"}:{" "}
            <output aria-label={isKorean ? "모의 카드 매출" : "Mock card sales"}>
              {won(totals.card)}
            </output>
          </p>
          <p>
            {isKorean ? "모의 현금" : "Mock cash"}:{" "}
            <output aria-label={isKorean ? "모의 현금 매출" : "Mock cash sales"}>
              {won(totals.cash)}
            </output>
          </p>
          <p>
            {isKorean ? "모의 이체" : "Mock transfer"}:{" "}
            <output aria-label={isKorean ? "모의 이체 매출" : "Mock transfer sales"}>
              {won(totals.transfer)}
            </output>
          </p>
          <p>
            {isKorean ? "모의 온라인 (합성 0)" : "Mock online (synthetic 0)"}:{" "}
            <output aria-label={isKorean ? "모의 온라인 매출" : "Mock online sales"}>
              {won(totals.online)}
            </output>
          </p>
          <p className={styles.total}>
            {isKorean ? "모의 통합 합계" : "Mock combined total"}:{" "}
            <output aria-label={isKorean ? "모의 통합 매출" : "Mock combined sales"}>
              {won(totals.combined)}
            </output>
          </p>
        </div>
        <p>
          {isKorean
            ? "초안·예정표에서는 재고와 합계가 바뀌지 않습니다. 판매 확정에서 한 번만 차감하며 일마감에서 다시 차감하지 않습니다. 재고는 상품 총수량 기준이며 옵션별 수량이 아닙니다."
            : "Drafts and plans do not change stock or totals. Stock is deducted once when a sale is posted and not again at the daily close. Stock is the product total, not per option."}
        </p>
      </section>
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
          {editor.id ??
            (isKorean ? "아직 저장하지 않은 모의 전표" : "Unsaved mock slip")}{" "}
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
                const product = TEST_SALES_PRODUCTS.find(
                  (p) => p.id === line.productId,
                )!;
                const update = (value: Partial<Editor["lines"][number]>) =>
                  change({
                    lines: editor.lines.map((row, i) =>
                      i === index ? { ...row, ...value } : row,
                    ),
                  });
                return (
                  <div className={styles.line} key={index}>
                    <strong>
                      {isKorean ? "합성 TEST 상품" : "Synthetic TEST product"}{" "}
                      {index + 1}
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
          {isKorean
            ? "모의 현금 수기 대조액 (원)"
            : "Mock handwritten cash amount (KRW)"}
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
    </section>
  );
}
