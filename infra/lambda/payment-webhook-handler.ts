/**
 * 역할: Toss Payments 결제 상태 webhook을 재조회·멱등 처리해 주문 상태를 보조 동기화함.
 * 기능: 일반 결제 webhook의 원문을 신뢰하지 않고 paymentKey로 Toss Core API를 재조회한 뒤 상태를 업데이트함.
 */

import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";

import { documentClient, getRequiredEnvironment } from "./dynamodb-client.js";
import { jsonResponse } from "./http-response.js";
import { canTransitionOrder, mapTossPaymentStatus } from "./order-domain.js";
import { createDigest, isOrderRecord, type OrderRecord } from "./order-record.js";
import {
  getHeader,
  isRecord,
  parseJsonBody,
  readBoundedString,
} from "./request-helpers.js";
import {
  getTossPayment,
  getTossPaymentsCredentials,
  TossPaymentsApiError,
} from "./toss-payments.js";

/** Toss 일반 결제 상태 변경 이벤트만 이 handler에서 주문 상태에 반영합니다. */
const PAYMENT_STATUS_CHANGED = "PAYMENT_STATUS_CHANGED";

/** event 기록·주문 상태 동기화 실패는 Toss가 재전송할 수 있도록 구분합니다. */
type WebhookStorageResult = "recorded" | "duplicate" | "unavailable";

/** POST /payments/webhook: General payment webhook은 서명이 없으므로 PG 재조회가 필수입니다. */
export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const body = parseJsonBody(event);

  if (
    !isRecord(body) ||
    body.eventType !== PAYMENT_STATUS_CHANGED ||
    !isRecord(body.data)
  ) {
    // 주문과 무관한 event는 Toss 재시도를 만들지 않도록 성공 응답으로 무시합니다.
    return jsonResponse(200, { received: true, ignored: true });
  }

  const paymentKey = readBoundedString(body.data.paymentKey, 200);

  if (!paymentKey) {
    return jsonResponse(200, { received: true, ignored: true });
  }

  let orderTableName: string;
  let paymentEventTableName: string;
  let tossSecretArn: string;

  try {
    orderTableName = getRequiredEnvironment("ORDER_TABLE_NAME");
    paymentEventTableName = getRequiredEnvironment("PAYMENT_EVENT_TABLE_NAME");
    tossSecretArn = getRequiredEnvironment("TOSS_PAYMENTS_SECRET_ARN");
  } catch {
    return jsonResponse(503, { code: "PAYMENT_WEBHOOK_CONFIGURATION_UNAVAILABLE" });
  }

  // 외부 event ID 원문을 저장하지 않고 해시 키로만 사용합니다. 헤더가 없으면 body 해시가 재전송 식별자가 됩니다.
  const transmissionId = createDigest(
    getHeader(event, "tosspayments-webhook-transmission-id") ??
      event.body ??
      "missing-webhook-body",
  );

  const existingEvent = await getProcessedEvent(paymentEventTableName, transmissionId);

  if (existingEvent === "unavailable") {
    return jsonResponse(503, { code: "PAYMENT_WEBHOOK_STORAGE_UNAVAILABLE" });
  }

  if (existingEvent === "processed") {
    return jsonResponse(200, { received: true, duplicate: true });
  }

  let credentials;
  let payment;

  try {
    credentials = await getTossPaymentsCredentials(tossSecretArn);
    payment = await getTossPayment({ credentials, paymentKey });
  } catch (error) {
    if (error instanceof TossPaymentsApiError) {
      return jsonResponse(503, { code: "PAYMENT_WEBHOOK_VERIFICATION_UNAVAILABLE" });
    }

    return jsonResponse(503, { code: "PAYMENT_WEBHOOK_VERIFICATION_UNAVAILABLE" });
  }

  const order = await getOrder(orderTableName, payment.orderId);

  if (order === undefined) {
    return jsonResponse(503, { code: "PAYMENT_WEBHOOK_STORAGE_UNAVAILABLE" });
  }

  if (!order || order.total !== payment.totalAmount) {
    // 존재하지 않거나 불일치한 주문은 재시도해도 해결되지 않으므로 이벤트만 소비합니다.
    const result = await recordProcessedEvent(
      paymentEventTableName,
      transmissionId,
      payment.orderId,
      "IGNORED",
    );

    if (result === "unavailable") {
      return jsonResponse(503, { code: "PAYMENT_WEBHOOK_STORAGE_UNAVAILABLE" });
    }

    return jsonResponse(200, { received: true, ignored: true });
  }

  const nextStatus = mapTossPaymentStatus(payment.status);

  if (canTransitionOrder(order.status, nextStatus)) {
    const synchronization = await synchronizeOrderStatus({
      orderTableName,
      order,
      nextStatus,
      paymentKey: payment.paymentKey,
      paymentStatus: payment.status,
      paidAt: payment.approvedAt,
    });

    if (synchronization === "unavailable") {
      return jsonResponse(503, { code: "PAYMENT_WEBHOOK_STORAGE_UNAVAILABLE" });
    }
  }

  const recordResult = await recordProcessedEvent(
    paymentEventTableName,
    transmissionId,
    order.orderId,
    payment.status,
  );

  if (recordResult === "unavailable") {
    return jsonResponse(503, { code: "PAYMENT_WEBHOOK_STORAGE_UNAVAILABLE" });
  }

  return jsonResponse(200, { received: true });
}

