/**
 * 역할: 인증된 회원의 장바구니를 서버 가격으로 검증하고 Toss 결제 전 주문을 생성함.
 * 기능: 멱등 주문 생성, 가격·옵션 재계산, redirect 반환 토큰 발급만 수행하며 카드정보는 받지 않음.
 */

import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from "aws-lambda";

import { serverCatalog } from "./catalog.js";
import { documentClient, getRequiredEnvironment } from "./dynamodb-client.js";
import { jsonResponse } from "./http-response.js";
import {
  calculateOrder,
  OrderValidationError,
  parseCheckoutRequestLines,
} from "./order-domain.js";
import {
  createCheckoutReturnToken,
  createCustomerKey,
  createDigest,
  createOrderId,
  createRequestFingerprint,
  isOrderRecord,
  type OrderRecord,
} from "./order-record.js";
import { getHeader, getUserSub, isRecord, parseJsonBody } from "./request-helpers.js";
import { getTossPaymentsCredentials, TossPaymentsApiError } from "./toss-payments.js";

/** 헤더 멱등성 키는 UUID 등 일반적인 호출 키를 허용하되 DB·PG 키로 남용되지 않게 제한합니다. */
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{15,127}$/;

/** POST /checkout/sessions: 카탈로그 가격 기준 PENDING_PAYMENT 주문을 만들고 Toss SDK용 정보만 반환합니다. */
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> {
  const userSub = getUserSub(event);

  if (!userSub) {
    return jsonResponse(401, { code: "UNAUTHORIZED" });
  }

  const idempotencyKey = getHeader(event, "x-idempotency-key");

  if (!idempotencyKey || !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    return jsonResponse(400, { code: "IDEMPOTENCY_KEY_REQUIRED" });
  }

  const body = parseJsonBody(event);

  if (!isRecord(body)) {
    return jsonResponse(400, { code: "CHECKOUT_BODY_INVALID" });
  }

  let calculatedOrder;

  try {
    calculatedOrder = calculateOrder(
      parseCheckoutRequestLines(body.lines),
      serverCatalog,
    );
  } catch (error) {
    if (error instanceof OrderValidationError) {
      return jsonResponse(400, { code: error.code });
    }

    return jsonResponse(400, { code: "CHECKOUT_BODY_INVALID" });
  }

  let orderTableName: string;
  let tossSecretArn: string;

  try {
    orderTableName = getRequiredEnvironment("ORDER_TABLE_NAME");
    tossSecretArn = getRequiredEnvironment("TOSS_PAYMENTS_SECRET_ARN");
  } catch {
    return jsonResponse(503, { code: "CHECKOUT_CONFIGURATION_UNAVAILABLE" });
  }

  let credentials;

  try {
    credentials = await getTossPaymentsCredentials(tossSecretArn);
  } catch (error) {
    if (error instanceof TossPaymentsApiError) {
      return jsonResponse(503, { code: "PAYMENT_PROVIDER_UNAVAILABLE" });
    }

    return jsonResponse(503, { code: "PAYMENT_PROVIDER_UNAVAILABLE" });
  }

  const orderId = createOrderId(userSub, idempotencyKey);
  const checkoutReturnToken = createCheckoutReturnToken(
    credentials.secretKey,
    orderId,
    userSub,
  );
  const timestamp = new Date().toISOString();
  const requestFingerprint = createRequestFingerprint(calculatedOrder.lines);
  const order: OrderRecord = {
    orderId,
    userSub,
    status: "PENDING_PAYMENT",
    paymentStatus: "READY",
    provider: "toss",
    currency: calculatedOrder.currency,
    subtotal: calculatedOrder.subtotal,
    total: calculatedOrder.total,
    orderName: calculatedOrder.orderName,
    lines: calculatedOrder.lines,
    idempotencyKeyHash: createDigest(idempotencyKey),
    requestFingerprint,
    checkoutReturnTokenHash: createDigest(checkoutReturnToken),
    checkoutReturnExpiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  try {
    await documentClient.send(
      new PutCommand({
        TableName: orderTableName,
        Item: order,
        ConditionExpression: "attribute_not_exists(orderId)",
      }),
    );
  } catch (error) {
    if (!isConditionalWriteError(error)) {
      return jsonResponse(503, { code: "ORDER_STORAGE_UNAVAILABLE" });
    }

    const existingOrder = await getExistingOrder(orderTableName, orderId);

    if (!existingOrder || existingOrder.userSub !== userSub) {
      return jsonResponse(409, { code: "CHECKOUT_REQUEST_CONFLICT" });
    }

    if (existingOrder.requestFingerprint !== requestFingerprint) {
      return jsonResponse(409, { code: "IDEMPOTENCY_KEY_REUSED" });
    }
  }

  return jsonResponse(201, {
    orderId,
    orderName: calculatedOrder.orderName,
    amount: calculatedOrder.total,
    currency: calculatedOrder.currency,
    customerKey: createCustomerKey(userSub),
    checkoutReturnToken,
  });
}

/** 같은 멱등 키가 이미 주문을 만들었을 때만 기존 레코드를 읽어 같은 결과를 반환합니다. */
async function getExistingOrder(orderTableName: string, orderId: string) {
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

/** AWS SDK의 조건부 쓰기 오류만 식별해 다른 저장소 오류를 성공으로 오인하지 않습니다. */
function isConditionalWriteError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "ConditionalCheckFailedException"
  );
}
