"use client";
import { useRef, useState } from "react";
import {
  createTestSales,
  TestSalesError,
  testSalesTotals,
  type TestSaleEntry,
  type TestSaleInput,
  type TestSalesState,
  type TestStockPreview,
} from "@/lib/admin-ui/sales-ledger-simulation";
import type { Locale } from "@/types/store";
import { AdminStepper, type AdminStep } from "./admin-stepper";
import styles from "./admin-sales-ledger.module.css";
import {
  blank,
  editorOf,
  money,
  rowOf,
  type Editor,
  type Notice,
} from "./admin-sales-simulation-model";
import {
  SimulationDailyClose,
  SimulationSnapshots,
  SimulationStockPosting,
} from "./admin-sales-simulation-close";
import {
  SimulationSlipEditor,
  SimulationSlipList,
} from "./admin-sales-simulation-slips";

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
      <SimulationSlipList
        locale={locale}
        isKorean={isKorean}
        won={won}
        state={state}
        setEditor={setEditor}
        setDirty={setDirty}
        open={open}
        clearChecks={clearChecks}
        choose={choose}
        sample={sample}
      />
      <SimulationSlipEditor
        locale={locale}
        isKorean={isKorean}
        won={won}
        editor={editor}
        dirty={dirty}
        selected={selected}
        editable={editable}
        sum={sum}
        change={change}
        perform={perform}
        choose={choose}
      />
      <SimulationStockPosting
        isKorean={isKorean}
        current={current}
        editor={editor}
        dirty={dirty}
        preview={preview}
        setPreview={setPreview}
        stockConfirmed={stockConfirmed}
        setStockConfirmed={setStockConfirmed}
        setNotice={setNotice}
        setFailed={setFailed}
        open={open}
        selected={selected}
        perform={perform}
        choose={choose}
      />
      <SimulationDailyClose
        isKorean={isKorean}
        won={won}
        dirty={dirty}
        cashCompared={cashCompared}
        setCashCompared={setCashCompared}
        closeConfirmed={closeConfirmed}
        setCloseConfirmed={setCloseConfirmed}
        reopenReason={reopenReason}
        setReopenReason={setReopenReason}
        totals={totals}
        open={open}
        draftCount={draftCount}
        canClose={canClose}
        clearChecks={clearChecks}
        perform={perform}
      />
      <SimulationSnapshots isKorean={isKorean} won={won} state={state} />
    </section>
  );
}
