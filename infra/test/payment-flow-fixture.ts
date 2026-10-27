/* eslint-disable @typescript-eslint/no-explicit-any -- test double mirrors loose SDK command and Lambda shapes */
/** In-memory atomic transport. Never opens a socket or reads real credentials. */
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { GetCommand, PutCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { documentClient } from "../lambda/dynamodb-client.js";
import type { OrderRecord } from "../lambda/order-record.js";
import { createDigest } from "../lambda/order-record.js";
export function savedOrder(patch: Partial<OrderRecord> = {}): OrderRecord {
  return {
    orderId: "pd_order_001",
    userSub: "member",
    status: "PENDING_PAYMENT",
    paymentStatus: "READY",
    provider: "toss",
    currency: "KRW",
    subtotal: 200,
    total: 200,
    orderName: "Deck",
    lines: [
      {
        productId: "prd_deck",
        name: "Deck",
        selectedSize: "8",
        quantity: 2,
        unitPrice: 100,
        lineTotal: 200,
      },
    ],
    idempotencyKeyHash: "hash",
    requestFingerprint: "fp",
    checkoutReturnTokenHash: createDigest("a".repeat(43)),
    checkoutReturnExpiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...patch,
  };
}
export const catalogProduct = () => ({
  productId: "prd_deck",
  name: "Deck",
  price: 100,
  sizes: ["8", "9"],
  status: "PUBLISHED",
  currency: "KRW",
  inventoryQuantity: 4,
  inventoryReserved: 0,
  version: 1,
});
export function paymentFixture(t: TestContext, order: OrderRecord | null = null) {
  const original = { ...process.env };
  process.env.ORDER_TABLE_NAME = "orders";
  process.env.CATALOG_TABLE_NAME = "catalog";
  process.env.PAYMENT_EVENT_TABLE_NAME = "events";
  process.env.TOSS_PAYMENTS_SECRET_ARN = `test-${Math.random()}`;
  delete process.env.USER_POOL_ID;
  t.after(() => {
    for (const key of [
      "ORDER_TABLE_NAME",
      "CATALOG_TABLE_NAME",
      "PAYMENT_EVENT_TABLE_NAME",
      "TOSS_PAYMENTS_SECRET_ARN",
      "USER_POOL_ID",
    ]) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  });
  const records = new Map<string, Record<string, unknown>>();
  records.set("catalog:prd_deck", catalogProduct());
  if (order)
    records.set(
      `orders:${order.orderId}`,
      structuredClone(order) as unknown as Record<string, unknown>,
    );
  let failRead = false;
  let loseResponse = false;
  let conflict: (() => void) | undefined;
  const transactions: TransactWriteCommand["input"][] = [];
  const calls: { url: string; init: RequestInit }[] = [];
  let provider: (url: string, init: RequestInit) => unknown = () => {
    throw new Error("No provider fixture configured");
  };
  t.mock.method(SecretsManagerClient.prototype, "send", async () => ({
    SecretString: JSON.stringify({ secretKey: "fake_test_key" }),
  }));
  t.mock.method(globalThis, "fetch", async (url: unknown, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(await provider(String(url), init)), {
      status: 200,
    });
  });
  function keyFor(table: string, item: Record<string, unknown>) {
    return `${table}:${item.providerEventId ?? item.orderId ?? item.productId}`;
  }
  function validate(write: any, item: Record<string, unknown>) {
    const current = records.get(keyFor(write.TableName, item));
    const values = write.ExpressionAttributeValues ?? {};
    const condition = write.ConditionExpression as string | undefined;
    if (!condition) return;
    let valid = true;
    if (condition.includes(" AND attribute_not_exists(paymentVersion)"))
      valid = current?.paymentVersion === undefined;
    if (condition.includes(" AND paymentVersion = :paymentVersion"))
      valid = current?.paymentVersion === values[":paymentVersion"];
    const financialValid = valid;
    if (condition.startsWith("attribute_not_exists(inventory)"))
      valid =
        !current?.inventory &&
        current?.status === values[":status"] &&
        current?.requestFingerprint === values[":fingerprint"];
    else if (condition.startsWith("inventory.#version"))
      valid =
        (current?.inventory as any)?.version === values[":version"] &&
        current?.requestFingerprint === values[":fingerprint"];
    else if (condition.startsWith("attribute_not_exists(")) valid = !current;
    else if (condition === "#version = :version")
      valid = current?.version === values[":version"];
    else throw new Error(`Unsupported condition ${condition}`);
    if (!valid || !financialValid)
      throw Object.assign(new Error("Condition failed"), {
        name: "TransactionCanceledException",
      });
  }
  t.mock.method(documentClient, "send", async (command: unknown) => {
    if (command instanceof GetCommand) {
      if (failRead) throw new Error("Read failure");
      return {
        Item: structuredClone(
          records.get(keyFor(command.input.TableName!, command.input.Key!)),
        ),
      };
    }
    if (command instanceof PutCommand) {
      try {
        validate(command.input, command.input.Item!);
      } catch {
        throw Object.assign(new Error("Conflict"), {
          name: "ConditionalCheckFailedException",
        });
      }
      records.set(
        keyFor(command.input.TableName!, command.input.Item!),
        structuredClone(command.input.Item!),
      );
      return {};
    }
    assert.ok(command instanceof TransactWriteCommand);
    conflict?.();
    conflict = undefined;
    const operations = command.input.TransactItems!;
    for (const op of operations) {
      const write = op.Put ?? op.Update!;
      validate(write, op.Put?.Item ?? op.Update!.Key!);
    }
    transactions.push(structuredClone(command.input));
    for (const op of operations) {
      if (op.Put)
        records.set(
          keyFor(op.Put.TableName!, op.Put.Item!),
          structuredClone(op.Put.Item!),
        );
      else {
        const w = op.Update!;
        const key = keyFor(w.TableName!, w.Key!);
        const old = records.get(key)!;
        const v = w.ExpressionAttributeValues!;
        records.set(key, {
          ...old,
          inventoryQuantity: v[":quantity"],
          inventoryReserved: v[":reserved"],
          inventoryCommitted: v[":committed"],
          version: v[":nextVersion"],
          updatedAt: v[":updatedAt"],
        });
      }
    }
    if (loseResponse) {
      loseResponse = false;
      throw new Error("Lost response after commit");
    }
    return {};
  });
  return {
    records,
    transactions,
    calls,
    setProvider: (fn: typeof provider) => {
      provider = fn;
    },
    failRead: () => {
      failRead = true;
    },
    loseResponse: () => {
      loseResponse = true;
    },
    beforeTransaction: (fn: () => void) => {
      conflict = fn;
    },
    order: (id = order?.orderId) =>
      records.get(`orders:${id}`) as unknown as OrderRecord,
    product: () => records.get("catalog:prd_deck")!,
  };
}
export function event(
  body?: unknown,
  admin = false,
  orderId?: string,
  method = "POST",
) {
  return {
    headers: { "x-idempotency-key": "checkout_test_operation" },
    pathParameters: orderId ? { orderId } : {},
    isBase64Encoded: false,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    requestContext: {
      http: { method },
      authorizer: {
        jwt: {
          claims: { sub: "member", ...(admin ? { "cognito:groups": "admin" } : {}) },
        },
      },
    },
  } as any;
}
export function response(value: any) {
  return { status: value.statusCode, body: JSON.parse(value.body) };
}
