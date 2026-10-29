"use client";
import { useRef, useState } from "react";
import { useAuth } from "@/contexts/auth-context";
import type { Locale } from "@/types/store";
import {
  applySimulation,
  createSimulation,
  SimulationError,
  simulationBalance,
  type SimulationAction,
  type SimulationCommand,
  type SimulationState,
} from "@/lib/admin-ui/order-inventory-simulation";
import styles from "./admin-order-simulation.module.css";

/** Separate teaching panel, never an adapter for the real order/checkout APIs. */
export function AdminOrderSimulationPanel({ locale = "ko" }: { locale?: Locale }) {
  const { isAuthenticated, status, user } = useAuth();
  if (status !== "authenticated" || !isAuthenticated || !user?.groups.includes("admin"))
    return null;
  return <AdminOrderSimulationSession key={user.sub} locale={locale} />;
}
type Notice = string | Readonly<Record<Locale, string>>;
/** The mock test body. Exported so unit tests can render it without the panel's auth gate. */
export function AdminOrderSimulationSession({ locale }: { locale: Locale }) {
  const isKorean = locale === "ko";
  const [state, setState] = useState<SimulationState | null>(null);
  const current = useRef<SimulationState | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [quantity, setQuantity] = useState("1");
  const [receipt, setReceipt] = useState("TEST-RMA-001");
  const [resalable, setResalable] = useState(false);
  const [compensation, setCompensation] = useState("10000");
  const [notice, setNotice] = useState<Notice>("");
  const [failed, setFailed] = useState(false);
  const requests = useRef(new Map<string, string>());
  const [lastRequest, setLastRequest] = useState<SimulationAction | null>(null);
  function clearInputs() {
    requests.current.clear();
    setLastRequest(null);
    setQuantity("1");
    setReceipt("TEST-RMA-001");
    setResalable(false);
    setCompensation("10000");
  }
  function start() {
    if (!acknowledged) return;
    try {
      const initial = createSimulation(crypto.randomUUID(), locale);
      current.current = initial;
      setState(initial);
      clearInputs();
      setFailed(false);
      setNotice({
        ko: "TEST 주문을 생성했습니다. 먼저 ‘모의 승인 · 2개 차감’을 눌러 주세요.",
        en: "Created a TEST order. First press ‘Mock approve · Deduct 2’.",
      });
    } catch {
      setFailed(true);
      setNotice({
        ko: "모의 주문번호를 생성하지 못했습니다. 새로고침 후 다시 시도해 주세요.",
        en: "Could not create a mock order number. Refresh and try again.",
      });
    }
  }
  function perform(command: SimulationCommand, retry?: SimulationAction) {
    const previous = current.current;
    if (!previous) return;
    try {
      const fingerprint = JSON.stringify(command);
      const operationId = requests.current.get(fingerprint) ?? crypto.randomUUID();
      requests.current.set(fingerprint, operationId);
      const action = retry ?? { ...command, operationId };
      const result = applySimulation(previous, action, locale);
      current.current = result.state;
      setState(result.state);
      setLastRequest(action);
      setFailed(false);
      setNotice(result.message);
    } catch (error) {
      setFailed(true);
      setNotice(
        error instanceof SimulationError
          ? error.message
          : {
              ko: "모의 처리 중 오류가 발생했습니다. 테스트를 초기화해 주세요.",
              en: "An error occurred during mock processing. Reset the test.",
            },
      );
    }
  }
  function end() {
    current.current = null;
    setState(null);
    setAcknowledged(false);
    clearInputs();
    setNotice({
      ko: "모의 테스트를 종료했습니다. 메모리의 TEST 주문·재고·검수 기록을 지웠습니다.",
      en: "Ended the mock test. Cleared the TEST order, stock and inspection records from memory.",
    });
    setFailed(false);
  }
  const fulfillment = isKorean
    ? { UNCONFIRMED: "미확인", UNSHIPPED: "미출고 확인", SHIPPED: "출고 완료" }
    : { UNCONFIRMED: "Unconfirmed", UNSHIPPED: "Not shipped", SHIPPED: "Shipped" };
  const money = (value: number) =>
    isKorean
      ? `${value.toLocaleString("ko-KR")}원`
      : `KRW ${value.toLocaleString("en-US")}`;
  return (
    <section className={styles.panel} aria-labelledby="order-simulation-title">
      <span className={styles.badge}>
        {isKorean
          ? "모의 테스트 전용 · 실서비스 미연결"
          : "Mock test only · Not connected to live service"}
      </span>
      <h2 id="order-simulation-title">
        {isKorean ? "모의 주문·재고 테스트" : "Mock order and stock test"}
      </h2>
      <p
        role="note"
        aria-label={isKorean ? "실서비스 미연결 안내" : "Not connected to live service"}
        className={styles.warning}
      >
        {isKorean
          ? "테스트 상품·수량·가상금액만 사용합니다. 서버·PG·실제 상품·실제 주문·실재고와 연결되지 않습니다. 실제 결제나 재고 검증 결과가 아닙니다."
          : "Uses only test products, quantities and virtual amounts. It is not connected to the server, PG, real products, real orders or real stock. It is not a real payment or stock check."}
      </p>
      <p>
        {isKorean
          ? "브라우저 메모리에서만 동작합니다. 새로고침·로그아웃·화면 이탈·테스트 종료 시 초기화되며 어디에도 저장되지 않습니다."
          : "Runs only in browser memory. It resets on refresh, sign-out, leaving the screen or ending the test, and is saved nowhere."}
      </p>
      {!state ? (
        <>
          <label className={styles.confirmation}>
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            {isKorean
              ? "실제 주문·재고를 바꾸지 않는 모의 테스트임을 이해했습니다"
              : "I understand this mock test does not change real orders or stock"}
          </label>
          <button type="button" disabled={!acknowledged} onClick={start}>
            {isKorean ? "모의 테스트 시작" : "Start mock test"}
          </button>
        </>
      ) : (
        <>
          <p>
            {isKorean ? "모의 주문번호" : "Mock order number"}:{" "}
            <output aria-label={isKorean ? "모의 주문번호" : "Mock order number"}>
              {state.orderId}
            </output>
          </p>
          <p>
            {state.productName} ·{" "}
            {isKorean
              ? `주문 2개 · 가상 단가 ${money(state.unitPrice)} · 모의 주문 총액 ${money(20_000)}`
              : `2 ordered · Virtual unit price ${money(state.unitPrice)} · Mock order total ${money(20_000)}`}
          </p>
          <div className={styles.metrics}>
            <div>
              {isKorean ? "테스트 재고" : "Test stock"}{" "}
              <strong>
                <output aria-label={isKorean ? "테스트 재고" : "Test stock"}>
                  {state.stock}
                </output>
                {isKorean ? "개" : ""}
              </strong>
              <small>{isKorean ? "시작 재고 10개" : "Starting stock 10"}</small>
            </div>
            <div>
              {isKorean ? "모의 출고 상태" : "Mock shipment status"}{" "}
              <strong>{fulfillment[state.fulfillment]}</strong>
              <small>
                {state.paid
                  ? isKorean
                    ? "모의 승인 완료"
                    : "Mock approved"
                  : isKorean
                    ? "모의 승인 전"
                    : "Not mock approved"}
              </small>
            </div>
            <div>
              {isKorean ? "가상 환불 누계" : "Virtual refunds total"}{" "}
              <strong>
                {isKorean ? "" : "KRW "}
                <output
                  aria-label={isKorean ? "가상 환불 누계" : "Virtual refunds total"}
                >
                  {isKorean
                    ? state.refundedAmount
                    : state.refundedAmount.toLocaleString("en-US")}
                </output>
                {isKorean ? "원" : ""}
              </strong>
              <small>{isKorean ? "실제 송금 없음" : "No real transfer"}</small>
            </div>
            <div>
              {isKorean ? "가상 환불 가능 잔액" : "Virtual refundable balance"}{" "}
              <strong>
                {isKorean ? "" : "KRW "}
                <output
                  aria-label={
                    isKorean ? "가상 환불 가능 잔액" : "Virtual refundable balance"
                  }
                >
                  {isKorean
                    ? state.paid
                      ? simulationBalance(state)
                      : 0
                    : (state.paid ? simulationBalance(state) : 0).toLocaleString(
                        "en-US",
                      )}
                </output>
                {isKorean ? "원" : ""}
              </strong>
              <small>
                {isKorean ? "모의 승인 후 사용 가능" : "Available after mock approval"}
              </small>
            </div>
          </div>
          <div className={styles.actions}>
            <button
              type="button"
              disabled={state.paid}
              onClick={() => perform({ type: "approve" })}
            >
              {isKorean ? "모의 승인 · 2개 차감" : "Mock approve · Deduct 2"}
            </button>
            <button
              type="button"
              disabled={!state.paid || state.fulfillment === "SHIPPED"}
              onClick={() => perform({ type: "fulfillment", state: "UNSHIPPED" })}
            >
              {isKorean ? "모의 미출고 확인" : "Mock confirm not shipped"}
            </button>
            <button
              type="button"
              disabled={
                !state.paid ||
                state.fulfillment === "SHIPPED" ||
                simulationBalance(state) === 0
              }
              onClick={() => perform({ type: "fulfillment", state: "SHIPPED" })}
            >
              {isKorean ? "모의 출고 완료 확인" : "Mock confirm shipped"}
            </button>
          </div>
          <fieldset disabled={!state.paid}>
            <legend>
              {isKorean
                ? "모의 부분 취소·출고 상품 환불"
                : "Mock partial cancel · Shipped item refund"}
            </legend>
            <label>
              {isKorean ? "모의 처리 수량" : "Mock quantity"}
              <input
                aria-label={isKorean ? "모의 처리 수량" : "Mock quantity"}
                type="number"
                min="1"
                max="2"
                step="1"
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
              />
            </label>
            <p>
              {isKorean
                ? "미출고 취소는 확인 수량을 복원합니다. 출고 상품 환불은 가상금액만 환불하고 재고를 유지합니다."
                : "Unshipped cancellation restores the confirmed quantity. Shipped item refunds return only the virtual amount and keep stock."}
            </p>
            <div className={styles.actions}>
              <button
                type="button"
                disabled={state.fulfillment !== "UNSHIPPED"}
                onClick={() =>
                  perform({ type: "cancel-unshipped", quantity: Number(quantity) })
                }
              >
                {isKorean ? "모의 미출고 부분 취소" : "Mock partial unshipped cancel"}
              </button>
              <button
                type="button"
                disabled={state.fulfillment !== "SHIPPED"}
                onClick={() =>
                  perform({ type: "refund-shipped", quantity: Number(quantity) })
                }
              >
                {isKorean
                  ? "모의 출고 상품 환불 · 재입고 없음"
                  : "Mock shipped item refund · No restock"}
              </button>
            </div>
          </fieldset>
          <fieldset disabled={!state.paid || state.fulfillment !== "SHIPPED"}>
            <legend>
              {isKorean ? "모의 반품 입고·검수" : "Mock return receipt · Inspection"}
            </legend>
            <label>
              {isKorean ? "모의 검수 접수번호" : "Mock inspection receipt number"}
              <input
                value={receipt}
                onChange={(event) => setReceipt(event.target.value)}
                maxLength={40}
              />
            </label>
            <p>
              {isKorean
                ? "위의 모의 처리 수량을 사용합니다. 같은 검수 건은 같은 접수번호를 사용하며 불량·미회수 수량은 제외합니다."
                : "Uses the mock quantity above. Use the same receipt number for the same inspection and leave out defective or unreturned items."}
            </p>
            <label className={styles.confirmation}>
              <input
                type="checkbox"
                checked={resalable}
                onChange={(event) => setResalable(event.target.checked)}
              />
              {isKorean
                ? "모의 입고·검수 완료와 재판매 가능 수량을 확인했습니다"
                : "I confirmed the mock receipt, inspection and resalable quantity"}
            </label>
            <button
              type="button"
              disabled={!resalable}
              onClick={() =>
                perform({
                  type: "receive-return",
                  quantity: Number(quantity),
                  receiptId: receipt.trim().toUpperCase(),
                  resalableConfirmed: resalable,
                })
              }
            >
              {isKorean ? "모의 검수 수량 재입고" : "Mock restock inspected quantity"}
            </button>
          </fieldset>
          <fieldset disabled={!state.paid}>
            <legend>
              {isKorean
                ? "모의 보상 환불 · 재입고 없음"
                : "Mock compensation refund · No restock"}
            </legend>
            <label>
              {isKorean
                ? "모의 보상 환불 가상금액"
                : "Mock compensation virtual amount"}
              <input
                type="number"
                min="1"
                max="20000"
                step="1"
                value={compensation}
                onChange={(event) => setCompensation(event.target.value)}
              />
            </label>
            <button
              type="button"
              onClick={() =>
                perform({ type: "compensate", amount: Number(compensation) })
              }
            >
              {isKorean
                ? "모의 보상 환불 · 재입고 없음"
                : "Mock compensation refund · No restock"}
            </button>
          </fieldset>
          <div className={styles.actions}>
            <button
              type="button"
              disabled={!lastRequest}
              onClick={() => {
                if (lastRequest) perform(lastRequest, lastRequest);
              }}
            >
              {isKorean ? "마지막 모의 요청 재시도" : "Retry last mock request"}
            </button>
            <button
              type="button"
              onClick={() => {
                requests.current.clear();
                setLastRequest(null);
                setResalable(false);
                setNotice({
                  ko: "새 부분 처리 준비 완료. 다음 동작은 새 모의 요청이며 누적 수량·접수번호 중복 방어는 유지됩니다.",
                  en: "Ready for a new partial action. The next action is a new mock request, and cumulative quantity and receipt number duplicate protection stay.",
                });
                setFailed(false);
              }}
            >
              {isKorean ? "새 모의 부분 처리 준비" : "Prepare new mock partial action"}
            </button>
          </div>
          <p className={styles.help}>
            {isKorean
              ? "같은 입력을 반복 클릭하면 같은 모의 요청으로 처리합니다. 의도적으로 다음 부분 수량을 처리할 때만 ‘새 모의 부분 처리 준비’를 누르세요. 접수번호 중복 방어는 초기화 전까지 유지됩니다."
              : "Clicking again with the same input is treated as the same mock request. Press ‘Prepare new mock partial action’ only when you intend to process the next partial quantity. Receipt number duplicate protection stays until reset."}
          </p>
          <details>
            <summary>{isKorean ? "모의 처리 기록 보기" : "View mock history"}</summary>
            <ol>
              {state.history.map((entry, index) => (
                <li key={index}>{entry}</li>
              ))}
            </ol>
          </details>
          <div className={styles.actions}>
            <button type="button" onClick={start}>
              {isKorean ? "모의 테스트 초기화" : "Reset mock test"}
            </button>
            <button type="button" onClick={end}>
              {isKorean ? "모의 테스트 종료" : "End mock test"}
            </button>
          </div>
        </>
      )}
      {notice ? (
        <p
          role={failed ? "alert" : "status"}
          aria-label={isKorean ? "모의 처리 결과" : "Mock result"}
          className={styles.notice}
        >
          {typeof notice === "string" ? notice : notice[locale]}
        </p>
      ) : null}
    </section>
  );
}
