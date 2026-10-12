// 역할: 스토어프론트를 위해 리듀서 기반 장바구니 상태와 안전한 브라우저 지속성을 제공합니다.
"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useState,
  type ReactNode,
} from "react";

import { cartReducer, emptyCartState } from "@/lib/cart-reducer";
import type { CartLine, CartState, Product } from "@/types/store";

/** localStorage에 장바구니 JSON을 저장할 때 쓰는 키 */
const CART_STORAGE_KEY = "paradays-cart";

type CartContextValue = {
  items: CartLine[];
  itemCount: number;
  subtotal: number;
  addItem: (product: Product, selectedSize: string, quantity?: number) => void;
  removeItem: (lineId: string) => void;
  setQuantity: (lineId: string, quantity: number) => void;
  clearCart: () => void;
};

const CartContext = createContext<CartContextValue | null>(null);

/**
 * 장바구니 Provider.
 * 마운트 시 스토리지에서 hydrate하고, 이후 변경은 다시 저장합니다.
 */
export function CartProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(cartReducer, emptyCartState);
  // hydrate 완료 전에는 빈 상태로 덮어쓰지 않도록 저장을 막습니다.
  const [hasLoadedCart, setHasLoadedCart] = useState(false);

  // 유효한 로컬 데이터만 하이드레이션하고, 잘못된 브라우저 스토리지가 샵 UI를 막지 않게 합니다.
  useEffect(() => {
    try {
      const savedCart = window.localStorage.getItem(CART_STORAGE_KEY);

      if (savedCart) {
        const parsedCart: unknown = JSON.parse(savedCart);

        if (
          typeof parsedCart === "object" &&
          parsedCart !== null &&
          "items" in parsedCart &&
          Array.isArray(parsedCart.items)
        ) {
          dispatch({ type: "hydrate", payload: parsedCart as CartState });
        }
      }
    } catch {
      // 브라우저 스토리지를 읽거나 파싱할 수 없으면 메모리 안의 빈 장바구니를 유지합니다.
    } finally {
      setHasLoadedCart(true);
    }
  }, []);

  // hydrate 이후에만 상태를 로컬 스토리지에 반영합니다.
  useEffect(() => {
    if (hasLoadedCart) {
      try {
        window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(state));
      } catch {
        // 스토리지를 사용할 수 없어도 현재 탭에서는 장바구니를 계속 쓸 수 있습니다.
      }
    }
  }, [hasLoadedCart, state]);

  const value = useMemo<CartContextValue>(() => {
    const itemCount = state.items.reduce((total, item) => total + item.quantity, 0);
    const subtotal = state.items.reduce(
      (total, item) => total + item.price * item.quantity,
      0,
    );

    return {
      items: state.items,
      itemCount,
      subtotal,
      addItem: (product, selectedSize, quantity = 1) =>
        dispatch({ type: "add", product, selectedSize, quantity }),
      removeItem: (lineId) => dispatch({ type: "remove", lineId }),
      setQuantity: (lineId, quantity) =>
        dispatch({ type: "setQuantity", lineId, quantity }),
      clearCart: () => dispatch({ type: "clear" }),
    };
  }, [state]);

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

/** CartProvider 하위에서 장바구니 상태·액션에 접근합니다. */
export function useCart() {
  const context = useContext(CartContext);

  if (!context) {
    throw new Error("useCart must be used within CartProvider.");
  }

  return context;
}
