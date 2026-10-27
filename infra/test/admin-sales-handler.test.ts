import assert from "node:assert/strict";
import test from "node:test";
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { GetCommand, QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { handler } from "../lambda/admin-sales-handler.js";
import { documentClient } from "../lambda/dynamodb-client.js";
const event = (method = "GET", groups = "admin", day = "2026-10-15", body?: unknown) =>
  ({
    headers: {},
    isBase64Encoded: false,
    pathParameters: { businessDay: day },
    body: body ? JSON.stringify(body) : undefined,
    requestContext: {
      http: { method },
      authorizer: {
        jwt: { claims: { sub: "fixture-admin", "cognito:groups": groups } },
      },
    },
  }) as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
test("admin authentication and strict input stop before storage", async (t) => {
  let calls = 0;
  t.mock.method(documentClient, "send", async () => {
    calls++;
    throw Error("unexpected");
  });
  assert.equal(
    ((await handler(event("GET", "member"))) as { statusCode: number }).statusCode,
    403,
  );
  assert.equal(
    ((await handler(event("DELETE"))) as { statusCode: number }).statusCode,
    405,
  );
  assert.equal(
    ((await handler(event("GET", "admin", "2026-02-30"))) as { statusCode: number })
      .statusCode,
    400,
  );
  assert.equal(calls, 0);
});
test("complete empty report uses dedicated ledger and contains no identities", async (t) => {
  process.env.SALES_LEDGER_TABLE_NAME = "sales_fixture";
  process.env.ORDER_TABLE_NAME = "orders_fixture";
  process.env.CATALOG_TABLE_NAME = "catalog_fixture";
  t.mock.method(documentClient, "send", async (c: unknown) => {
    if (c instanceof GetCommand) return {};
    assert.ok(c instanceof QueryCommand || c instanceof ScanCommand);
    return { Items: [] };
  });
  const response = (await handler(event())) as { statusCode: number; body: string };
  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.report.complete, true);
  assert.equal(body.report.totals.combinedNet, 0);
  assert.equal(response.body.includes("fixture-admin"), false);
  assert.equal(
    (
      (await handler(
        event("POST", "admin", "2026-10-15", {
          action: "save",
          cardNumber: "forbidden",
        }),
      )) as { statusCode: number }
    ).statusCode,
    400,
  );
});
