// 역할: 결제 Lambda로 옮겨질 주문 가격 검증과 상태 전이 규칙이 클라이언트 입력을 신뢰하지 않는지 검증합니다.
import { describe, expect, it } from "vitest";

import { products } from "@/data/products";
import {
  calculateServerOrder,
  canTransitionOrder,
  transitionOrder,
} from "@/lib/commerce/checkout-domain";

describe("calculateServerOrder", () => {
  it("카탈로그 가격으로 주문 금액을 재계산함", () => {
    const product = products[0];
    const order = calculateServerOrder(
      [
        {
          productId: product.id,
          quantity: 2,
          selectedSize: product.sizes[0],
        },
      ],
      products,
    );

    expect(order).toMatchObject({
      currency: "KRW",
      status: "PENDING_PAYMENT",
      subtotal: product.price * 2,
      total: product.price * 2,
    });
    expect(order.lines[0]).toMatchObject({
      name: product.name,
      unitPrice: product.price,
      quantity: 2,
    });
  });

  it.each([
    [
      { productId: "missing", quantity: 1, selectedSize: "M" },
      "CHECKOUT_PRODUCT_NOT_FOUND",
    ],
    [
      { productId: products[0].id, quantity: 0, selectedSize: products[0].sizes[0] },
      "CHECKOUT_QUANTITY_INVALID",
    ],
    [
      { productId: products[0].id, quantity: 11, selectedSize: products[0].sizes[0] },
      "CHECKOUT_QUANTITY_LIMIT_EXCEEDED",
    ],
    [
      { productId: products[0].id, quantity: 1, selectedSize: "invalid" },
      "CHECKOUT_SIZE_INVALID",
    ],
  ])("잘못된 checkout line을 거부함", (line, errorCode) => {
    expect(() => calculateServerOrder([line], products)).toThrow(errorCode);
  });
});

describe("order status transitions", () => {
  it("결제 대기 주문만 결제 완료로 이동할 수 있음", () => {
    expect(canTransitionOrder("PENDING_PAYMENT", "PAID")).toBe(true);
    expect(transitionOrder("PENDING_PAYMENT", "PAID")).toBe("PAID");
  });

  it("완료된 결제를 결제 대기로 되돌리는 것을 거부함", () => {
    expect(canTransitionOrder("PAID", "PENDING_PAYMENT")).toBe(false);
    expect(() => transitionOrder("PAID", "PENDING_PAYMENT")).toThrow(
      "ORDER_STATUS_TRANSITION_INVALID",
    );
  });
});