/** 이미 정상 처리된 webhook event만 확인해 중복 PG 전송을 빠르게 종료합니다. 저장소 장애는 재시도를 요청합니다. */
async function getProcessedEvent(
  paymentEventTableName: string,
  providerEventId: string,
): Promise<"processed" | "missing" | "unavailable"> {
  try {
    const response = await documentClient.send(
      new GetCommand({
        TableName: paymentEventTableName,
        Key: { providerEventId },
        ConsistentRead: true,
      }),
    );

    return response.Item?.processedAt ? "processed" : "missing";
  } catch {
    return "unavailable";
  }
}

/** PG에서 재조회한 orderId로 DynamoDB 주문을 읽습니다. undefined는 저장소 오류와 not found를 구분합니다. */
async function getOrder(
  orderTableName: string,
  orderId: string,
): Promise<OrderRecord | null | undefined> {
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

/** webhook과 redirect 승인이 충돌해도 PENDING_PAYMENT에서만 상태를 확정하고, 저장소 장애는 Toss 재시도로 복구합니다. */
async function synchronizeOrderStatus({
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
}>): Promise<"synchronized" | "unavailable"> {
  if (order.status === nextStatus) {
    return "synchronized";
  }

  const timestamp = new Date().toISOString();
  const expressionAttributeValues: Record<string, unknown> = {
    ":currentStatus": order.status,
    ":status": nextStatus,
    ":paymentStatus": paymentStatus,
    ":paymentKey": paymentKey,
    ":updatedAt": timestamp,
  };
  const setExpressions = [
    "#status = :status",
    "paymentStatus = :paymentStatus",
    "providerPaymentStatus = :paymentStatus",
    "providerPaymentKey = :paymentKey",
    "updatedAt = :updatedAt",
  ];

  if (nextStatus === "PAID") {
    expressionAttributeValues[":paidAt"] = paidAt ?? timestamp;
    setExpressions.push("paidAt = :paidAt");
  }

  try {
    await documentClient.send(
      new UpdateCommand({
        TableName: orderTableName,
        Key: { orderId: order.orderId },
        ConditionExpression: "#status = :currentStatus",
        UpdateExpression: `SET ${setExpressions.join(", ")}`,
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: expressionAttributeValues,
      }),
    );
    return "synchronized";
  } catch (error) {
    if (!isConditionalWriteError(error)) {
      return "unavailable";
    }

    // redirect 승인과 경합했을 때만 최신 주문이 같은 PG 결제 결과인지 확인합니다.
    const currentOrder = await getOrder(orderTableName, order.orderId);

    return currentOrder?.status === nextStatus &&
      currentOrder.providerPaymentKey === paymentKey &&
      currentOrder.providerPaymentStatus === paymentStatus
      ? "synchronized"
      : "unavailable";
  }
}

/** TTL과 조건부 put으로 웹훅 event ID를 90일간 한 번만 처리하게 기록하고, 저장소 장애는 PG 재시도로 넘깁니다. */
async function recordProcessedEvent(
  paymentEventTableName: string,
  providerEventId: string,
  orderId: string,
  providerStatus: string,
): Promise<WebhookStorageResult> {
  const now = Date.now();

  try {
    await documentClient.send(
      new PutCommand({
        TableName: paymentEventTableName,
        Item: {
          providerEventId,
          orderId,
          providerStatus,
          processedAt: new Date(now).toISOString(),
          expiresAt: Math.floor(now / 1000) + 60 * 60 * 24 * 90,
        },
        ConditionExpression: "attribute_not_exists(providerEventId)",
      }),
    );
    return "recorded";
  } catch (error) {
    return isConditionalWriteError(error) ? "duplicate" : "unavailable";
  }
}

/** DynamoDB 조건부 쓰기 충돌만 이미 처리된 webhook과 동등하게 취급합니다. */
function isConditionalWriteError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "ConditionalCheckFailedException"
  );
}
