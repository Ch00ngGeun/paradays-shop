import assert from "node:assert/strict";
import test from "node:test";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { handler } from "../lambda/checkout-handler.js";
import { documentClient } from "../lambda/dynamodb-client.js";
import { event, paymentFixture, response } from "./payment-flow-fixture.js";
test("checkout uses CMS price; repeat returns immutable snapshot after price changes", async (t) => {
  const db = paymentFixture(t);
  const request = event({
    lines: [{ productId: "prd_deck", selectedSize: "8", quantity: 2 }],
  });
  const first = response(await handler(request));
  assert.equal(first.status, 201);
  assert.equal(first.body.amount, 200);
  db.records.set("catalog:prd_deck", { ...db.product(), price: 999, status: "DRAFT" });
  const second = response(await handler(request));
  assert.deepEqual(second, first);
  assert.equal(db.calls.length, 0);
  assert.equal(
    response(
      await handler(
        event({ lines: [{ productId: "prd_deck", selectedSize: "8", quantity: 1 }] }),
      ),
    ).status,
    409,
  );
});
test("a concurrent identical retry that read a newer price replays the saved order", async (t) => {
  const db = paymentFixture(t);
  const request = event({
    lines: [{ productId: "prd_deck", selectedSize: "8", quantity: 2 }],
  });
  const first = response(await handler(request));
  assert.equal(first.status, 201);
  db.records.set("catalog:prd_deck", { ...db.product(), price: 999 });
  // The retry's first order read happened before the first request saved.
  const send = documentClient.send.bind(documentClient);
  let hideSavedOrder = true;
  t.mock.method(
    documentClient,
    "send",
    async (command: unknown, ...rest: unknown[]) => {
      if (
        hideSavedOrder &&
        command instanceof GetCommand &&
        command.input.Key?.orderId
      ) {
        hideSavedOrder = false;
        return { Item: undefined };
      }
      return (send as (...args: unknown[]) => Promise<unknown>)(command, ...rest);
    },
  );
  const retry = response(await handler(request));
  assert.equal(retry.status, 201);
  assert.equal(retry.body.amount, first.body.amount);
  assert.deepEqual(retry, first);
});
test("canonical ID, combined product stock and publication fail closed", async (t) => {
  const db = paymentFixture(t);
  assert.equal(
    response(
      await handler(
        event({
          lines: [{ productId: "legacy-deck", selectedSize: "8", quantity: 1 }],
        }),
      ),
    ).status,
    409,
  );
  db.records.set("catalog:prd_deck", { ...db.product(), inventoryReserved: 3 });
  assert.equal(
    response(
      await handler(
        event({
          lines: [
            { productId: "prd_deck", selectedSize: "8", quantity: 1 },
            { productId: "prd_deck", selectedSize: "9", quantity: 1 },
          ],
        }),
      ),
    ).status,
    409,
  );
  assert.equal(db.records.size, 1);
  assert.equal(db.calls.length, 0);
});
