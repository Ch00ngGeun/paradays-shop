"use client";
import { useRef, useState } from "react";
import { useAuth } from "@/contexts/auth-context";
import { useLocale } from "@/contexts/locale-context";
import type { Locale } from "@/types/store";
import {
  AdminOrderError,
  createAdminOrderApiClient,
  type AdminOrder,
  type AdminOrderOperation,
} from "@/lib/commerce/admin-order-api-client";
import styles from "./admin-order-inventory.module.css";
const money = (amount: number, locale: Locale) =>
  locale === "ko"
    ? `${amount.toLocaleString("ko-KR")}원`
    : `KRW ${amount.toLocaleString("en-US")}`;
const stateLabels = {
  ko: {
    UNCONFIRMED: "출고 여부 미확인",
    UNSHIPPED: "미출고 확인됨",
    SHIPPED: "출고 확인됨",
    RESERVED: "결제 결과 확인 대기 · 재고 예약 중",
    DEBITED: "판매 재고 차감 완료",
    RELEASED: "결제 실패·취소 확인 후 예약 해제됨",
    LEGACY: "구형 주문 · 금액 환불만 가능 · 재입고 금지",
  },
  en: {
    UNCONFIRMED: "Shipment not confirmed",
    UNSHIPPED: "Confirmed not shipped",
    SHIPPED: "Confirmed shipped",
    RESERVED: "Awaiting payment result · Stock reserved",
    DEBITED: "Sold stock deducted",
    RELEASED: "Reservation released after payment failure or cancellation",
    LEGACY: "Legacy order · Amount refund only · No restock",
  },
};
type Notice = string | Readonly<Record<Locale, string>>;
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
  const { locale } = useLocale();
  const isKorean = locale === "ko";
  const [orderId, setOrderId] = useState("");
  const [order, setOrder] = useState<AdminOrder | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [notice, setNotice] = useState<Notice>("");
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
          ? {
              ko: "환불 결과 확인이 아직 필요합니다. 새 환불을 실행하지 말고 PG 재조회로 복구해 주세요.",
              en: "The refund result still needs checking. Do not start a new refund; recover it with a PG recheck.",
            }
          : failure &&
              failure.operationId ===
                (operation && "operationId" in operation
                  ? operation.operationId
                  : undefined)
            ? {
                ko: `PG가 환불을 거절했습니다(${failure.code}). 재고·환불 금액은 변경하지 않았으며 잠금을 해제했습니다.`,
                en: `The PG rejected the refund (${failure.code}). Stock and refund amounts were not changed and the lock was released.`,
              }
            : { ko: "서버 기록을 확인했습니다.", en: "Checked the server records." },
      );
    } catch (error) {
      const definite =
        error instanceof AdminOrderError &&
        (error.status === 400 || DEFINITE_REJECTIONS.has(error.code));
      if (mutation && definite) setAttempt(null);
      setNotice(
        error instanceof AdminOrderError && error.status === 401
          ? { ko: "관리자 로그인이 필요합니다.", en: "Admin sign-in is required." }
          : definite
            ? {
                ko: "서버가 요청을 거절했습니다. 출고 상태·누적 수량·입력값을 확인한 뒤 다시 처리해 주세요.",
                en: "The server rejected the request. Check the shipment status, cumulative quantities and input, then try again.",
              }
            : mutation
              ? {
                  ko: "처리 결과가 확정되지 않았습니다. 입력을 바꾸어 새 요청을 만들지 말고, 같은 요청 재시도 또는 PG 재조회로 확인해 주세요.",
                  en: "The result is not confirmed. Do not change the input to make a new request; check by retrying the same request or with a PG recheck.",
                }
              : {
                  ko: "조회하지 못했습니다. 주문번호·관리자 권한·서버 연결을 확인해 주세요.",
                  en: "Could not look it up. Check the order number, admin permissions and server connection.",
                },
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
      <h2 id="admin-order-stock-title">
        {isKorean ? "주문 취소·반품 재고 관리" : "Order cancellation and return stock"}
      </h2>
      <p>
        {isKorean
          ? "환불 금액과 실물 재입고를 따로 처리합니다. 출고 여부는 관리자가 확인하며, 반품은 입고·검수한 재판매 가능 수량만 입력합니다."
          : "Refund amounts and physical restocking are handled separately. Admins confirm shipment, and returns take only resalable quantities that were received and inspected."}
      </p>
      <form
        className={styles.lookup}
        onSubmit={(event) => {
          event.preventDefault();
          void run(orderId.trim());
        }}
      >
        <label>
          {isKorean ? "주문번호" : "Order number"}
          <input
            data-admin-guide="home.orderLookup"
            value={orderId}
            onChange={(event) => setOrderId(event.target.value)}
            maxLength={64}
            required
            disabled={busy || !!attempt}
          />
        </label>
        <button disabled={busy || !!attempt} type="submit">
          {isKorean ? "주문 조회" : "Look up order"}
        </button>
      </form>
      {notice ? (
        <p role="status">{typeof notice === "string" ? notice : notice[locale]}</p>
      ) : null}
      {attempt ? (
        <div role="alert">
          <p>
            {isKorean
              ? "이전 요청의 완료 여부를 먼저 확인해야 합니다. 새로고침 후에도 서버 환불 잠금·검수 접수번호 중복 방어는 유지됩니다."
              : "First check whether the previous request finished. The server refund lock and duplicate inspection receipt protection stay after a refresh."}
          </p>
          <button
            disabled={busy}
            onClick={() => void run(attempt.orderId, attempt.operation, true)}
          >
            {isKorean ? "같은 요청 재시도" : "Retry the same request"}
          </button>
        </div>
      ) : null}
      {order ? (
        <>
          <h3>
            {order.orderId} · {money(order.total, locale)}
          </h3>
          <p>
            {isKorean ? "결제 기록" : "Payment record"}: {order.paymentStatus} ·{" "}
            {isKorean ? "누적 환불" : "Total refunded"}:{" "}
            {money(ledger?.refundedAmount ?? 0, locale)}
          </p>
          <p>
            {ledger
              ? `${stateLabels[locale][ledger.state]} / ${stateLabels[locale][ledger.fulfillment]}`
              : isKorean
                ? "구형 주문: 재고 차감 증빙 없음. 자동 재입고 불가."
                : "Legacy order: No proof of stock deduction. Automatic restock unavailable."}
          </p>
          {ledger?.state === "RESERVED" ? (
            <p>
              {isKorean
                ? `예약 기준 시각: ${ledger.expiresAt}. 시간이 지났다는 이유만으로 예약을 해제하지 않습니다.`
                : `Reservation reference time: ${ledger.expiresAt}. A reservation is not released just because time has passed.`}
            </p>
          ) : null}
          <button
            disabled={busy}
            onClick={() => void run(order.orderId, { action: "reconcile" })}
          >
            {isKorean ? "PG 재조회·결과 복구" : "PG recheck · Recover result"}
          </button>
          {ledger?.pendingRefund ? (
            <p role="alert">
              {isKorean
                ? `확인 중인 환불: ${money(ledger.pendingRefund.amount, locale)}. 출고 변경·새 환불·반품 등록을 잠근 상태입니다.`
                : `Refund being checked: ${money(ledger.pendingRefund.amount, locale)}. Shipment changes, new refunds and return entries are locked.`}
            </p>
          ) : null}
          {ledger?.lastFailure ? (
            <p>
              {isKorean
                ? `최근 PG 확정 거절: ${ledger.lastFailure.code}. 새 요청 전 사유를 확인해 주세요.`
                : `Latest confirmed PG rejection: ${ledger.lastFailure.code}. Check the reason before a new request.`}
            </p>
          ) : null}
          <fieldset disabled={busy || !editable}>
            <legend>{isKorean ? "출고 사실 확인" : "Confirm shipment"}</legend>
            <label>
              <input
                type="checkbox"
                checked={fulfillmentConfirmed}
                onChange={(event) => setFulfillmentConfirmed(event.target.checked)}
              />
              {isKorean
                ? "실제 출고 여부를 확인했습니다"
                : "I checked whether it actually shipped"}
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
                {isKorean ? "미출고 확인" : "Confirm not shipped"}
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
                {isKorean ? "출고 완료 확인" : "Confirm shipped"}
              </button>
            </div>
          </fieldset>
          <div className={styles.tableWrap}>
            <table>
              <caption>
                {isKorean
                  ? "원본 주문과 누적 처리 수량"
                  : "Original order and cumulative quantities"}
              </caption>
              <thead>
                <tr>
                  <th>{isKorean ? "상품·옵션" : "Product · Option"}</th>
                  <th>{isKorean ? "주문" : "Ordered"}</th>
                  <th>{isKorean ? "취소·환불 수량" : "Canceled · Refunded"}</th>
                  <th>{isKorean ? "재입고 완료" : "Restocked"}</th>
                  <th>{isKorean ? "이번 수량" : "This time"}</th>
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
                        aria-label={`${line.name} ${line.selectedSize} ${isKorean ? "이번 수량" : "quantity this time"}`}
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
            <legend>
              {isKorean ? "결제 취소·환불" : "Payment cancellation · Refund"}
            </legend>
            <label>
              {isKorean ? "처리 구분" : "Handling type"}
              <select
                value={disposition}
                onChange={(event) => {
                  setDisposition(event.target.value as typeof disposition);
                  setRefundConfirmed(false);
                }}
              >
                <option value="COMPENSATION">
                  {legacy
                    ? isKorean
                      ? "구형 주문 금액만 환불 · 재입고 없음"
                      : "Legacy order amount refund only · No restock"
                    : isKorean
                      ? "보상 환불 · 재입고 없음"
                      : "Compensation refund · No restock"}
                </option>
                <option value="UNSHIPPED" disabled={legacy}>
                  {isKorean
                    ? "미출고 상품 취소 · 취소 완료 후 수량 복원"
                    : "Cancel unshipped items · Restore quantity after cancellation"}
                </option>
                <option value="SHIPPED" disabled={legacy}>
                  {isKorean
                    ? "출고 상품 환불 · 별도 반품 검수 필요"
                    : "Refund shipped items · Separate return inspection needed"}
                </option>
              </select>
            </label>
            <label>
              {isKorean ? "환불 사유" : "Refund reason"}
              <input
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={150}
              />
            </label>
            {disposition === "COMPENSATION" ? (
              <label>
                {isKorean ? "보상 환불 금액" : "Compensation refund amount"}
                <input
                  type="number"
                  min="1"
                  max={order.total - (ledger?.refundedAmount ?? 0)}
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                />
              </label>
            ) : (
              <p>
                {isKorean ? "선택 수량의 환불 금액" : "Refund for selected quantity"}:{" "}
                {money(rowAmount, locale)}
              </p>
            )}
            <label>
              <input
                type="checkbox"
                checked={refundConfirmed}
                onChange={(event) => setRefundConfirmed(event.target.checked)}
              />
              {isKorean
                ? "처리 구분·실제 취소 수량·환불 금액을 확인했습니다"
                : "I checked the handling type, actual canceled quantity and refund amount"}
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
              {isKorean ? "취소·환불 실행" : "Run cancellation · Refund"}
            </button>
          </fieldset>
          <fieldset disabled={busy || !editable || ledger?.fulfillment !== "SHIPPED"}>
            <legend>
              {isKorean
                ? "반품 입고·검수 후 재입고"
                : "Restock after return receipt · Inspection"}
            </legend>
            <label>
              {isKorean ? "검수 접수번호" : "Inspection receipt number"}
              <input
                value={receiptId}
                onChange={(event) => setReceiptId(event.target.value)}
                maxLength={80}
              />
            </label>
            <p>
              {isKorean
                ? "같은 검수 건에는 같은 접수번호를 사용합니다(예: RMA-001-batch1). 불량·미회수 상품은 이번 수량에서 제외합니다."
                : "Use the same receipt number for the same inspection (e.g. RMA-001-batch1). Leave defective or unreturned items out of this quantity."}
            </p>
            <label>
              <input
                type="checkbox"
                checked={resalable}
                onChange={(event) => setResalable(event.target.checked)}
              />
              {isKorean
                ? "실물 입고·검수 완료 및 재판매 가능한 수량임을 확인했습니다"
                : "I confirmed the items were received, inspected and are resalable"}
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
              {isKorean ? "검수 수량 재입고" : "Restock inspected quantity"}
            </button>
          </fieldset>
          <p className={styles.note}>
            {isKorean
              ? "결과 불명 거래의 자동 정기 복구는 아직 연결하지 않았습니다. 관리자가 주문번호로 조회·복구해야 하며, PG가 완료·실패를 증명하지 못하면 예약·환불 잠금을 유지합니다."
              : "Automatic periodic recovery of unclear transactions is not connected yet. Admins must look up and recover by order number, and reservation and refund locks stay until the PG proves success or failure."}
          </p>
        </>
      ) : null}
    </section>
  );
}
