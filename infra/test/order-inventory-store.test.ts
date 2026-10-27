import assert from "node:assert/strict";
import test from "node:test";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { documentClient } from "../lambda/dynamodb-client.js";
import {
  reserveInventory,
  settleInventoryPayment,
} from "../lambda/order-inventory-store.js";
import type { OrderRecord } from "../lambda/order-record.js";
const order: OrderRecord = {
  orderId: "pd_order",
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
  checkoutReturnTokenHash: "hash",
  checkoutReturnExpiresAt: "2026-10-15T00:30:00Z",
  createdAt: "2026-10-15T00:00:00Z",
  updatedAt: "2026-10-15T00:00:00Z",
};
process.env.ORDER_TABLE_NAME = "orders";
process.env.CATALOG_TABLE_NAME = "catalog";
test("reservation/debit/release target stock + revision + order together", async (t) => {
  let product = {
    productId: "prd_deck",
    name: "Deck",
    price: 100,
    sizes: ["8"],
    status: "PUBLISHED",
    currency: "KRW",
    inventoryQuantity: 4,
    inventoryReserved: 0,
    version: 1,
  };
  const writes: TransactWriteCommand["input"][] = [];
  t.mock.method(documentClient, "send", async (command: unknown) => {
    if (command instanceof GetCommand)
      return {
        Item: command.input.Key?.productId === "prd_deck" ? product : undefined,
      };
    assert.ok(command instanceof TransactWriteCommand);
    writes.push(command.input);
    const update = command.input.TransactItems![1]!.Update!;
    assert.equal(update.ConditionExpression, "#version = :version");
    product = {
      ...product,
      inventoryQuantity: update.ExpressionAttributeValues![":quantity"] as number,
      inventoryReserved: update.ExpressionAttributeValues![":reserved"] as number,
      version: product.version + 1,
    };
    assert.equal(
      command.input.TransactItems![2]!.Put!.Item!.productId,
      "~catalog_revision",
    );
    return {};
  });
  const reserved = await reserveInventory(order, "pk");
  assert.equal(product.inventoryQuantity, 4);
  assert.equal(product.inventoryReserved, 2);
  assert.equal(await reserveInventory(reserved, "pk"), reserved);
  await assert.rejects(() => reserveInventory(reserved, "other"));
  const paid = await settleInventoryPayment(reserved, {
    paymentKey: "pk",
    orderId: "pd_order",
    totalAmount: 200,
    balanceAmount: 200,
    method: "카드",
    currency: "KRW",
    status: "DONE",
    cancels: [],
  });
  assert.equal(paid.inventory?.state, "DEBITED");
  assert.equal(product.inventoryQuantity, 2);
  assert.equal(product.inventoryReserved, 0);
  assert.equal(writes.length, 2);
});
test("insufficient stock never submits the reservation transaction", async (t) => {
  t.mock.method(documentClient, "send", async (command: unknown) => {
    assert.ok(command instanceof GetCommand);
    return {
      Item:
        command.input.Key?.productId === "prd_deck"
          ? {
              productId: "prd_deck",
              name: "Deck",
              price: 100,
              sizes: ["8"],
              status: "PUBLISHED",
              currency: "KRW",
              inventoryQuantity: 1,
              version: 1,
            }
          : undefined,
    };
  });
  await assert.rejects(() => reserveInventory(order, "pk"), /INVENTORY_INSUFFICIENT/);
});
test("zero-balance approval failure/expiry releases only a hold and never invents a monetary refund", async (t) => {
  let current: OrderRecord = order;
  t.mock.method(documentClient, "send", async (c: unknown) => {
    if (c instanceof GetCommand)
      return {
        Item:
          c.input.Key?.productId === "prd_deck"
            ? {
                productId: "prd_deck",
                name: "Deck",
                price: 100,
                sizes: ["8"],
                status: "PUBLISHED",
                currency: "KRW",
                inventoryQuantity: 4,
                inventoryReserved: 2,
                inventoryCommitted: 0,
                version: 1,
              }
            : undefined,
      };
    assert.ok(c instanceof TransactWriteCommand);
    current = c.input.TransactItems![0]!.Put!.Item! as OrderRecord;
    return {};
  });
  for (const status of ["ABORTED", "EXPIRED"]) {
    const held: OrderRecord = {
      ...order,
      inventory: {
        schema: 1,
        version: 1,
        state: "RESERVED",
        paymentKey: "pk",
        expiresAt: "2026-10-15T00:30:00Z",
        fulfillment: "UNCONFIRMED",
        restored: [0],
        canceled: [0],
        refundedAmount: 0,
        operations: {},
      },
    };
    const result = await settleInventoryPayment(held, {
      paymentKey: "pk",
      orderId: order.orderId,
      totalAmount: 200,
      balanceAmount: 0,
      status,
      method: "카드",
      currency: "KRW",
      cancels: [],
    });
    assert.equal(result.status, "FAILED");
    assert.equal(result.inventory?.state, "RELEASED");
    assert.equal(result.inventory?.refundedAmount, 0);
    assert.equal(result.financialRefundedAmount, 0);
    assert.equal(result.financialEvents, undefined);
    assert.equal(current.financialEvents, undefined);
    await assert.rejects(
      () =>
        settleInventoryPayment(held, {
          paymentKey: "pk",
          orderId: order.orderId,
          totalAmount: 200,
          balanceAmount: 0,
          status,
          method: "카드",
          currency: "KRW",
          cancels: [
            {
              transactionKey: "tx",
              cancelAmount: 200,
              cancelReason: "reason",
              cancelStatus: "DONE",
            },
          ],
        }),
      /PAYMENT_PROVIDER_MISMATCH/,
    );
  }
});
