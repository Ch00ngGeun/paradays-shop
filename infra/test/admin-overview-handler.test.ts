/** 관리자 운영 현황의 오늘(KST) 결제완료 집계를 실제 Lambda 경로로 검증함. */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from "aws-lambda";

import { handler } from "../lambda/admin-overview-handler.js";
import { documentClient } from "../lambda/dynamodb-client.js";

function adminEvent() {
  return {
    headers: {},
    isBase64Encoded: false,
    requestContext: {
      http: { method: "GET" },
      authorizer: { jwt: { claims: { sub: "admin-sub", "cognito:groups": "admin" } } },
    },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}

function unpack(response: APIGatewayProxyResultV2) {
  assert.ok(typeof response === "object" && response !== null);
  assert.ok("body" in response && typeof response.body === "string");

  return {
    status: response.statusCode,
    body: JSON.parse(response.body) as Record<string, unknown>,
  };
}

function startOfTodayKstMilliseconds(referenceDate: Date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(referenceDate);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  assert.ok(year && month && day);
  return Date.parse(`${year}-${month}-${day}T00:00:00+09:00`);
}

function configureTables(t: TestContext) {
  const names = [
    "ORDER_TABLE_NAME",
    "CATALOG_TABLE_NAME",
    "COUPON_TABLE_NAME",
    "PROFILE_TABLE_NAME",
  ] as const;
  const previous = new Map(names.map((name) => [name, process.env[name]]));

  process.env.ORDER_TABLE_NAME = "orders";
  process.env.CATALOG_TABLE_NAME = "catalog";
  process.env.COUPON_TABLE_NAME = "coupons";
  process.env.PROFILE_TABLE_NAME = "profiles";

  t.after(() => {
    for (const name of names) {
      const value = previous.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

test("returns KST paid revenue and sold units without including pending or refunded orders", async (t) => {
  configureTables(t);
  const now = new Date();
  const todayStart = startOfTodayKstMilliseconds(now);
  const todayTimestamp = new Date(
    Math.max(todayStart + 1, now.getTime() - 1_000),
  ).toISOString();
  const yesterdayTimestamp = new Date(todayStart - 1).toISOString();
  const orderScans: ScanCommand["input"][] = [];
  const send = t.mock.method(documentClient, "send", async (command: unknown) => {
    assert.ok(command instanceof ScanCommand);

    switch (command.input.TableName) {
      case "orders":
        orderScans.push(command.input);
        return {
          Items: [
            {
              createdAt: todayTimestamp,
              status: "PAID",
              paidAt: todayTimestamp,
              total: 51_000,
              lines: [{ quantity: 3 }, { quantity: 1 }],
            },
            {
              createdAt: todayTimestamp,
              status: "PENDING_PAYMENT",
              total: 20_000,
              lines: [{ quantity: 2 }],
            },
            {
              createdAt: todayTimestamp,
              status: "REFUNDED",
              paidAt: todayTimestamp,
              total: 13_000,
              lines: [{ quantity: 1 }],
            },
            {
              createdAt: yesterdayTimestamp,
              status: "PAID",
              paidAt: yesterdayTimestamp,
              total: 99_000,
              lines: [{ quantity: 9 }],
            },
          ],
        };
      case "catalog":
        return { Items: [{ inventoryQuantity: 5 }, { inventoryQuantity: 7 }] };
      case "coupons":
        return { Items: [{ couponId: "draft", status: "DRAFT" }] };
      case "profiles":
        return { Items: [{ marketingConsent: true }] };
      default:
        throw new Error(`Unexpected table ${command.input.TableName}`);
    }
  });
  t.after(() => send.mock.restore());

  const result = unpack(await handler(adminEvent()));

  assert.equal(result.status, 200);
  assert.deepEqual(
    {
      todayOrderCount: result.body.todayOrderCount,
      todayPaidRevenue: result.body.todayPaidRevenue,
      todaySoldItemCount: result.body.todaySoldItemCount,
      lowStockCount: result.body.lowStockCount,
      activeCouponCount: result.body.activeCouponCount,
      marketingConsentCount: result.body.marketingConsentCount,
    },
    {
      todayOrderCount: 3,
      todayPaidRevenue: 51_000,
      todaySoldItemCount: 4,
      lowStockCount: 1,
      activeCouponCount: 1,
      marketingConsentCount: 1,
    },
  );
  assert.equal(orderScans.length, 1);
  assert.equal(
    orderScans[0]?.ProjectionExpression,
    "createdAt, paidAt, #status, #total, #lines",
  );
});

for (const [label, orders] of [
  [
    "a PAID order without paidAt",
    () => ({
      Items: [
        {
          createdAt: new Date().toISOString(),
          status: "PAID",
          total: 1_000,
          lines: [{ quantity: 1 }],
        },
      ],
    }),
  ],
  [
    "an order scan that is still incomplete after the page cap",
    () => ({ Items: [], LastEvaluatedKey: { orderId: "next" } }),
  ],
] as const) {
  test(`${label} is reported unavailable instead of zero`, async (t) => {
    configureTables(t);
    const send = t.mock.method(documentClient, "send", async (command: unknown) => {
      assert.ok(command instanceof ScanCommand);
      if (command.input.TableName === "orders") return orders();
      return { Items: [] };
    });
    t.after(() => send.mock.restore());
    const result = unpack(await handler(adminEvent()));
    assert.equal(result.status, 503);
    assert.equal(result.body.code, "OVERVIEW_STORAGE_UNAVAILABLE");
    assert.equal(result.body.todayPaidRevenue, undefined);
  });
}
