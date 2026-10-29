/**
 * 역할: 관리자 운영 현황 카드에 쓸 집계만 안전하게 반환함.
 * 기능: 오늘(KST) 주문·결제완료 매출·판매 수량, 저재고 상품, 쿠폰, 마케팅 동의 회원을 산출함.
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

  const observedAt = new Date();
  const todayStartIso = startOfTodayKstIso(observedAt);

  try {
    const [todayOrderMetrics, lowStockCount, activeCouponCount, marketingConsentCount] =
      await Promise.all([
        countTodayOrderMetrics(orderTableName, todayStartIso, observedAt.getTime()),
        countLowStockProducts(catalogTableName),
        countActiveCoupons(couponTableName),
        countMarketingConsent(profileTableName),
      ]);

    return jsonResponse(200, {
      asOf: observedAt.toISOString(),
      timezone: "Asia/Seoul",
      todayOrderCount: todayOrderMetrics.orderCount,
      todayPaidRevenue: todayOrderMetrics.paidRevenue,
      todaySoldItemCount: todayOrderMetrics.soldItemCount,
      lowStockCount,
      lowStockThreshold: LOW_STOCK_THRESHOLD,
      activeCouponCount,
      marketingConsentCount,
    });
  } catch {
    return jsonResponse(503, { code: "OVERVIEW_STORAGE_UNAVAILABLE" });
  }
}

type TodayOrderMetrics = Readonly<{
  orderCount: number;
  paidRevenue: number;
  soldItemCount: number;
}>;

type PaidOrderMetrics = Readonly<{
  revenue: number;
  soldItemCount: number;
}>;

/** 생성 시각과 결제 승인 시각을 각각 KST 당일 기준으로 집계함. */
async function countTodayOrderMetrics(
  tableName: string,
  todayStartIso: string,
  observedAtMilliseconds: number,
): Promise<TodayOrderMetrics> {
  const todayStartMilliseconds = Date.parse(todayStartIso);

  if (!Number.isFinite(todayStartMilliseconds)) {
    throw new Error("KST_DATE_UNAVAILABLE");
  }

  let orderCount = 0;
  let paidRevenue = 0;
  let soldItemCount = 0;
  let exclusiveStartKey: Record<string, unknown> | undefined;

  for (let page = 0; page < MAX_SCAN_PAGES; page += 1) {
    const response = await documentClient.send(
      new ScanCommand({
        TableName: tableName,
        ProjectionExpression: "createdAt, paidAt, #status, #total, #lines",
        ExpressionAttributeNames: {
          "#status": "status",
          "#total": "total",
          "#lines": "lines",
        },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );

    for (const item of response.Items ?? []) {
      if (!isRecord(item)) {
        continue;
      }

      if (
        isTimestampWithinToday(
          item.createdAt,
          todayStartMilliseconds,
          observedAtMilliseconds,
        )
      ) {
        orderCount = addSafeMetric(orderCount, 1);
      }

      const paidMetrics = readTodayPaidOrderMetrics(
        item,
        todayStartMilliseconds,
        observedAtMilliseconds,
      );

      if (paidMetrics) {
        paidRevenue = addSafeMetric(paidRevenue, paidMetrics.revenue);
        soldItemCount = addSafeMetric(soldItemCount, paidMetrics.soldItemCount);
      }
    }

    exclusiveStartKey = response.LastEvaluatedKey as
      | Record<string, unknown>
      | undefined;

    if (!exclusiveStartKey) {
      break;
    }
  }
  // A capped scan with pages left is incomplete; never report it as a full count.
  if (exclusiveStartKey) throw new Error("OVERVIEW_SCAN_INCOMPLETE");

  return { orderCount, paidRevenue, soldItemCount };
}

/** PAID 상태와 결제 승인 시각을 모두 만족할 때만 매출·수량에 포함함. */
function readTodayPaidOrderMetrics(
  item: Record<string, unknown>,
  todayStartMilliseconds: number,
  observedAtMilliseconds: number,
): PaidOrderMetrics | null {
  if (item.status !== "PAID") {
    return null;
  }

  // A PAID order without a payment time cannot be placed in a day; report unavailable instead of 0.
  if (typeof item.paidAt !== "string") {
    throw new Error("ORDER_PAID_AT_INVALID");
  }

  const paidAtMilliseconds = Date.parse(item.paidAt);

  if (!Number.isFinite(paidAtMilliseconds)) {
    throw new Error("ORDER_PAID_AT_INVALID");
  }

  if (
    paidAtMilliseconds < todayStartMilliseconds ||
    paidAtMilliseconds > observedAtMilliseconds
  ) {
    return null;
  }

  if (!isSafeMetricValue(item.total) || !Array.isArray(item.lines)) {
    throw new Error("ORDER_METRICS_INVALID");
  }

  let soldItemCount = 0;

  for (const line of item.lines) {
    if (!isRecord(line) || !isPositiveSafeMetricValue(line.quantity)) {
      throw new Error("ORDER_LINE_METRICS_INVALID");
    }

    soldItemCount = addSafeMetric(soldItemCount, line.quantity);
  }

  return { revenue: item.total, soldItemCount };
}

/** 날짜 문자열이 관측 시각까지의 KST 당일 범위에 있는지 확인함. */
function isTimestampWithinToday(
  value: unknown,
  todayStartMilliseconds: number,
  observedAtMilliseconds: number,
) {
  if (typeof value !== "string") {
    return false;
  }

  const timestamp = Date.parse(value);

  return (
    Number.isFinite(timestamp) &&
    timestamp >= todayStartMilliseconds &&
    timestamp <= observedAtMilliseconds
  );
}

/** DB 숫자 오염·집계 오버플로를 오류로 처리해 임의의 수치를 노출하지 않음. */
function addSafeMetric(current: number, increment: number) {
  const next = current + increment;

  if (!Number.isSafeInteger(next) || next < 0) {
    throw new Error("ORDER_METRICS_OVERFLOW");
  }

  return next;
}

function isSafeMetricValue(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeMetricValue(value: unknown): value is number {
  return isSafeMetricValue(value) && value > 0;
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
        // Sold-out items (0) are not restocked, so only 1 to the threshold needs attention.
        item.inventoryQuantity >= 1 &&
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
  // A capped scan with pages left is incomplete; never report it as a full count.
  if (exclusiveStartKey) throw new Error("OVERVIEW_SCAN_INCOMPLETE");

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
        (item.status === "ACTIVE" ||
          item.status === "DRAFT" ||
          item.status === "PAUSED")
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
  // A capped scan with pages left is incomplete; never report it as a full count.
  if (exclusiveStartKey) throw new Error("OVERVIEW_SCAN_INCOMPLETE");

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
  // A capped scan with pages left is incomplete; never report it as a full count.
  if (exclusiveStartKey) throw new Error("OVERVIEW_SCAN_INCOMPLETE");

  return count;
}

/** Asia/Seoul 기준 오늘 00:00의 UTC ISO 문자열 */
function startOfTodayKstIso(referenceDate: Date) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(referenceDate);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  if (!year || !month || !day) {
    throw new Error("KST_DATE_UNAVAILABLE");
  }

  return new Date(`${year}-${month}-${day}T00:00:00+09:00`).toISOString();
}
