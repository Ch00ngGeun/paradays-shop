/** 결제 주문명이 상품명 줄바꿈과 관계없이 한 줄이고, 길이·'외 N건' 규칙을 지키는지 확인함. */
import assert from "node:assert/strict";
import test from "node:test";

import { calculateOrder } from "../lambda/order-domain.js";

const product = (id: string, name: string) => ({
  id,
  name,
  price: 10_000,
  sizes: ["8.25"],
});
const line = (productId: string) => ({ productId, selectedSize: "8.25", quantity: 1 });

test("a product name on two lines becomes a one-line order name", () => {
  const order = calculateOrder([line("a")], [product("a", "Synthetic\nDeck  \t 8.25")]);

  assert.equal(order.orderName, "Synthetic Deck 8.25");
  // The line snapshot keeps the stored name; only the payment order name is joined.
  assert.equal(order.lines[0]?.name, "Synthetic\nDeck  \t 8.25");

  // Joining happens before the cut, so a break near the limit cannot push the name past it.
  const broken = calculateOrder(
    [line("a")],
    [product("a", `${"가".repeat(99)}\n\n나다`)],
  );
  assert.equal(broken.orderName, `${"가".repeat(99)} `);
  assert.equal(broken.orderName.length, 100);
});

test("the first of several products is joined before the count suffix", () => {
  const order = calculateOrder(
    [line("a"), line("b"), line("c")],
    [
      product("a", "First\r\n\nDeck"),
      product("b", "Second\nDeck"),
      product("c", "Third"),
    ],
  );

  assert.equal(order.orderName, "First Deck 외 2건");
  assert.doesNotMatch(order.orderName, /[\r\n\t]/);
});

test("plain names and the 100-character limit keep their previous result", () => {
  assert.equal(
    calculateOrder([line("a")], [product("a", "Synthetic Deck")]).orderName,
    "Synthetic Deck",
  );

  const long = "가".repeat(120);
  const single = calculateOrder([line("a")], [product("a", long)]);
  assert.equal(single.orderName, "가".repeat(100));

  const several = calculateOrder(
    [line("a"), line("b")],
    [product("a", long), product("b", "Other")],
  );
  assert.equal(several.orderName, `${"가".repeat(95)} 외 1건`);
  assert.equal(several.orderName.length, 100);
});
