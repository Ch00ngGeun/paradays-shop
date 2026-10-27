/** Minimal admin order operations on the existing refund function; no browser or client payment proof. */
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { authorizeAdmin } from "./admin-auth.js";
import { getRequiredEnvironment } from "./dynamodb-client.js";
import { jsonResponse } from "./http-response.js";
import { InventoryError, operationKey } from "./order-inventory-domain.js";
import { readOrder, releaseUnattemptedReservation } from "./order-inventory-store.js";
import type { OrderRecord } from "./order-record.js";
import {
  confirmFulfillment,
  ensureLegacyFinancialLedger,
  receiveReturn,
  refundIntent,
  startRefund,
  syncRefundPayment,
} from "./order-refunds.js";
import { isRecord, parseJsonBody } from "./request-helpers.js";
import { getTossPayment, getTossPaymentsCredentials } from "./toss-payments.js";

export function adminOrderSummary(order: OrderRecord) {
  const ledger = order.inventory;
  return {
    orderId: order.orderId,
    status: order.status,
    paymentStatus: order.paymentStatus,
    total: order.total,
    createdAt: order.createdAt,
    lines: order.lines.map((line, index) => ({
      ...line,
      line: index,
      canceledQuantity: ledger?.canceled[index] ?? 0,
      restoredQuantity: ledger?.restored[index] ?? 0,
    })),
    inventory: ledger
      ? {
          state: ledger.state,
          fulfillment: ledger.fulfillment,
          expiresAt: ledger.expiresAt,
          refundedAmount: ledger.refundedAmount,
          lastFailure: ledger.lastFailure ?? null,
          pendingRefund: ledger.pendingRefund
            ? {
                operationId: ledger.pendingRefund.operationId,
                amount: ledger.pendingRefund.amount,
                createdAt: ledger.pendingRefund.createdAt,
              }
            : null,
        }
      : null,
  };
}
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> {
  const auth = await authorizeAdmin(event);
  if (!auth.ok) return jsonResponse(auth.statusCode, { code: auth.code });
  const id = event.pathParameters?.orderId;
  if (!id || !/^[A-Za-z0-9_-]{6,64}$/.test(id))
    return jsonResponse(400, { code: "ORDER_ID_INVALID" });
  const method = event.requestContext.http.method;
  if (!["GET", "POST"].includes(method))
    return jsonResponse(405, { code: "METHOD_NOT_ALLOWED" });
  try {
    let order = await readOrder(id);
    if (!order) return jsonResponse(404, { code: "ORDER_NOT_FOUND" });
    if (method === "GET") return jsonResponse(200, { order: adminOrderSummary(order) });
    const body = parseJsonBody(event);
    if (!isRecord(body)) return jsonResponse(400, { code: "ORDER_OPERATION_INVALID" });
    if (body.action === "fulfillment")
      order = await confirmFulfillment(
        order,
        body.state,
        String(body.operationId ?? ""),
      );
    else if (body.action === "return")
      order = await receiveReturn(
        order,
        body.rows,
        body.receiptId,
        body.resalableConfirmed,
        String(body.operationId ?? ""),
      );
    else if (
      body.action === "refund" ||
      (body.action === undefined && typeof body.cancelReason === "string")
    ) {
      const legacyFull = body.action === undefined;
      if (legacyFull && order.status === "REFUNDED")
        return jsonResponse(200, {
          order: adminOrderSummary(order),
          orderId: order.orderId,
          status: order.status,
        });
      // Preserve the former full-refund API for historic orders without manufacturing stock proof.
      if (legacyFull && order.inventory && order.inventory.state !== "LEGACY")
        return jsonResponse(400, { code: "REFUND_PHYSICAL_DISPOSITION_REQUIRED" });
      order = await ensureLegacyFinancialLedger(order);
      const request = legacyFull
        ? {
            action: "refund",
            operationId: `legacy_${operationKey(order.orderId)}`,
            disposition: "COMPENSATION",
            cancelReason: body.cancelReason,
            cancelAmount: order.total - (order.financialRefundedAmount ?? 0),
            rows: [],
          }
        : body;
      const intent = refundIntent(order, request);
      // Completed replay does not need provider credentials or a second monetary request.
      const credentials = await getTossPaymentsCredentials(
        getRequiredEnvironment("TOSS_PAYMENTS_SECRET_ARN"),
      );
      order = await startRefund(order, intent, credentials);
    } else if (body.action === "reconcile") {
      if (
        order.inventory?.state === "RESERVED" &&
        !order.inventory.approvalAttemptedAt &&
        Date.parse(order.inventory.expiresAt) <= Date.now()
      ) {
        order = await releaseUnattemptedReservation(order);
        return jsonResponse(200, { order: adminOrderSummary(order) });
      }
      const paymentKey = order.inventory?.paymentKey ?? order.providerPaymentKey;
      if (!paymentKey) return jsonResponse(409, { code: "PAYMENT_KEY_UNAVAILABLE" });
      const credentials = await getTossPaymentsCredentials(
        getRequiredEnvironment("TOSS_PAYMENTS_SECRET_ARN"),
      );
      order = await syncRefundPayment(
        order,
        await getTossPayment({ credentials, paymentKey }),
      );
    } else return jsonResponse(400, { code: "ORDER_OPERATION_INVALID" });
    return jsonResponse(200, {
      order: adminOrderSummary(order),
      orderId: order.orderId,
      status: order.status,
    });
  } catch (error) {
    return jsonResponse(error instanceof InventoryError ? error.status : 503, {
      code:
        error instanceof InventoryError ? error.code : "ORDER_OPERATION_UNAVAILABLE",
    });
  }
}
