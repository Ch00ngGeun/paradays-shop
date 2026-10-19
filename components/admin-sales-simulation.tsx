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
import styles from "./admin-sales-ledger.module.css";

type Editor = {
  id?: string;
  version?: number;
  time: string;
  method: "CARD" | "CASH";
  reference: string;
  amount: string;
  lines: {
    productId: TestProductId;
    option: string;
    quantity: string;
    unitAmount: string;
  }[];
};
const money = (n: number) => `${n.toLocaleString("ko-KR")}원`;
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
    throw new TestSalesError("가상 금액·상품 수량·단가를 입력해 주세요.");
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
}: Readonly<{ onExit: () => void }>) {
  const [state, setState] = useState(() => createTestSales(crypto.randomUUID()));
  const current = useRef(state);
  const [editor, setEditor] = useState<Editor>(blank);
  const [dirty, setDirty] = useState(true);
  const [preview, setPreview] = useState<TestStockPreview | null>(null);
  const [stockConfirmed, setStockConfirmed] = useState(false);
  const [cashCompared, setCashCompared] = useState("");
  const [closeConfirmed, setCloseConfirmed] = useState(false);
  const [reopenReason, setReopenReason] = useState("TEST_RECHECK");
  const [notice, setNotice] = useState("");
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
    message: string,
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
          ? error.message
          : "모의 계산을 완료하지 못했습니다. 초기화 후 다시 체험해 주세요.",
      );
      return null;
    }
  }
  function choose(entry: TestSaleEntry) {
    setEditor(editorOf(entry));
    setDirty(false);
    clearChecks();
  }
  function sample(method: "CARD" | "CASH") {
    const card = method === "CARD";
    const next = state.entries.filter((e) => e.method === method).length + 1;
    setEditor({
      time: card ? "09:00" : "10:00",
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
    setNotice(
      "예시를 입력란에 채웠습니다. 내용을 편집한 뒤 초안 저장 → 예정표 확인 → 모의 판매 확정을 진행해 주세요.",
    );
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
    setNotice(
      "모의 전표·마감본을 모두 폐기하고 가상 재고를 데크 10개·그립 5개로 초기화했습니다.",
    );
  }
  return (
    <section className={styles.panel} aria-labelledby="sales-simulation-title">
      <header className={styles.header}>
        <p className={styles.eyebrow}>TEST · BROWSER MEMORY ONLY</p>
        <h2 id="sales-simulation-title">모의 매출·일마감 체험</h2>
        <p role="note" className={styles.warning}>
          모의 전용입니다. 실제 장부·재고·온라인 주문·카드 결제와 연결되지 않습니다.
          합성 TEST 상품·전표·가상금액만 사용하며 실제 매출 또는 재고 검증 결과가
          아닙니다.
        </p>
      </header>
      <p>
        가상 영업일 {state.businessDay} 안의 시각만 연습합니다. 온라인 매출은 합성
        0원이며 실제 온라인 매출을 조회하지 않습니다. 브라우저 메모리에서만 동작합니다.
        메뉴를 옮겼다 돌아오면 유지되며 초기화·종료·새로고침·로그아웃·계정 교체 시
        폐기됩니다.
      </p>
      <div className={styles.actions}>
        <button type="button" onClick={reset}>
          모의 데이터 초기화
        </button>
        <button type="button" onClick={onExit}>
          모의 체험 종료
        </button>
      </div>
      {notice ? (
        <p
          role={failed ? "alert" : "status"}
          className={failed ? styles.warning : styles.notice}
        >
          {notice}
        </p>
      ) : null}
      <div className={styles.dayStatus}>
        <h3>가상 영업일 · {open ? "영업 중" : "모의 마감 완료"}</h3>
        <span>
          초안 {draftCount}건 · 확정 {state.entries.length - draftCount}건
        </span>
      </div>
      <section className={styles.block} aria-label="가상 재고와 매출 합계">
        <h3>가상 재고·확정 매출</h3>
        <div className={styles.fields}>
          <p>
            가상 데크 재고:{" "}
            <output aria-label="가상 데크 재고">
              {state.stock.TEST_PRODUCT_DECK}개
            </output>{" "}
            (처음 10개)
          </p>
          <p>
            가상 그립 재고:{" "}
            <output aria-label="가상 그립 재고">
              {state.stock.TEST_PRODUCT_GRIP}개
            </output>{" "}
            (처음 5개)
          </p>
          <p>
            모의 카드: <output aria-label="모의 카드 매출">{money(totals.card)}</output>
          </p>
          <p>
            모의 현금: <output aria-label="모의 현금 매출">{money(totals.cash)}</output>
          </p>
          <p>
            모의 온라인 (합성 0):{" "}
            <output aria-label="모의 온라인 매출">{money(totals.online)}</output>
          </p>
          <p className={styles.total}>
            모의 통합 합계:{" "}
            <output aria-label="모의 통합 매출">{money(totals.combined)}</output>
          </p>
        </div>
        <p>
          초안·예정표에서는 재고와 합계가 바뀌지 않습니다. 판매 확정에서 한 번만
          차감하며 일마감에서 다시 차감하지 않습니다. 재고는 상품 총수량 기준이며 옵션별
          수량이 아닙니다.
        </p>
      </section>
      <section className={styles.block} aria-label="모의 전표 목록">
        <div className={styles.headingRow}>
          <h3>모의 전표 · 판매 시간순</h3>
          <button
            type="button"
            disabled={!open}
            onClick={() => {
              setEditor(blank());
              setDirty(true);
              clearChecks();
            }}
          >
            새 모의 전표
          </button>
        </div>
        <p>
          예시 버튼은 입력란만 채웁니다. 직접 상품·옵션·수량·단가·금액을 편집하고
          저장·확정할 수 있습니다. 실제 승인번호나 개인정보를 입력하지 마세요.
        </p>
        <div className={styles.actions}>
          <button type="button" disabled={!open} onClick={() => sample("CARD")}>
            카드 예시 불러오기
          </button>
          <button type="button" disabled={!open} onClick={() => sample("CASH")}>
            현금 예시 불러오기
          </button>
        </div>
        <div className={styles.tableWrap}>
          <table>
            <caption>합성 TEST 판매 전표</caption>
            <thead>
              <tr>
                <th>가상 시각</th>
                <th>수단</th>
                <th>TEST 참조번호</th>
                <th>가상금액</th>
                <th>상태</th>
                <th>선택</th>
              </tr>
            </thead>
            <tbody>
              {state.entries.map((entry) => (
                <tr key={entry.id}>
                  <td>{entry.time}</td>
                  <td>{entry.method === "CARD" ? "카드" : "현금"}</td>
                  <td>{entry.reference}</td>
                  <td>{money(entry.amount)}</td>
                  <td>{entry.status === "DRAFT" ? "모의 초안" : "모의 확정"}</td>
                  <td>
                    <button
                      type="button"
                      aria-label={`${entry.id} 모의 전표 선택`}
                      onClick={() => choose(entry)}
                    >
                      상세
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!state.entries.length ? <p>저장된 모의 전표가 없습니다.</p> : null}
        </div>
      </section>
      <section className={styles.block} aria-label="모의 전표 입력">
        <h3>1. 카드·현금 수기 입력 → 모의 초안 저장</h3>
        <p>
          {editor.id ?? "아직 저장하지 않은 모의 전표"} ·{" "}
          {selected?.status === "POSTED"
            ? "모의 확정 전표는 수정할 수 없습니다."
            : dirty
              ? "입력 변경분을 먼저 저장해 주세요."
              : "저장된 모의 초안입니다."}
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
              "모의 초안을 저장했습니다. 가상 재고·매출은 아직 바뀌지 않았습니다.",
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
                가상 판매시각
                <input
                  type="time"
                  required
                  value={editor.time}
                  onChange={(event) => change({ time: event.target.value })}
                />
              </label>
              <label>
                모의 결제수단
                <select
                  value={editor.method}
                  onChange={(event) =>
                    change({ method: event.target.value as "CARD" | "CASH" })
                  }
                >
                  <option value="CARD">카드</option>
                  <option value="CASH">현금</option>
                </select>
              </label>
              <label>
                TEST 전표 참조번호
                <input
                  required
                  maxLength={45}
                  pattern="TEST_[A-Za-z0-9_-]{1,40}"
                  value={editor.reference}
                  onChange={(event) => change({ reference: event.target.value })}
                />
              </label>
              <label>
                가상 전표 금액 (원)
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
                    <strong>합성 TEST 상품 {index + 1}</strong>
                    <label>
                      모의 상품 {index + 1}
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
                      모의 옵션 {index + 1}
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
                      모의 수량 {index + 1}
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
                      모의 단가 {index + 1} (원)
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
                      aria-label={`모의 상품 ${index + 1} 삭제`}
                      onClick={() =>
                        change({ lines: editor.lines.filter((_, i) => i !== index) })
                      }
                    >
                      삭제
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
                합성 TEST 상품 추가
              </button>
            </div>
            <p>
              상품 줄 합계:{" "}
              <output aria-label="모의 상품 줄 합계">
                {Number.isFinite(sum) ? money(sum) : "입력 확인 필요"}
              </output>{" "}
              · 전표 금액과 같아야 확정할 수 있습니다. 상품 미연결 초안은 저장할 수
              있습니다.
            </p>
            <button type="submit">모의 초안 저장</button>
          </fieldset>
        </form>
      </section>
      <section className={styles.block} aria-label="모의 재고 확정">
        <h3>2. 가상 재고 예정표 → 명시 확인 → 모의 판매 확정</h3>
        <button
          type="button"
          disabled={!open || dirty || selected?.status !== "DRAFT"}
          onClick={() => {
            try {
              setPreview(previewTestStock(current.current, editor.id!));
              setStockConfirmed(false);
              setFailed(false);
              setNotice(
                "가상 재고 예정표입니다. 수량을 확인한 뒤 확인란을 선택해 주세요.",
              );
            } catch (error) {
              setPreview(null);
              setStockConfirmed(false);
              setFailed(true);
              setNotice(
                error instanceof TestSalesError
                  ? error.message
                  : "예정표를 확인하지 못했습니다.",
              );
            }
          }}
        >
          가상 재고 예정표 확인
        </button>
        {preview ? (
          <>
            <div className={styles.tableWrap}>
              <table>
                <caption>가상 재고 예정표 · 아직 차감되지 않음</caption>
                <thead>
                  <tr>
                    <th>합성 상품</th>
                    <th>현재 가상 재고</th>
                    <th>차감할 수량</th>
                    <th>확정 후 재고</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((row) => (
                    <tr key={row.productId}>
                      <td>{row.name}</td>
                      <td>{row.before}개</td>
                      <td>-{row.quantity}개</td>
                      <td>{row.after}개</td>
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
              예정표의 가상 재고 차감을 확인했습니다
            </label>
            <button
              type="button"
              disabled={!stockConfirmed || dirty || !open}
              onClick={() => {
                const next = perform(
                  (previous) => postTestSale(previous, preview, stockConfirmed),
                  "모의 판매를 확정했습니다. 가상 재고를 한 번 차감하고 확정 매출에 반영했습니다.",
                );
                if (next) choose(next.entries.find((e) => e.id === preview.entryId)!);
              }}
            >
              모의 판매 확정
            </button>
          </>
        ) : (
          <p>저장된 초안을 선택하면 예정표를 확인할 수 있습니다.</p>
        )}
      </section>
      <section className={styles.block} aria-label="모의 일마감">
        <h3>3. 합계·현금 대조 → 모의 일마감</h3>
        <p>
          현금 대조는 가상 현금 판매액 {money(totals.cash)} 기준이며 금고 잔액이
          아닙니다. 모의 온라인 매출은 합성 0원입니다.
        </p>
        {draftCount ? (
          <p className={styles.warning}>
            미확정 모의 초안 {draftCount}건이 있어 마감할 수 없습니다.
          </p>
        ) : null}
        {dirty ? (
          <p>
            저장하지 않은 입력이 있습니다. 저장·확정하거나 기존 전표를 다시 선택해
            주세요.
          </p>
        ) : null}
        <label>
          모의 현금 수기 대조액 (원)
          <input
            type="number"
            min="0"
            step="1"
            disabled={!open}
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
          모의 합계와 현금 대조액을 확인했습니다
        </label>
        <button
          type="button"
          disabled={!canClose}
          onClick={() => {
            if (!canClose) return;
            const next = perform(
              (previous) =>
                closeTestSales(previous, Number(cashCompared), closeConfirmed),
              "모의 일마감을 완료했습니다. 가상 재고는 다시 차감하지 않았습니다.",
            );
            if (next) clearChecks();
          }}
        >
          모의 일마감 확정
        </button>
        {!open ? (
          <>
            <label>
              모의 재개방 사유
              <input
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
                  "모의 영업일을 재개방했습니다. 이전 마감본과 가상 재고는 유지했습니다.",
                );
                if (next) clearChecks();
              }}
            >
              모의 영업일 재개방
            </button>
          </>
        ) : null}
      </section>
      <section className={styles.block} aria-label="모의 마감 스냅샷">
        <h3>가상 마감본 · 당시 확인값</h3>
        {!state.snapshots.length ? <p>아직 모의 마감본이 없습니다.</p> : null}
        {state.snapshots.map((snapshot) => (
          <div key={snapshot.id} className={styles.notice}>
            <h4>{snapshot.id}</h4>
            <p>
              모의 카드 {money(snapshot.totals.card)} · 현금{" "}
              {money(snapshot.totals.cash)} · 온라인 합성 0원 · 통합{" "}
              {money(snapshot.totals.combined)}
            </p>
            <p>
              확인 현금 {money(snapshot.cashCompared)} · 확정 전표{" "}
              {snapshot.entryIds.length}건 · 가상 데크{" "}
              {snapshot.stock.TEST_PRODUCT_DECK}개 · 가상 그립{" "}
              {snapshot.stock.TEST_PRODUCT_GRIP}개
            </p>
            <p>전표 목록: {snapshot.entryIds.join(", ") || "없음"} · 마감 재차감 0개</p>
          </div>
        ))}
        {state.reopenReasons.map((reason, index) => (
          <p key={index}>
            가상 재개방 기록 {index + 1}: {reason}
          </p>
        ))}
      </section>
    </section>
  );
}
