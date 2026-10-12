// 역할: 브라우저 전용 장바구니의 순수하고 테스트 가능한 상태 전환을 정의합니다.
import type { CartAction, CartLine, CartState } from "@/types/store";

/** 초기·비우기 시 쓰는 빈 장바구니 상태 */
export const emptyCartState: CartState = { items: [] };

/** 결제 API가 허용하는 한 옵션당 최대 수량과 클라이언트 상태를 맞춥니다. */
export const MAX_CART_LINE_QUANTITY = 10;

/** 같은 상품의 다른 사이즈를 별도 결제 라인으로 식별하는 결정적 키입니다. */
export function createCartLineId(productId: string, selectedSize: string) {
  return `${productId}::${encodeURIComponent(selectedSize)}`;
}

/** 예전 localStorage 형식에는 selectedSize·lineId가 없으므로 첫 옵션으로 안전하게 마이그레이션합니다. */
function normalizeCartLine(line: CartLine): CartLine {
  const availableSizes = Array.isArray(line.sizes) ? line.sizes : [];
  const selectedSize = availableSizes.includes(line.selectedSize)
    ? line.selectedSize
    : (availableSizes[0] ?? "One Size");
  const quantity = Math.min(
    MAX_CART_LINE_QUANTITY,
    Math.max(1, Number.isInteger(line.quantity) ? line.quantity : 1),
  );

  return {
    ...line,
    lineId: createCartLineId(line.id, selectedSize),
    selectedSize,
    quantity,
  };
}

/** localStorage에 남은 레거시 라인을 새 variant 기반 라인으로 정규화하고 중복을 합칩니다. */
export function normalizeCartState(state: CartState): CartState {
  const linesById = new Map<string, CartLine>();

  for (const line of state.items) {
    const normalizedLine = normalizeCartLine(line);
    const existingLine = linesById.get(normalizedLine.lineId);

    linesById.set(
      normalizedLine.lineId,
      existingLine
        ? {
            ...existingLine,
            quantity: Math.min(
              MAX_CART_LINE_QUANTITY,
              existingLine.quantity + normalizedLine.quantity,
            ),
          }
        : normalizedLine,
    );
  }

  return { items: [...linesById.values()] };
}

/**
 * 장바구니 리듀서.
 * hydrate / add / remove / setQuantity / clear 전환을 모두 순수 함수로 처리합니다.
 * setQuantity가 0 이하면 해당 라인을 목록에서 제거합니다.
 */
export function cartReducer(state: CartState, action: CartAction): CartState {
  switch (action.type) {
    case "hydrate":
      return normalizeCartState(action.payload);
    case "add": {
      const lineId = createCartLineId(action.product.id, action.selectedSize);
      const existingLine = state.items.find((item) => item.lineId === lineId);
      const quantity = Math.max(1, action.quantity);

      if (existingLine) {
        return {
          items: state.items.map((item) =>
            item.lineId === lineId
              ? {
                  ...item,
                  quantity: Math.min(MAX_CART_LINE_QUANTITY, item.quantity + quantity),
                }
              : item,
          ),
        };
      }

      return {
        items: [
          ...state.items,
          {
            ...action.product,
            lineId,
            selectedSize: action.selectedSize,
            quantity: Math.min(MAX_CART_LINE_QUANTITY, quantity),
          },
        ],
      };
    }
    case "remove":
      return {
        items: state.items.filter((item) => item.lineId !== action.lineId),
      };
    case "setQuantity":
      return {
        items: state.items
          .map((item) =>
            item.lineId === action.lineId
              ? {
                  ...item,
                  quantity: Math.min(
                    MAX_CART_LINE_QUANTITY,
                    Math.max(0, action.quantity),
                  ),
                }
              : item,
          )
          .filter((item) => item.quantity > 0),
      };
    case "clear":
      return emptyCartState;
    default:
      return state;
  }
}
