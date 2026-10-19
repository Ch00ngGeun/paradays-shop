"use client";
import { useRef, useState } from "react";
import { useAuth } from "@/contexts/auth-context";
import {
  AdminOrderError,
  createAdminOrderApiClient,
  type AdminOrder,
  type AdminOrderOperation,
} from "@/lib/commerce/admin-order-api-client";
import styles from "./admin-order-inventory.module.css";
const money = (amount: number) => `${amount.toLocaleString("ko-KR")}원`;
const stateLabels = {
  UNCONFIRMED: "출고 여부 미확인",
  UNSHIPPED: "미출고 확인됨",
  SHIPPED: "출고 확인됨",
  RESERVED: "결제 결과 확인 대기 · 재고 예약 중",
  DEBITED: "판매 재고 차감 완료",
  RELEASED: "결제 실패·취소 확인 후 예약 해제됨",
  LEGACY: "구형 주문 · 금액 환불만 가능 · 재입고 금지",
};
const DEFINITE_REJECTIONS = new Set([
  "FULFILLMENT_INVALID",
  "REFUND_IN_PROGRESS",
  "FULFILLMENT_CANNOT_REVERSE_SHIPMENT",
  "ORDER_NOT_SHIPPABLE",
  "RETURN_INSPECTION_REQUIRED",
  "RETURN_SHIPMENT_CONFIRMATION_REQUIRED",
  "INVENTORY_DEBIT_PROOF_REQUIRED",
  "INVENTORY_ROWS_INVALID",
  "INVENTORY_RESTORE_EXCEEDS_DEBIT",
  "INVENTORY_OPERATION_REUSED",
  "INVENTORY_OPERATION_LIMIT",
  "REFUND_BODY_INVALID",
  "REFUND_AMOUNT_EXCEEDS_BALANCE",
  "REFUND_FULFILLMENT_CONFIRMATION_REQUIRED",
  "REFUND_QUANTITY_EXCEEDS_ORDER",
  "REFUND_LINE_AMOUNT_MISMATCH",
  "COMPENSATION_CANNOT_RESTOCK",
]);

