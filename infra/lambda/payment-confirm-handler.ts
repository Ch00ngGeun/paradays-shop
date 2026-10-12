/**
 * 역할: Toss redirect 성공 후 paymentKey를 서버에서 승인하고 주문 상태를 확정함.
 * 기능: 일회성 checkout 반환 토큰·서버 저장 금액·Toss 응답을 모두 대조해 브라우저 결제 성공을 신뢰하지 않음.
 */

import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";

import { documentClient, getRequiredEnvironment } from "./dynamodb-client.js";
import { jsonResponse } from "./http-response.js";
import { canTransitionOrder, mapTossPaymentStatus } from "./order-domain.js";
import {
  isOrderRecord,
  matchesCheckoutReturnToken,
  type OrderRecord,
} from "./order-record.js";
import { isRecord, parseJsonBody, readBoundedString } from "./request-helpers.js";
import {
  confirmTossPayment,
  getTossPaymentsCredentials,
  TossPaymentsApiError,
} from "./toss-payments.js";

/** Toss success redirect가 보내는 orderId 형식만 confirmation endpoint에 허용합니다. */
const ORDER_ID_PATTERN = /^[A-Za-z0-9_-]{6,64}$/;

/** POST /payments/confirm: redirect query의 성공 정보를 서버 주문과 대조하고 Toss 승인 API를 호출합니다. */
export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const body = parseJsonBody(event);

  if (!isRecord(body)) {
    return jsonResponse(400, { code: "PAYMENT_CONFIRMATION_BODY_INVALID" });
  }

  const paymentKey = readBoundedString(body.paymentKey, 200);
  const orderId = readBoundedString(body.orderId, 64);
  const checkoutReturnToken = readBoundedString(body.checkoutReturnToken, 128);
  const amount = body.amount;

  if (
    !paymentKey ||
    !orderId ||
    !ORDER_ID_PATTERN.test(orderId) ||
    !checkoutReturnToken ||
    checkoutReturnToken.length < 32 ||
    typeof amount !== "number" ||
    !Number.isSafeInteger(amount) ||
    amount < 1
  ) {
    return jsonResponse(400, { code: "PAYMENT_CONFIRMATION_BODY_INVALID" });
  }

  let orderTableName: string;
  let tossSecretArn: string;

  try {
    orderTableName = getRequiredEnvironment("ORDER_TABLE_NAME");
    tossSecretArn = getRequiredEnvironment("TOSS_PAYMENTS_SECRET_ARN");
  } catch {
    return jsonResponse(503, { code: "PAYMENT_CONFIGURATION_UNAVAILABLE" });
  }

  const order = await getOrder(orderTableName, orderId);

  if (
    !order ||
    !matchesCheckoutReturnToken(order.checkoutReturnTokenHash, checkoutReturnToken)
  ) {
    return jsonResponse(403, { code: "PAYMENT_RETURN_TOKEN_INVALID" });
  }

  const returnTokenExpiresAt = Date.parse(order.checkoutReturnExpiresAt);

  if (!Number.isFinite(returnTokenExpiresAt) || returnTokenExpiresAt <= Date.now()) {
    return jsonResponse(410, { code: "PAYMENT_RETURN_TOKEN_EXPIRED" });
  }

  if (order.total !== amount) {
    return jsonResponse(400, { code: "PAYMENT_AMOUNT_MISMATCH" });
  }

  if (order.status === "PAID") {
    if (order.providerPaymentKey === paymentKey) {
      return jsonResponse(200, {
        orderId: order.orderId,
        status: order.status,
        paymentStatus: order.paymentStatus,
      });
    }

    return jsonResponse(409, { code: "PAYMENT_ALREADY_RESOLVED" });
  }

  if (order.status !== "PENDING_PAYMENT") {
    return jsonResponse(409, { code: "PAYMENT_ORDER_NOT_CONFIRMABLE" });
  }

  let credentials;

  try {
    credentials = await getTossPaymentsCredentials(tossSecretArn);
  } catch {
    return jsonResponse(503, { code: "PAYMENT_PROVIDER_UNAVAILABLE" });
  }

  let payment;

  try {
    payment = await confirmTossPayment({
      credentials,
      paymentKey,
      orderId,
      // 실제 승인 호출에는 redirect amount가 아닌 서버가 저장한 amount만 씁니다.
      amount: order.total,
    });
  } catch (error) {
    if (error instanceof TossPaymentsApiError) {
      return jsonResponse(502, { code: "PAYMENT_CONFIRMATION_FAILED" });
    }

    return jsonResponse(502, { code: "PAYMENT_CONFIRMATION_FAILED" });
  }

  if (payment.orderId !== order.orderId || payment.totalAmount !== order.total) {
    return jsonResponse(502, { code: "PAYMENT_PROVIDER_MISMATCH" });
  }

  const nextStatus = mapTossPaymentStatus(payment.status);

  if (!canTransitionOrder(order.status, nextStatus)) {
    return jsonResponse(409, { code: "PAYMENT_STATUS_TRANSITION_INVALID" });
  }

  const updatedOrder = await updateOrderAfterConfirmation({
    orderTableName,
    order,
    nextStatus,
    paymentKey: payment.paymentKey,
    paymentStatus: payment.status,
    paidAt: payment.approvedAt,
  });

  if (!updatedOrder) {
    return jsonResponse(409, { code: "PAYMENT_CONFIRMATION_CONFLICT" });
  }

  return jsonResponse(200, {
    orderId: updatedOrder.orderId,
    status: updatedOrder.status,
    paymentStatus: updatedOrder.paymentStatus,
  });
}

