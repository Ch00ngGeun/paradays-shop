/** Redirect is not payment proof. Reserve before approval; an unknown result retains its hold. */
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
    if (order.status === "PAID" && order.inventory?.state === "DEBITED")
      return jsonResponse(200, {
        orderId,
        status: order.status,
        paymentStatus: order.paymentStatus,
      });
    if (order.status !== "PENDING_PAYMENT")
      return jsonResponse(409, { code: "PAYMENT_ALREADY_RESOLVED" });
    const expired = Date.parse(order.checkoutReturnExpiresAt) <= Date.now();
    if (expired && !order.inventory)
      return jsonResponse(410, { code: "PAYMENT_RETURN_TOKEN_EXPIRED" });
    const credentials = await getTossPaymentsCredentials(
      getRequiredEnvironment("TOSS_PAYMENTS_SECRET_ARN"),
    );
    // Do not require pre-approval GET support: official lookup describes approved payments.
    // An already-attempted approval is recovered by lookup, never sent a second time.
    const recoveryOnly = expired || Boolean(order.inventory?.approvalAttemptedAt);
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