/** Lives inside the existing admin overview. No unrelated sales menu or automatic provider polling. */
export function AdminOrderInventoryPanel() {
  const { getAccessToken } = useAuth();
  const [orderId, setOrderId] = useState("");
  const [order, setOrder] = useState<AdminOrder | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [notice, setNotice] = useState("");
  const [quantities, setQuantities] = useState<Record<number, string>>({});
  const [fulfillmentConfirmed, setFulfillmentConfirmed] = useState(false);
  const [resalable, setResalable] = useState(false);
  const [receiptId, setReceiptId] = useState("");
  const [reason, setReason] = useState("");
  const [amount, setAmount] = useState("");
  const [disposition, setDisposition] = useState<
    "UNSHIPPED" | "SHIPPED" | "COMPENSATION"
  >("COMPENSATION");
  const [refundConfirmed, setRefundConfirmed] = useState(false);
  const [attempt, setAttempt] = useState<{
    orderId: string;
    operation: AdminOrderOperation;
  } | null>(null);
  const rows =
    order?.lines
      .map((line) => ({
        line: line.line,
        quantity: Number(quantities[line.line] ?? 0),
      }))
      .filter((row) => row.quantity > 0) ?? [];
  const rowAmount = rows.reduce(
    (sum, row) => sum + row.quantity * (order?.lines[row.line]?.unitPrice ?? 0),
    0,
  );
  const invalidRows = rows.some(
    (row) => !Number.isInteger(row.quantity) || row.quantity > 10,
  );
  const newId = () => `admin_${crypto.randomUUID()}`;
  async function run(id: string, operation?: AdminOrderOperation, retry = false) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setNotice("");
    const mutation = operation && operation.action !== "reconcile";
    if (mutation && !retry) setAttempt({ orderId: id, operation });
    try {
      const client = createAdminOrderApiClient({
        authorizationTokenProvider: { getAccessToken },
      });
      const result = operation
        ? await client.operate(id, operation)
        : await client.load(id);
      if (!operation || result.orderId !== order?.orderId) {
        setQuantities({});
        setReceiptId("");
        setReason("");
        setAmount("");
        setDisposition("COMPENSATION");
        setResalable(false);
        setRefundConfirmed(false);
        setFulfillmentConfirmed(false);
      }
      setOrder(result);
      setOrderId(result.orderId);
      if (mutation) {
        setAttempt(null);
        setQuantities({});
        setResalable(false);
        setRefundConfirmed(false);
        setFulfillmentConfirmed(false);
      }
      const failure = result.inventory?.lastFailure;
      setNotice(
        result.inventory?.pendingRefund
          ? "환불 결과 확인이 아직 필요합니다. 새 환불을 실행하지 말고 PG 재조회로 복구해 주세요."
          : failure &&
              failure.operationId ===
                (operation && "operationId" in operation
                  ? operation.operationId
                  : undefined)
            ? `PG가 환불을 거절했습니다(${failure.code}). 재고·환불 금액은 변경하지 않았으며 잠금을 해제했습니다.`
            : "서버 기록을 확인했습니다.",
      );
    } catch (error) {
      const definite =
        error instanceof AdminOrderError &&
        (error.status === 400 || DEFINITE_REJECTIONS.has(error.code));
      if (mutation && definite) setAttempt(null);
      setNotice(
        error instanceof AdminOrderError && error.status === 401
          ? "관리자 로그인이 필요합니다."
          : definite
            ? "서버가 요청을 거절했습니다. 출고 상태·누적 수량·입력값을 확인한 뒤 다시 처리해 주세요."
            : mutation
              ? "처리 결과가 확정되지 않았습니다. 입력을 바꾸어 새 요청을 만들지 말고, 같은 요청 재시도 또는 PG 재조회로 확인해 주세요."
              : "조회하지 못했습니다. 주문번호·관리자 권한·서버 연결을 확인해 주세요.",
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  const ledger = order?.inventory;
  const editable =
    !!order && ledger?.state === "DEBITED" && !ledger.pendingRefund && !attempt;
  const refundable =
    !!order &&
    order.status === "PAID" &&
    !ledger?.pendingRefund &&
    !attempt &&
    (!ledger || ["DEBITED", "LEGACY"].includes(ledger.state));
  const legacy = !ledger || ledger.state === "LEGACY";
  return (
    <section className={styles.panel} aria-labelledby="admin-order-stock-title">
      <h2 id="admin-order-stock-title">주문 취소·반품 재고 관리</h2>
      <p>
        환불 금액과 실물 재입고를 따로 처리합니다. 출고 여부는 관리자가 확인하며, 반품은
        입고·검수한 재판매 가능 수량만 입력합니다.
      </p>
      <form
        className={styles.lookup}
        onSubmit={(event) => {
          event.preventDefault();
          void run(orderId.trim());
        }}
      >
        <label>
          주문번호
          <input
            value={orderId}
            onChange={(event) => setOrderId(event.target.value)}
            maxLength={64}
            required
            disabled={busy || !!attempt}
          />
        </label>
        <button disabled={busy || !!attempt} type="submit">
          주문 조회
        </button>
      </form>
      {notice ? <p role="status">{notice}</p> : null}
      {attempt ? (
        <div role="alert">
          <p>
            이전 요청의 완료 여부를 먼저 확인해야 합니다. 새로고침 후에도 서버 환불
            잠금·검수 접수번호 중복 방어는 유지됩니다.
          </p>
          <button
            disabled={busy}
            onClick={() => void run(attempt.orderId, attempt.operation, true)}
          >
            같은 요청 재시도
          </button>
        </div>
      ) : null}
      {order ? (
        <>
          <h3>
            {order.orderId} · {money(order.total)}
          </h3>
          <p>
            결제 기록: {order.paymentStatus} · 누적 환불:{" "}
            {money(ledger?.refundedAmount ?? 0)}
          </p>
          <p>
            {ledger
              ? `${stateLabels[ledger.state]} / ${stateLabels[ledger.fulfillment]}`
              : "구형 주문: 재고 차감 증빙 없음. 자동 재입고 불가."}
          </p>
          {ledger?.state === "RESERVED" ? (
            <p>
              예약 기준 시각: {ledger.expiresAt}. 시간이 지났다는 이유만으로 예약을
              해제하지 않습니다.
            </p>
          ) : null}
          <button
            disabled={busy}
            onClick={() => void run(order.orderId, { action: "reconcile" })}
          >
            PG 재조회·결과 복구
          </button>
          {ledger?.pendingRefund ? (
            <p role="alert">
              확인 중인 환불: {money(ledger.pendingRefund.amount)}. 출고 변경·새
              환불·반품 등록을 잠근 상태입니다.
            </p>
          ) : null}
          {ledger?.lastFailure ? (
            <p>
              최근 PG 확정 거절: {ledger.lastFailure.code}. 새 요청 전 사유를 확인해
              주세요.
            </p>
          ) : null}
          <fieldset disabled={busy || !editable}>
            <legend>출고 사실 확인</legend>
            <label>
              <input
                type="checkbox"
                checked={fulfillmentConfirmed}
                onChange={(event) => setFulfillmentConfirmed(event.target.checked)}
              />
              실제 출고 여부를 확인했습니다
            </label>
            <div className={styles.actions}>
              <button
                disabled={!fulfillmentConfirmed || ledger?.fulfillment === "SHIPPED"}
                onClick={() =>
                  void run(order.orderId, {
                    action: "fulfillment",
                    operationId: newId(),
                    state: "UNSHIPPED",
                  })
                }
              >
                미출고 확인
              </button>
              <button
                disabled={!fulfillmentConfirmed || order.status !== "PAID"}
                onClick={() =>
                  void run(order.orderId, {
                    action: "fulfillment",
                    operationId: newId(),
                    state: "SHIPPED",
                  })
                }
              >
                출고 완료 확인
              </button>
            </div>
          </fieldset>
          <div className={styles.tableWrap}>
            <table>
              <caption>원본 주문과 누적 처리 수량</caption>
              <thead>
                <tr>
                  <th>상품·옵션</th>
                  <th>주문</th>
                  <th>취소·환불 수량</th>
                  <th>재입고 완료</th>
                  <th>이번 수량</th>
                </tr>
              </thead>
              <tbody>
                {order.lines.map((line) => (
                  <tr key={line.line}>
                    <td>
                      {line.name} / {line.selectedSize}
                    </td>
                    <td>{line.quantity}</td>
                    <td>{line.canceledQuantity}</td>
                    <td>{line.restoredQuantity}</td>
                    <td>
                      <input
                        aria-label={`${line.name} ${line.selectedSize} 이번 수량`}
                        type="number"
                        min="0"
                        max={line.quantity}
                        step="1"
                        value={quantities[line.line] ?? "0"}
                        disabled={busy || !editable}
                        onChange={(event) =>
                          setQuantities({
                            ...quantities,
                            [line.line]: event.target.value,
                          })
                        }
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <fieldset disabled={busy || !refundable}>
            <legend>결제 취소·환불</legend>
            <label>
              처리 구분
              <select
                value={disposition}
                onChange={(event) => {
                  setDisposition(event.target.value as typeof disposition);
                  setRefundConfirmed(false);
                }}
              >
                <option value="COMPENSATION">
                  {legacy
                    ? "구형 주문 금액만 환불 · 재입고 없음"
                    : "보상 환불 · 재입고 없음"}
                </option>
                <option value="UNSHIPPED" disabled={legacy}>
                  미출고 상품 취소 · 취소 완료 후 수량 복원
                </option>
                <option value="SHIPPED" disabled={legacy}>
                  출고 상품 환불 · 별도 반품 검수 필요
                </option>
              </select>
            </label>
            <label>
              환불 사유
              <input
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={150}
              />
            </label>
            {disposition === "COMPENSATION" ? (
              <label>
                보상 환불 금액
                <input
                  type="number"
                  min="1"
                  max={order.total - (ledger?.refundedAmount ?? 0)}
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                />
              </label>
            ) : (
              <p>선택 수량의 환불 금액: {money(rowAmount)}</p>
            )}
            <label>
              <input
                type="checkbox"
                checked={refundConfirmed}
                onChange={(event) => setRefundConfirmed(event.target.checked)}
              />
              처리 구분·실제 취소 수량·환불 금액을 확인했습니다
            </label>
            <button
              disabled={
                !refundConfirmed ||
                !reason.trim() ||
                invalidRows ||
                (disposition === "COMPENSATION"
                  ? !Number.isSafeInteger(Number(amount)) || Number(amount) < 1
                  : !rows.length ||
                    rowAmount < 1 ||
                    ledger?.fulfillment !== disposition)
              }
              onClick={() =>
                void run(order.orderId, {
                  action: "refund",
                  operationId: newId(),
                  disposition,
                  cancelReason: reason,
                  cancelAmount:
                    disposition === "COMPENSATION" ? Number(amount) : rowAmount,
                  rows: disposition === "COMPENSATION" ? [] : rows,
                })
              }
            >
              취소·환불 실행
            </button>
          </fieldset>
          <fieldset disabled={busy || !editable || ledger?.fulfillment !== "SHIPPED"}>
            <legend>반품 입고·검수 후 재입고</legend>
            <label>
              검수 접수번호
              <input
                value={receiptId}
                onChange={(event) => setReceiptId(event.target.value)}
                maxLength={80}
              />
            </label>
            <p>
              같은 검수 건에는 같은 접수번호를 사용합니다(예: RMA-001-batch1).
              불량·미회수 상품은 이번 수량에서 제외합니다.
            </p>
            <label>
              <input
                type="checkbox"
                checked={resalable}
                onChange={(event) => setResalable(event.target.checked)}
              />
              실물 입고·검수 완료 및 재판매 가능한 수량임을 확인했습니다
            </label>
            <button
              disabled={
                !resalable ||
                !/^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/.test(receiptId) ||
                !rows.length ||
                invalidRows
              }
              onClick={() =>
                void run(order.orderId, {
                  action: "return",
                  operationId: newId(),
                  receiptId,
                  rows,
                  resalableConfirmed: true,
                })
              }
            >
              검수 수량 재입고
            </button>
          </fieldset>
          <p className={styles.note}>
            결과 불명 거래의 자동 정기 복구는 아직 연결하지 않았습니다. 관리자가
            주문번호로 조회·복구해야 하며, PG가 완료·실패를 증명하지 못하면 예약·환불
            잠금을 유지합니다.
          </p>
        </>
      ) : null}
    </section>
  );
}