/** orderId의 현재 레코드를 strong read로 가져와 토큰·금액 비교 기준을 고정합니다. */
async function getOrder(orderTableName: string, orderId: string) {
  try {
    const response = await documentClient.send(
      new GetCommand({
        TableName: orderTableName,
        Key: { orderId },
        ConsistentRead: true,
      }),
    );

    return isOrderRecord(response.Item) ? response.Item : null;
  } catch {
    return null;
  }
}

/** PENDING_PAYMENT 상태에서만 원자적으로 PG 결과를 기록해 중복 redirect·webhook 충돌을 제어합니다. */
async function updateOrderAfterConfirmation({
  orderTableName,
  order,
  nextStatus,
  paymentKey,
  paymentStatus,
  paidAt,
}: Readonly<{
  orderTableName: string;
  order: OrderRecord;
  nextStatus: OrderRecord["status"];
  paymentKey: string;
  paymentStatus: string;
  paidAt?: string;
}>): Promise<OrderRecord | null> {
  const timestamp = new Date().toISOString();
  const expressionAttributeValues: Record<string, unknown> = {
    ":pending": "PENDING_PAYMENT",
    ":status": nextStatus,
    ":paymentStatus": paymentStatus,
    ":providerPaymentStatus": paymentStatus,
    ":providerPaymentKey": paymentKey,
    ":updatedAt": timestamp,
  };
  const setExpressions = [
    "#status = :status",
    "paymentStatus = :paymentStatus",
    "providerPaymentStatus = :providerPaymentStatus",
    "providerPaymentKey = :providerPaymentKey",
    "updatedAt = :updatedAt",
  ];

  if (nextStatus === "PAID") {
    expressionAttributeValues[":paidAt"] = paidAt ?? timestamp;
    setExpressions.push("paidAt = :paidAt");
  }

  try {
    const response = await documentClient.send(
      new UpdateCommand({
        TableName: orderTableName,
        Key: { orderId: order.orderId },
        ConditionExpression: "#status = :pending",
        UpdateExpression: `SET ${setExpressions.join(", ")}`,
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: expressionAttributeValues,
        ReturnValues: "ALL_NEW",
      }),
    );

    return isOrderRecord(response.Attributes) ? response.Attributes : null;
  } catch (error) {
    if (!isConditionalWriteError(error)) {
      return null;
    }

    const currentOrder = await getOrder(orderTableName, order.orderId);

    return currentOrder?.status === "PAID" &&
      currentOrder.providerPaymentKey === paymentKey
      ? currentOrder
      : null;
  }
}

/** DynamoDB의 조건부 충돌만 idempotent 재조회로 처리합니다. */
function isConditionalWriteError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "ConditionalCheckFailedException"
  );
}
