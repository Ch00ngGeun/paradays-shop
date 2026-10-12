// 역할: 장바구니 추가, 수량 변경, 삭제에 대한 리듀서 동작을 검증합니다.
import { describe, expect, it } from "vitest";

import { cartReducer, emptyCartState } from "@/lib/cart-reducer";
import type { Product } from "@/types/store";

/** 테스트용 더미 상품 */
const deck: Product = {
  id: "deck",
  slug: "test-deck",
  name: "Test Deck",
  category: "Deck",
  brand: "April",
  price: 84,
  image: "/images/product-placeholder.svg",
  description: ["Test product"],
  sizes: ["8.25”"],
};

describe("cartReducer", () => {
  /** 같은 상품·같은 옵션을 두 번 담으면 라인이 늘지 않고 수량만 증가하는지 확인 */
  it("increments an existing product variant instead of creating a duplicate line", () => {
    const onceAdded = cartReducer(emptyCartState, {
      type: "add",
      product: deck,
      selectedSize: "8.25”",
      quantity: 1,
    });
    const twiceAdded = cartReducer(onceAdded, {
      type: "add",
      product: deck,
      selectedSize: "8.25”",
      quantity: 1,
    });

    expect(twiceAdded.items).toHaveLength(1);
    expect(twiceAdded.items[0]?.quantity).toBe(2);
  });

  /** 같은 상품이라도 다른 옵션은 결제에서 별도 라인으로 유지해야 합니다. */
  it("creates separate cart lines for different selected sizes", () => {
    const firstSize = cartReducer(emptyCartState, {
      type: "add",
      product: deck,
      selectedSize: "8.25”",
      quantity: 1,
    });
    const secondSize = cartReducer(firstSize, {
      type: "add",
      product: { ...deck, sizes: ["8.25”", "8.5”"] },
      selectedSize: "8.5”",
      quantity: 1,
    });

    expect(secondSize.items).toHaveLength(2);
    expect(secondSize.items.map((line) => line.selectedSize)).toEqual([
      "8.25”",
      "8.5”",
    ]);
  });

  /** 수량을 0으로 내리면 해당 라인이 목록에서 사라지는지 확인 */
  it("removes a line when its requested quantity reaches zero", () => {
    const onceAdded = cartReducer(emptyCartState, {
      type: "add",
      product: deck,
      selectedSize: "8.25”",
      quantity: 1,
    });
    const emptied = cartReducer(onceAdded, {
      type: "setQuantity",
      lineId: onceAdded.items[0]!.lineId,
      quantity: 0,
    });

    expect(emptied.items).toEqual([]);
  });
});
