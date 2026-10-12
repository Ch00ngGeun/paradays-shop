/**
 * 역할: 관리자 운영 현황 카드에 쓸 집계만 안전하게 반환함.
 * 기능: 오늘(KST) 주문 수, 저재고 상품 수, 활성 쿠폰 수, 마케팅 동의 회원 수를 산출함.
 */

import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from "aws-lambda";

import { authorizeAdmin } from "./admin-auth.js";
import { documentClient, getRequiredEnvironment } from "./dynamodb-client.js";
import { jsonResponse } from "./http-response.js";
import { isRecord } from "./request-helpers.js";

/** 공개·초안 포함, 이 수량 이하면 재고 주의로 집계 */
const LOW_STOCK_THRESHOLD = 5;
/** 스캔 안전을 위한 페이지 상한 */
const MAX_SCAN_PAGES = 20;

/** GET /admin/overview */
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> {
  const authorization = await authorizeAdmin(event);

  if (!authorization.ok) {
    return jsonResponse(authorization.statusCode, { code: authorization.code });
  }

  if (event.requestContext.http.method !== "GET") {
    return jsonResponse(405, { code: "METHOD_NOT_ALLOWED" });
  }

  let orderTableName: string;
  let catalogTableName: string;
  let couponTableName: string;
  let profileTableName: string;

  try {
    orderTableName = getRequiredEnvironment("ORDER_TABLE_NAME");
    catalogTableName = getRequiredEnvironment("CATALOG_TABLE_NAME");
    couponTableName = getRequiredEnvironment("COUPON_TABLE_NAME");
    profileTableName = getRequiredEnvironment("PROFILE_TABLE_NAME");
  } catch {
    return jsonResponse(503, { code: "OVERVIEW_CONFIGURATION_UNAVAILABLE" });
  }

  const todayStartIso = startOfTodayKstIso();

  try {
    const [todayOrderCount, lowStockCount, activeCouponCount, marketingConsentCount] =
      await Promise.all([
        countTodayOrders(orderTableName, todayStartIso),
        countLowStockProducts(catalogTableName),
        countActiveCoupons(couponTableName),
        countMarketingConsent(profileTableName),
      ]);

    return jsonResponse(200, {
      asOf: new Date().toISOString(),
      timezone: "Asia/Seoul",
      todayOrderCount,
      lowStockCount,
      lowStockThreshold: LOW_STOCK_THRESHOLD,
      activeCouponCount,
      marketingConsentCount,
    });
  } catch {
    return jsonResponse(503, { code: "OVERVIEW_STORAGE_UNAVAILABLE" });
  }
}

async function countTodayOrders(tableName: string, todayStartIso: string) {
  let count = 0;
  let exclusiveStartKey: Record<string, unknown> | undefined;

  for (let page = 0; page < MAX_SCAN_PAGES; page += 1) {
    const response = await documentClient.send(
      new ScanCommand({
        TableName: tableName,
        ProjectionExpression: "createdAt",
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );

    for (const item of response.Items ?? []) {
      if (
        isRecord(item) &&
        typeof item.createdAt === "string" &&
        item.createdAt >= todayStartIso
      ) {
        count += 1;
      }
    }

    exclusiveStartKey = response.LastEvaluatedKey as
      | Record<string, unknown>
      | undefined;

    if (!exclusiveStartKey) {
      break;
    }
  }

  return count;
}

async function countLowStockProducts(tableName: string) {
  let count = 0;
  let exclusiveStartKey: Record<string, unknown> | undefined;

  for (let page = 0; page < MAX_SCAN_PAGES; page += 1) {
    const response = await documentClient.send(
      new ScanCommand({
        TableName: tableName,
        ProjectionExpression: "inventoryQuantity",
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );

    for (const item of response.Items ?? []) {
      if (
        isRecord(item) &&
        typeof item.inventoryQuantity === "number" &&
        Number.isSafeInteger(item.inventoryQuantity) &&
        item.inventoryQuantity >= 0 &&
        item.inventoryQuantity <= LOW_STOCK_THRESHOLD
      ) {
        count += 1;
      }
    }

    exclusiveStartKey = response.LastEvaluatedKey as
      | Record<string, unknown>
      | undefined;

    if (!exclusiveStartKey) {
      break;
    }
  }

  return count;
}

async function countActiveCoupons(tableName: string) {
  let count = 0;
  let exclusiveStartKey: Record<string, unknown> | undefined;

  for (let page = 0; page < MAX_SCAN_PAGES; page += 1) {
    const response = await documentClient.send(
      new ScanCommand({
        TableName: tableName,
        ProjectionExpression: "couponId, #status",
        ExpressionAttributeNames: { "#status": "status" },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );

    for (const item of response.Items ?? []) {
      // 관리자 화면에서 만드는 초안(DRAFT)도 포함해 카드가 즉시 반영되게 함
      if (
        isRecord(item) &&
        (item.status === "ACTIVE" || item.status === "DRAFT" || item.status === "PAUSED")
      ) {
        count += 1;
      }
    }

    exclusiveStartKey = response.LastEvaluatedKey as
      | Record<string, unknown>
      | undefined;

    if (!exclusiveStartKey) {
      break;
    }
  }

  return count;
}

async function countMarketingConsent(tableName: string) {
  let count = 0;
  let exclusiveStartKey: Record<string, unknown> | undefined;

  for (let page = 0; page < MAX_SCAN_PAGES; page += 1) {
    const response = await documentClient.send(
      new ScanCommand({
        TableName: tableName,
        ProjectionExpression: "marketingConsent",
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );

    for (const item of response.Items ?? []) {
      if (isRecord(item) && item.marketingConsent === true) {
        count += 1;
      }
    }

    exclusiveStartKey = response.LastEvaluatedKey as
      | Record<string, unknown>
      | undefined;

    if (!exclusiveStartKey) {
      break;
    }
  }

  return count;
}

/** Asia/Seoul 기준 오늘 00:00의 UTC ISO 문자열 */
function startOfTodayKstIso() {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  if (!year || !month || !day) {
    throw new Error("KST_DATE_UNAVAILABLE");
  }

  return new Date(`${year}-${month}-${day}T00:00:00+09:00`).toISOString();
}
