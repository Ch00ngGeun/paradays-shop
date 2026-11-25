/** 역할: Toss 결제 webhook을 받아 서버 조회 결과로 주문 결제·환불 상태를 맞추고, 같은 event를 다시 처리하지 않도록 기록함. 서명 없는 webhook 입력은 결제를 찾는 데만 쓰며, 증빙은 서버 조회와 공용 CAS ledger가 맡음. */
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { documentClient, getRequiredEnvironment } from "./dynamodb-client.js";
import { jsonResponse } from "./http-response.js";
import { readOrder } from "./order-inventory-store.js";
import { createDigest } from "./order-record.js";
import { syncRefundPayment } from "./order-refunds.js";
import {
  getHeader,
  isRecord,
  parseJsonBody,
  readBoundedString,
} from "./request-helpers.js";
import { getTossPayment, getTossPaymentsCredentials } from "./toss-payments.js";
export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const body = parseJsonBody(event);
  if (
    !isRecord(body) ||
    body.eventType !== "PAYMENT_STATUS_CHANGED" ||
    !isRecord(body.data)
  )
    return jsonResponse(200, { received: true, ignored: true });
  const paymentKey = readBoundedString(body.data.paymentKey, 200);
  if (!paymentKey) return jsonResponse(200, { received: true, ignored: true });
  try {
    const table = getRequiredEnvironment("PAYMENT_EVENT_TABLE_NAME");
    const providerEventId = createDigest(
      JSON.stringify([
        getHeader(event, "tosspayments-webhook-transmission-id") ?? "",
        event.body,
      ]),
    );
    const previous = await documentClient.send(
      new GetCommand({
        TableName: table,
        Key: { providerEventId },
        ConsistentRead: true,
      }),
    );
    if (previous.Item?.processedAt)
      return jsonResponse(200, { received: true, duplicate: true });
    const credentials = await getTossPaymentsCredentials(
      getRequiredEnvironment("TOSS_PAYMENTS_SECRET_ARN"),
    );
    const payment = await getTossPayment({ credentials, paymentKey });
    if (payment.paymentKey !== paymentKey)
      return jsonResponse(503, { code: "PAYMENT_WEBHOOK_IDENTITY_MISMATCH" });
    const order = await readOrder(payment.orderId); // 저장소 오류를 not-found나 처리 완료 이벤트로 바꾸면 안 됨
    if (!order) return jsonResponse(200, { received: true, ignored: true });
    if (
      !["DONE", "CANCELED", "PARTIAL_CANCELED", "ABORTED", "EXPIRED"].includes(
        payment.status,
      )
    )
      return jsonResponse(200, { received: true, ignored: true });
    await syncRefundPayment(order, payment);
    try {
      await documentClient.send(
        new PutCommand({
          TableName: table,
          Item: {
            providerEventId,
            orderId: order.orderId,
            providerStatus: payment.status,
            processedAt: new Date().toISOString(),
            expiresAt: Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60,
          },
          ConditionExpression: "attribute_not_exists(providerEventId)",
        }),
      );
    } catch (error) {
      if (
        !(
          error &&
          typeof error === "object" &&
          "name" in error &&
          error.name === "ConditionalCheckFailedException"
        )
      )
        throw error;
    }
    return jsonResponse(200, { received: true });
  } catch {
    return jsonResponse(503, { code: "PAYMENT_WEBHOOK_RETRY_REQUIRED" });
  }
}
