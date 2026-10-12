/**
 * 역할: Cognito admin group 운영자가 PAID 주문을 Toss Payments 전체 취소로 환불함.
 * 기능: 역할·주문 상태·paymentKey를 서버에서 확인하고, PG 성공 후에만 REFUNDED 상태를 기록함.
 */

import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from "aws-lambda";

import { authorizeAdmin } from "./admin-auth.js";
import { documentClient, getRequiredEnvironment } from "./dynamodb-client.js";
import { jsonResponse } from "./http-response.js";
import { isOrderRecord, type OrderRecord } from "./order-record.js";
import { isRecord, parseJsonBody, readBoundedString } from "./request-helpers.js";
import {
  cancelTossPayment,
  getTossPaymentsCredentials,
  TossPaymentsApiError,
} from "./toss-payments.js";

/** POST /admin/orders/{orderId}/refunds: admin group 전체 환불 요청만 허용합니다. */
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> {
  const authorization = await authorizeAdmin(event);

  if (!authorization.ok) {
    return jsonResponse(authorization.statusCode, { code: authorization.code });
  }

  const orderId = event.pathParameters?.orderId;
  const body = parseJsonBody(event);

  if (!orderId || !isRecord(body)) {
    return jsonResponse(400, { code: "REFUND_BODY_INVALID" });
  }

  const cancelReason = readBoundedString(body.cancelReason, 200);

  if (!cancelReason) {
    return jsonResponse(400, { code: "REFUND_REASON_REQUIRED" });
  }

  let orderTableName: string;
  let tossSecretArn: string;

  try {
    orderTableName = getRequiredEnvironment("ORDER_TABLE_NAME");
    tossSecretArn = getRequiredEnvironment("TOSS_PAYMENTS_SECRET_ARN");
  } catch {
    return jsonResponse(503, { code: "REFUND_CONFIGURATION_UNAVAILABLE" });
  }

  const order = await getOrder(orderTableName, orderId);

  if (!order) {
    return jsonResponse(404, { code: "ORDER_NOT_FOUND" });
  }

  if (order.status === "REFUNDED") {
    return jsonResponse(200, { orderId: order.orderId, status: order.status });
  }

  if (order.status !== "PAID" || !order.providerPaymentKey) {
    return jsonResponse(409, { code: "ORDER_NOT_REFUNDABLE" });
  }

  let credentials;
  let payment;

  try {
    credentials = await getTossPaymentsCredentials(tossSecretArn);
    payment = await cancelTossPayment({
      credentials,
      paymentKey: order.providerPaymentKey,
      orderId: order.orderId,
      cancelReason,
    });
  } catch (error) {
    if (error instanceof TossPaymentsApiError) {
      return jsonResponse(502, { code: "REFUND_PROVIDER_REQUEST_FAILED" });
    }

    return jsonResponse(502, { code: "REFUND_PROVIDER_REQUEST_FAILED" });
  }

  if (payment.orderId !== order.orderId) {
    return jsonResponse(502, { code: "REFUND_PROVIDER_MISMATCH" });
  }

  const updatedOrder = await markOrderRefunded(orderTableName, order, payment.status);

  if (!updatedOrder) {
    return jsonResponse(409, { code: "REFUND_STATE_CONFLICT" });
  }

  return jsonResponse(200, {
    orderId: updatedOrder.orderId,
    status: updatedOrder.status,
  });
}

/** 관리자 요청도 primary key로 주문을 읽고 storage 오류와 not found를 구분합니다. */
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

/** PG 취소 뒤 PAID 상태에서만 REFUNDED로 조건부 전이해 중복 환불 상태를 막습니다. */
async function markOrderRefunded(
  orderTableName: string,
  order: OrderRecord,
  paymentStatus: string,
) {
  const timestamp = new Date().toISOString();

  try {
    const response = await documentClient.send(
      new UpdateCommand({
        TableName: orderTableName,
        Key: { orderId: order.orderId },
        ConditionExpression: "#status = :paid",
        UpdateExpression:
          "SET #status = :refunded, paymentStatus = :paymentStatus, providerPaymentStatus = :paymentStatus, refundedAt = :refundedAt, updatedAt = :updatedAt",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":paid": "PAID",
          ":refunded": "REFUNDED",
          ":paymentStatus": paymentStatus,
          ":refundedAt": timestamp,
          ":updatedAt": timestamp,
        },
        ReturnValues: "ALL_NEW",
      }),
    );

    return isOrderRecord(response.Attributes) ? response.Attributes : null;
  } catch {
    return null;
  }
}
