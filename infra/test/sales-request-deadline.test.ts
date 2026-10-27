import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import {
  GetCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { authorizeAdmin } from "../lambda/admin-auth.js";
import { handler } from "../lambda/admin-sales-handler.js";
import { documentClient } from "../lambda/dynamodb-client.js";
import { readProducts } from "../lambda/order-inventory-store.js";
import { operateSalesDay, readSalesDay } from "../lambda/sales-ledger-store.js";
import {
  salesRequestSignal,
  withSalesRequest,
} from "../lambda/sales-request-deadline.js";
import type { SalesCommand } from "../lambda/sales-ledger-domain.js";

const day = "2026-10-15";
const product = {
  productId: "prd_deck",
  name: "Deck",
  price: 100,
  sizes: ["8"],
  status: "PUBLISHED",
  currency: "KRW",
  inventoryQuantity: 10,
  inventoryReserved: 3,
  inventoryCommitted: 0,
  version: 1,
};
const save: Extract<SalesCommand, { action: "save" }> = {
  action: "save",
  entryId: "sale_001",
  expectedVersion: 0,
  soldAt: "2026-10-15T01:00:00.000Z",
  method: "CARD",
  reference: "APP-001",
  amount: 200,
  memo: "",
  lines: [
    { productId: "prd_deck", name: "Deck", option: "8", quantity: 2, unitAmount: 100 },
  ],
};
const event = (groups?: string, body?: unknown) =>
  ({
    headers: {},
    isBase64Encoded: false,
    pathParameters: { businessDay: day },
    body: body ? JSON.stringify(body) : undefined,
    requestContext: {
      http: { method: body ? "POST" : "GET" },
      authorizer: {
        jwt: {
          claims: {
            sub: "fixture-admin",
            username: "fixture-admin",
            ...(groups ? { "cognito:groups": groups } : {}),
          },
        },
      },
    },
  }) as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
function configure(t: TestContext) {
  for (const [key, value] of Object.entries({
    SALES_LEDGER_TABLE_NAME: "fixture_sales",
    CATALOG_TABLE_NAME: "fixture_catalog",
    ORDER_TABLE_NAME: "fixture_orders",
    USER_POOL_ID: "fixture_pool",
  })) {
    const before = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (before === undefined) delete process.env[key];
      else process.env[key] = before;
    });
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
// Production timers are unref'ed; the fixture keeps the test process alive only.
function keepAlive(t: TestContext) {
  const timer = setTimeout(() => {}, 1_000);
  t.after(() => clearTimeout(timer));
}
test("shared auth/product readers preserve non-sales SDK arguments and receive the same sales signal", async (t) => {
  configure(t);
  let expected: AbortSignal | undefined;
  const signals: AbortSignal[] = [];
  const check = (args: unknown[]) => {
    assert.equal(args.length, expected ? 2 : 1);
    if (expected) {
      const options = args[1] as { abortSignal: AbortSignal };
      assert.equal(options.abortSignal, expected);
      signals.push(options.abortSignal);
    }
  };
  t.mock.method(
    CognitoIdentityProviderClient.prototype,
    "send",
    async (...args: unknown[]) => {
      check(args);
      return { Groups: [{ GroupName: "admin" }] };
    },
  );
  t.mock.method(documentClient, "send", async (...args: unknown[]) => {
    check(args);
    assert.ok(args[0] instanceof GetCommand);
    return { Item: product };
  });
  assert.equal((await authorizeAdmin(event())).ok, true);
  assert.equal((await readProducts(["prd_deck"])).size, 1);
  await withSalesRequest(async () => {
    expected = salesRequestSignal();
    assert.ok(expected);
    assert.equal((await authorizeAdmin(event())).ok, true);
    assert.equal((await readProducts(["prd_deck"])).size, 1);
  });
  assert.equal(signals.length, 2);
  assert.ok(signals.every((s) => s.aborted));
  expected = undefined;
  assert.equal(salesRequestSignal(), undefined);
  assert.equal((await authorizeAdmin(event())).ok, true);
  assert.equal((await readProducts(["prd_deck"])).size, 1);
});
test("concurrent request contexts and callers outside them never share a budget", async () => {
  const one = deferred<void>(),
    two = deferred<void>();
  let first: AbortSignal | undefined;
  let second: AbortSignal | undefined;
  const a = withSalesRequest(async () => {
    first = salesRequestSignal();
    await one.promise;
    assert.equal(salesRequestSignal(), first);
  });
  const b = withSalesRequest(async () => {
    second = salesRequestSignal();
    await two.promise;
    assert.equal(salesRequestSignal(), second);
  });
  assert.ok(first && second);
  assert.notEqual(first, second);
  assert.equal(salesRequestSignal(), undefined);
  one.resolve();
  await a;
  assert.equal(second.aborted, false);
  two.resolve();
  await b;
  assert.equal(first.aborted, true);
  assert.equal(second.aborted, true);
});
test("a stalled Cognito fallback is aborted by the handler budget, not returned as a role denial", async (t) => {
  configure(t);
  keepAlive(t);
  let signal: AbortSignal | undefined;
  t.mock.method(
    CognitoIdentityProviderClient.prototype,
    "send",
    async (_c: unknown, o: { abortSignal: AbortSignal }) => {
      signal = o.abortSignal;
      return new Promise(() => {});
    },
  );
  const storage = t.mock.method(documentClient, "send", async () => {
    throw Error("storage must not run");
  });
  const response = (await handler(event(), {
    getRemainingTimeInMillis: () => 3_015,
  })) as { statusCode: number; body: string };
  assert.equal(response.statusCode, 503);
  assert.match(response.body, /SALES_REQUEST_DEADLINE_EXCEEDED/);
  assert.equal(signal?.aborted, true);
  assert.equal(storage.mock.callCount(), 0);
});
test("a stalled initial Get cannot wait for Lambda termination or launch follow-up reads", async (t) => {
  configure(t);
  keepAlive(t);
  const gate = deferred<Record<string, unknown>>();
  let signal: AbortSignal | undefined;
  const storage = t.mock.method(
    documentClient,
    "send",
    async (c: unknown, o: { abortSignal: AbortSignal }) => {
      assert.ok(c instanceof GetCommand);
      signal = o.abortSignal;
      return gate.promise;
    },
  );
  const response = (await handler(event("admin"), {
    getRemainingTimeInMillis: () => 3_015,
  })) as { statusCode: number; body: string };
  assert.equal(response.statusCode, 503);
  assert.equal(signal?.aborted, true);
  gate.resolve({});
  await delay(5);
  assert.equal(storage.mock.callCount(), 1);
});
test("remaining Lambda headroom is server-controlled and an exhausted invocation never starts storage", async (t) => {
  configure(t);
  const storage = t.mock.method(documentClient, "send", async () => {
    throw Error("must not run");
  });
  const response = (await handler(event("admin", { ...save, budgetMs: 999_999 }), {
    getRemainingTimeInMillis: () => 2_999,
  })) as { statusCode: number; body: string };
  assert.equal(response.statusCode, 503);
  assert.match(response.body, /SALES_REQUEST_DEADLINE_EXCEEDED/);
  assert.equal(storage.mock.callCount(), 0);
});
test("global budget aborts both complete-read branches before their local eight-second caps", async (t) => {
  configure(t);
  keepAlive(t);
  const signals: AbortSignal[] = [];
  t.mock.method(
    documentClient,
    "send",
    async (c: unknown, o: { abortSignal: AbortSignal }) => {
      signals.push(o.abortSignal);
      if (c instanceof GetCommand) return {};
      assert.ok(c instanceof QueryCommand || c instanceof ScanCommand);
      return new Promise(() => {});
    },
  );
  await assert.rejects(
    () => withSalesRequest(() => readSalesDay(day), 15),
    (e: unknown) =>
      e instanceof Error &&
      "status" in e &&
      e.status === 503 &&
      /SALES_REQUEST_DEADLINE_EXCEEDED|PAGINATION_INCOMPLETE/.test(e.message),
  );
  assert.equal(signals.length, 3);
  assert.ok(signals.every((s) => s.aborted));
});
test("an ignored-abort state read cannot resume a mutation after request expiry", async (t) => {
  configure(t);
  keepAlive(t);
  const gate = deferred<Record<string, unknown>>();
  const storage = t.mock.method(documentClient, "send", async (c: unknown) => {
    assert.ok(c instanceof GetCommand);
    return gate.promise;
  });
  await assert.rejects(
    () => withSalesRequest(() => operateSalesDay(day, save, "admin"), 15),
    /SALES_REQUEST_DEADLINE_EXCEEDED/,
  );
  gate.resolve({});
  await delay(5);
  assert.equal(storage.mock.callCount(), 1);
});
test("a failed complete-read branch immediately aborts its stalled sibling and clears the local timer", async (t) => {
  configure(t);
  let sibling: AbortSignal | undefined;
  t.mock.method(
    documentClient,
    "send",
    async (c: unknown, o: { abortSignal: AbortSignal }) => {
      if (c instanceof GetCommand) return {};
      if (c instanceof QueryCommand) throw Error("query unavailable");
      assert.ok(c instanceof ScanCommand);
      sibling = o.abortSignal;
      return new Promise(() => {});
    },
  );
  await assert.rejects(
    () => withSalesRequest(() => readSalesDay(day)),
    /query unavailable/,
  );
  assert.equal(sibling?.aborted, true);
});
test("an ignored-abort product read cannot launch a transaction after request expiry", async (t) => {
  configure(t);
  keepAlive(t);
  const gate = deferred<Record<string, unknown>>();
  let writes = 0;
  const draft = {
    ...save,
    businessDay: day,
    recordType: "SALE",
    version: 1,
    status: "DRAFT",
    kind: "SALE",
    audit: [],
  };
  const previewToken = createHash("sha256")
    .update(
      JSON.stringify([
        day,
        save.entryId,
        1,
        [
          {
            productId: product.productId,
            name: product.name,
            quantity: 10,
            reserved: 3,
            available: 7,
            delta: -2,
            after: 8,
            version: 1,
          },
        ],
      ]),
    )
    .digest("hex");
  t.mock.method(documentClient, "send", async (c: unknown) => {
    if (c instanceof TransactWriteCommand) writes++;
    assert.ok(c instanceof GetCommand);
    if (c.input.TableName === "fixture_catalog") return gate.promise;
    return { Item: c.input.Key!.entryId === "~state" ? undefined : draft };
  });
  await assert.rejects(
    () =>
      withSalesRequest(
        () =>
          operateSalesDay(
            day,
            {
              action: "post",
              entryId: save.entryId,
              version: 1,
              previewToken,
              confirmed: true,
            },
            "admin",
          ),
        15,
      ),
    /SALES_REQUEST_DEADLINE_EXCEEDED/,
  );
  gate.resolve({ Item: product });
  await delay(5);
  assert.equal(writes, 0);
});
test("a transaction committed before timeout is uncertain, and the same request replays durable proof only", async (t) => {
  configure(t);
  keepAlive(t);
  const ledger = new Map<string, Record<string, unknown>>();
  const catalog = new Map<string, Record<string, unknown>>([
    [product.productId, { ...product }],
  ]);
  const gate = deferred<Record<string, unknown>>();
  let writes = 0;
  let stall = false;
  let transactionSignal: AbortSignal | undefined;
  t.mock.method(
    documentClient,
    "send",
    async (c: unknown, o: { abortSignal: AbortSignal }) => {
      if (c instanceof GetCommand)
        return {
          Item:
            c.input.TableName === "fixture_catalog"
              ? catalog.get(c.input.Key!.productId)
              : ledger.get(c.input.Key!.entryId),
        };
      assert.ok(c instanceof TransactWriteCommand);
      transactionSignal = o.abortSignal;
      for (const item of c.input.TransactItems!) {
        if (item.Put) {
          const value = structuredClone(item.Put.Item!);
          if (item.Put.TableName === "fixture_catalog")
            catalog.set(value.productId, value);
          else ledger.set(value.entryId, value);
        } else {
          const update = item.Update!,
            values = update.ExpressionAttributeValues!;
          catalog.set(update.Key!.productId, {
            ...catalog.get(update.Key!.productId),
            inventoryQuantity: values[":after"],
            inventoryCommitted: values[":committed"],
            version: values[":nextVersion"],
          });
        }
      }
      writes++;
      return stall ? gate.promise : {};
    },
  );
  assert.equal(
    ((await handler(event("admin", save))) as { statusCode: number }).statusCode,
    200,
  );
  const preview = await operateSalesDay(
    day,
    { action: "preview", entryId: save.entryId, version: 1 },
    "admin",
  );
  const command = {
    action: "post",
    entryId: save.entryId,
    version: 1,
    previewToken: preview.previewToken,
    confirmed: true,
  };
  stall = true;
  const response = (await handler(event("admin", command), {
    getRemainingTimeInMillis: () => 3_015,
  })) as { statusCode: number; body: string };
  assert.equal(response.statusCode, 503);
  assert.equal(transactionSignal?.aborted, true);
  assert.equal(ledger.get(save.entryId)?.status, "POSTED");
  assert.equal(catalog.get(product.productId)?.inventoryQuantity, 8);
  assert.equal(catalog.get(product.productId)?.inventoryReserved, 3);
  assert.equal(writes, 2);
  gate.resolve({});
  await delay(5);
  const retry = (await handler(event("admin", command))) as {
    statusCode: number;
    body: string;
  };
  assert.equal(retry.statusCode, 200);
  assert.equal(JSON.parse(retry.body).entry.entryId, save.entryId);
  assert.equal(catalog.get(product.productId)?.inventoryQuantity, 8);
  assert.equal(writes, 2);
});
test("a completion after the clock deadline is rejected even before a delayed timer callback", async (t) => {
  const actual = Date.now.bind(Date);
  let elapsed = 0;
  t.mock.method(Date, "now", () => actual() + elapsed);
  await assert.rejects(
    () =>
      withSalesRequest(async () => {
        elapsed = 25_000;
        return "not a successful partial result";
      }),
    /SALES_REQUEST_DEADLINE_EXCEEDED/,
  );
});
