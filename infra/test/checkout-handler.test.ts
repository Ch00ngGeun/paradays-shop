import assert from "node:assert/strict";
import test from "node:test";
import { handler } from "../lambda/checkout-handler.js";
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
