/**
 * 역할: 인증된 회원이 자신의 주문 목록과 주문 상세를 조회하게 함.
 * 기능: Cognito subject와 DynamoDB userSub GSI를 대조해 다른 회원 주문을 절대 반환하지 않음.
 */

import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from "aws-lambda";

import { documentClient, getRequiredEnvironment } from "./dynamodb-client.js";
import { jsonResponse } from "./http-response.js";
import { isOrderRecord, toPublicOrderSummary } from "./order-record.js";
import { getUserSub } from "./request-helpers.js";

/** GET /orders, GET /orders/{orderId}: 인증된 회원의 소유 주문만 반환합니다. */
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> {
  const userSub = getUserSub(event);

  if (!userSub) {
    return jsonResponse(401, { code: "UNAUTHORIZED" });
  }

  let orderTableName: string;

  try {
    orderTableName = getRequiredEnvironment("ORDER_TABLE_NAME");
  } catch {
    return jsonResponse(503, { code: "ORDER_CONFIGURATION_UNAVAILABLE" });
  }

  const orderId = event.pathParameters?.orderId;

  if (orderId) {
    const order = await getOrder(orderTableName, orderId);

    if (order === undefined) {
      return jsonResponse(503, { code: "ORDER_STORAGE_UNAVAILABLE" });
    }

    if (!order || order.userSub !== userSub) {
      return jsonResponse(404, { code: "ORDER_NOT_FOUND" });
    }

    return jsonResponse(200, {
      order: {
        ...toPublicOrderSummary(order),
        lines: order.lines,
      },
    });
  }

  const orders = await listOrders(orderTableName, userSub);

  if (!orders) {
    return jsonResponse(503, { code: "ORDER_STORAGE_UNAVAILABLE" });
  }

  return jsonResponse(200, { orders: orders.map(toPublicOrderSummary) });
}

/** 주문 ID를 primary key로 읽은 뒤 반드시 token subject가 동일한지 caller에서 비교합니다. */
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
    return undefined;
  }
}

/** userSub-createdAt-index만 쿼리해 전체 테이블 scan 없이 최신 주문 25건을 반환합니다. */
async function listOrders(orderTableName: string, userSub: string) {
  try {
    const response = await documentClient.send(
      new QueryCommand({
        TableName: orderTableName,
        IndexName: "userSub-createdAt-index",
        KeyConditionExpression: "userSub = :userSub",
        ExpressionAttributeValues: { ":userSub": userSub },
        ScanIndexForward: false,
        Limit: 25,
      }),
    );

    return (response.Items ?? []).filter(isOrderRecord);
  } catch {
    return null;
  }
}
