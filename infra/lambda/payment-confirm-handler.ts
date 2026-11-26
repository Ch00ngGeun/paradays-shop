/** 역할: Toss 결제 redirect 뒤 서버에서 결제를 승인·조회해 주문을 확정함. redirect는 결제 증빙이 아니며, 승인 전에 재고를 예약하고 결과를 모르면 예약을 유지함. */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { getRequiredEnvironment } from "./dynamodb-client.js";
import { jsonResponse } from "./http-response.js";
import { InventoryError } from "./order-inventory-domain.js";
import {
  markApprovalAttempt,
  readOrder,
  rejectApproval,
  reserveInventory,
  settleInventoryPayment,
} from "./order-inventory-store.js";
import { matchesCheckoutReturnToken } from "./order-record.js";
import { isRecord, parseJsonBody, readBoundedString } from "./request-helpers.js";
import {
  confirmTossPayment,
  definitiveApprovalRejection,
  getTossPayment,
  getTossPaymentsCredentials,
} from "./toss-payments.js";

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const body = parseJsonBody(event);
  if (!isRecord(body))
    return jsonResponse(400, { code: "PAYMENT_CONFIRMATION_BODY_INVALID" });
  const paymentKey = readBoundedString(body.paymentKey, 200);
  const orderId = readBoundedString(body.orderId, 64);
  const token = readBoundedString(body.checkoutReturnToken, 128);
  if (
    !paymentKey ||
    !orderId ||
    !/^[A-Za-z0-9_-]{6,64}$/.test(orderId) ||
    !token ||
    token.length < 32 ||
    typeof body.amount !== "number" ||
    !Number.isSafeInteger(body.amount) ||
    body.amount < 1
  )
    return jsonResponse(400, { code: "PAYMENT_CONFIRMATION_BODY_INVALID" });
  try {
    let order = await readOrder(orderId);
    if (!order || !matchesCheckoutReturnToken(order.checkoutReturnTokenHash, token))
      return jsonResponse(403, { code: "PAYMENT_RETURN_TOKEN_INVALID" });
    if (body.amount !== order.total)
      return jsonResponse(400, { code: "PAYMENT_AMOUNT_MISMATCH" });
    if (
      (order.inventory?.paymentKey ?? order.providerPaymentKey) &&
      (order.inventory?.paymentKey ?? order.providerPaymentKey) !== paymentKey
    )
      return jsonResponse(409, { code: "PAYMENT_KEY_CONFLICT" });
    // 기존 PAID 주문(ledger가 없거나 환불용 LEGACY ledger가 붙은 주문)은 예전처럼 성공을 재응답함.
    if (
      order.status === "PAID" &&
      (!order.inventory || ["DEBITED", "LEGACY"].includes(order.inventory.state))
    )
      return jsonResponse(200, {
        orderId,
        status: order.status,
        paymentStatus: order.paymentStatus,
      });
    // 예전 webhook이 예약이 RESERVED인 채로 PAID를 표시했을 수 있으므로 조회로 정산함.
    const paidWithHold =
      order.status === "PAID" && order.inventory?.state === "RESERVED";
    if (order.status !== "PENDING_PAYMENT" && !paidWithHold)
      return jsonResponse(409, { code: "PAYMENT_ALREADY_RESOLVED" });
    // 만료 시각을 읽을 수 없으면 fail-closed로 처리하며 새 승인을 시작하지 않음.
    const expiresAt = Date.parse(order.checkoutReturnExpiresAt);
    const expired = !Number.isFinite(expiresAt) || expiresAt <= Date.now();
    if (expired && !order.inventory)
      return jsonResponse(410, { code: "PAYMENT_RETURN_TOKEN_EXPIRED" });
    const credentials = await getTossPaymentsCredentials(
      getRequiredEnvironment("TOSS_PAYMENTS_SECRET_ARN"),
    );
    // 승인 전 GET 조회 지원을 요구하지 않음: 공식 조회는 승인된 결제를 설명함.
    // 이미 시도한 승인은 조회로 복구하며 두 번 보내지 않음.
    const recoveryOnly =
      expired || paidWithHold || Boolean(order.inventory?.approvalAttemptedAt);
    if (!recoveryOnly) {
      order = await reserveInventory(order, paymentKey);
      order = await markApprovalAttempt(order);
    }
    let payment;
    try {
      payment = recoveryOnly
        ? await getTossPayment({ credentials, paymentKey })
        : await confirmTossPayment({
            credentials,
            paymentKey,
            orderId,
            amount: order.total,
          });
    } catch (error) {
      if (!recoveryOnly && definitiveApprovalRejection(error)) {
        await rejectApproval(order, error.providerCode!);
        return jsonResponse(409, { code: "PAYMENT_APPROVAL_REJECTED" });
      }
      return jsonResponse(503, {
        code: "PAYMENT_RESULT_UNCERTAIN",
        recoveryRequired: true,
      });
    }
    const settled = await settleInventoryPayment(order, payment);
    if (settled.status !== "PAID")
      return jsonResponse(409, {
        code: expired ? "PAYMENT_RECOVERY_REQUIRED" : "PAYMENT_NOT_COMPLETED",
        recoveryRequired: true,
      });
    return jsonResponse(200, {
      orderId,
      status: settled.status,
      paymentStatus: settled.paymentStatus,
    });
  } catch (error) {
    return jsonResponse(error instanceof InventoryError ? error.status : 503, {
      code:
        error instanceof InventoryError
          ? error.code
          : "PAYMENT_STORAGE_OR_CONFIGURATION_UNAVAILABLE",
    });
  }
}
