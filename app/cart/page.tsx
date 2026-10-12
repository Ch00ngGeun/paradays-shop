// 역할: 전역 Cart 링크가 이동하는 "Your Cart" 전용 페이지를 렌더링합니다.
"use client";

import { CartContent } from "@/components/cart-content";
import { useLocale } from "@/contexts/locale-context";

import styles from "./page.module.css";

/** `/cart` 페이지: 제목·무료배송 안내 + CartContent */
export default function CartPage() {
  const { copy } = useLocale();

  return (
    <section className={styles.cartPage} aria-labelledby="cart-title">
      <div className={styles.heading}>
        <h1 id="cart-title">Your Cart</h1>
        <p>{copy.freeShipping}</p>
      </div>
      <CartContent />
    </section>
  );
}
