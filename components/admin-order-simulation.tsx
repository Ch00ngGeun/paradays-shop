"use client";
import { useRef, useState } from "react";
import { useAuth } from "@/contexts/auth-context";
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
export function AdminOrderSimulationPanel() {
  const { isAuthenticated, status, user } = useAuth();
  if (status !== "authenticated" || !isAuthenticated || !user?.groups.includes("admin"))
    return null;
  return <SimulationSession key={user.sub} />;
}
function SimulationSession() {
  const [state, setState] = useState<SimulationState | null>(null);
  const current = useRef<SimulationState | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [quantity, setQuantity] = useState("1");
  const [receipt, setReceipt] = useState("TEST-RMA-001");
  const [resalable, setResalable] = useState(false);
  const [compensation, setCompensation] = useState("10000");
  const [notice, setNotice] = useState("");
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
      const initial = createSimulation(crypto.randomUUID());
      current.current = initial;
      setState(initial);
      clearInputs();
      setFailed(false);
      setNotice("TEST 주문을 생성했습니다. 먼저 ‘모의 승인 · 2개 차감’을 눌러 주세요.");
    } catch {
      setFailed(true);
      setNotice("모의 주문번호를 생성하지 못했습니다. 새로고침 후 다시 시도해 주세요.");
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
      const result = applySimulation(previous, action);
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
          : "모의 처리 중 오류가 발생했습니다. 테스트를 초기화해 주세요.",
      );
    }
  }
  function end() {
    current.current = null;
    setState(null);
    setAcknowledged(false);
    clearInputs();
    setNotice(
      "모의 테스트를 종료했습니다. 메모리의 TEST 주문·재고·검수 기록을 지웠습니다.",
    );
    setFailed(false);
  }
  const fulfillment = {
    UNCONFIRMED: "미확인",
    UNSHIPPED: "미출고 확인",
    SHIPPED: "출고 완료",
  };
  const money = (value: number) => `${value.toLocaleString("ko-KR")}원`;
  return (
    <section className={styles.panel} aria-labelledby="order-simulation-title">
      <span className={styles.badge}>모의 테스트 전용 · 실서비스 미연결</span>
      <h2 id="order-simulation-title">모의 주문·재고 테스트</h2>
      <p role="note" aria-label="실서비스 미연결 안내" className={styles.warning}>
        테스트 상품·수량·가상금액만 사용합니다. 서버·PG·실제 상품·실제 주문·실재고와
        연결되지 않습니다. 실제 결제나 재고 검증 결과가 아닙니다.
      </p>
      <p>
        브라우저 메모리에서만 동작합니다. 새로고침·로그아웃·화면 이탈·테스트 종료 시
        초기화되며 어디에도 저장되지 않습니다.
      </p>
      {!state ? (
        <>
          <label className={styles.confirmation}>
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            실제 주문·재고를 바꾸지 않는 모의 테스트임을 이해했습니다
          </label>
          <button type="button" disabled={!acknowledged} onClick={start}>
            모의 테스트 시작
          </button>
        </>
      ) : (
        <>
          <p>
            모의 주문번호: <output aria-label="모의 주문번호">{state.orderId}</output>
          </p>
          <p>
            {state.productName} · 주문 2개 · 가상 단가 {money(state.unitPrice)} · 모의
            주문 총액 {money(20_000)}
          </p>
          <div className={styles.metrics}>
            <div>
              테스트 재고{" "}
              <strong>
                <output aria-label="테스트 재고">{state.stock}</output>개
              </strong>
              <small>시작 재고 10개</small>
            </div>
            <div>
              모의 출고 상태 <strong>{fulfillment[state.fulfillment]}</strong>
              <small>{state.paid ? "모의 승인 완료" : "모의 승인 전"}</small>
            </div>
            <div>
              가상 환불 누계{" "}
              <strong>
                <output aria-label="가상 환불 누계">{state.refundedAmount}</output>원
              </strong>
              <small>실제 송금 없음</small>
            </div>
            <div>
              가상 환불 가능 잔액{" "}
              <strong>
                <output aria-label="가상 환불 가능 잔액">
                  {state.paid ? simulationBalance(state) : 0}
                </output>
                원
              </strong>
              <small>모의 승인 후 사용 가능</small>
            </div>
          </div>
          <div className={styles.actions}>
            <button
              type="button"
              disabled={state.paid}
              onClick={() => perform({ type: "approve" })}
            >
              모의 승인 · 2개 차감
            </button>
            <button
              type="button"
              disabled={!state.paid || state.fulfillment === "SHIPPED"}
              onClick={() => perform({ type: "fulfillment", state: "UNSHIPPED" })}
            >
              모의 미출고 확인
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
              모의 출고 완료 확인
            </button>
          </div>
          <fieldset disabled={!state.paid}>
            <legend>모의 부분 취소·출고 상품 환불</legend>
            <label>
              모의 처리 수량
              <input
                aria-label="모의 처리 수량"
                type="number"
                min="1"
                max="2"
                step="1"
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
              />
            </label>
            <p>
              미출고 취소는 확인 수량을 복원합니다. 출고 상품 환불은 가상금액만 환불하고
              재고를 유지합니다.
            </p>
            <div className={styles.actions}>
              <button
                type="button"
                disabled={state.fulfillment !== "UNSHIPPED"}
                onClick={() =>
                  perform({ type: "cancel-unshipped", quantity: Number(quantity) })
                }
              >
                모의 미출고 부분 취소
              </button>
              <button
                type="button"
                disabled={state.fulfillment !== "SHIPPED"}
                onClick={() =>
                  perform({ type: "refund-shipped", quantity: Number(quantity) })
                }
              >
                모의 출고 상품 환불 · 재입고 없음
              </button>
            </div>
          </fieldset>
          <fieldset disabled={!state.paid || state.fulfillment !== "SHIPPED"}>
            <legend>모의 반품 입고·검수</legend>
            <label>
              모의 검수 접수번호
              <input
                value={receipt}
                onChange={(event) => setReceipt(event.target.value)}
                maxLength={40}
              />
            </label>
            <p>
              위의 모의 처리 수량을 사용합니다. 같은 검수 건은 같은 접수번호를 사용하며
              불량·미회수 수량은 제외합니다.
            </p>
            <label className={styles.confirmation}>
              <input
                type="checkbox"
                checked={resalable}
                onChange={(event) => setResalable(event.target.checked)}
              />
              모의 입고·검수 완료와 재판매 가능 수량을 확인했습니다
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
              모의 검수 수량 재입고
            </button>
          </fieldset>
          <fieldset disabled={!state.paid}>
            <legend>모의 보상 환불 · 재입고 없음</legend>
            <label>
              모의 보상 환불 가상금액
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
              모의 보상 환불 · 재입고 없음
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
              마지막 모의 요청 재시도
            </button>
            <button
              type="button"
              onClick={() => {
                requests.current.clear();
                setLastRequest(null);
                setResalable(false);
                setNotice(
                  "새 부분 처리 준비 완료. 다음 동작은 새 모의 요청이며 누적 수량·접수번호 중복 방어는 유지됩니다.",
                );
                setFailed(false);
              }}
            >
              새 모의 부분 처리 준비
            </button>
          </div>
          <p className={styles.help}>
            같은 입력을 반복 클릭하면 같은 모의 요청으로 처리합니다. 의도적으로 다음
            부분 수량을 처리할 때만 ‘새 모의 부분 처리 준비’를 누르세요. 접수번호 중복
            방어는 초기화 전까지 유지됩니다.
          </p>
          <details>
            <summary>모의 처리 기록 보기</summary>
            <ol>
              {state.history.map((entry, index) => (
                <li key={index}>{entry}</li>
              ))}
            </ol>
          </details>
          <div className={styles.actions}>
            <button type="button" onClick={start}>
              모의 테스트 초기화
            </button>
            <button type="button" onClick={end}>
              모의 테스트 종료
            </button>
          </div>
        </>
      )}
      {notice ? (
        <p
          role={failed ? "alert" : "status"}
          aria-label="모의 처리 결과"
          className={styles.notice}
        >
          {notice}
        </p>
      ) : null}
    </section>
  );
}
