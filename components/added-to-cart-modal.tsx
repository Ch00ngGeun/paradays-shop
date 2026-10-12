// 역할: 장바구니 담기 직후 확인 오버레이(계속 쇼핑 / 결제)를 표시합니다.
"use client";

import Link from "next/link";
import { useEffect, useState, type MouseEvent, type TransitionEvent } from "react";

import { useLocale } from "@/contexts/locale-context";
import { useFocusTrap } from "@/hooks/use-focus-trap";

import styles from "./added-to-cart-modal.module.css";

type AddedToCartModalProps = {
  isOpen: boolean;
  productName: string;
  onClose: () => void;
};

/**
 * 담기 성공 모달.
 * 흰 스크림은 메뉴·상품 호버와 같은 --ui-fade-duration으로 페이드인/아웃합니다.
 */
export function AddedToCartModal({
  isOpen,
  productName,
  onClose,
}: AddedToCartModalProps) {
  const { copy } = useLocale();
  const dialogRef = useFocusTrap(isOpen, onClose);
  // 닫힐 때도 페이드아웃이 끝나기 전까지 DOM에 남겨 둡니다.
  const [isMounted, setIsMounted] = useState(isOpen);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    let outerFrame = 0;
    let innerFrame = 0;

    if (isOpen) {
      // opacity 0 DOM을 먼저 렌더한 뒤 visible로 바꿔 페이드인이 적용되게 합니다.
      outerFrame = window.requestAnimationFrame(() => {
        setIsMounted(true);
        innerFrame = window.requestAnimationFrame(() => setIsVisible(true));
      });
    } else {
      // 닫기 state도 frame 경계에서 갱신해 effect의 동기 state 갱신을 만들지 않습니다.
      outerFrame = window.requestAnimationFrame(() => setIsVisible(false));
    }

    return () => {
      window.cancelAnimationFrame(outerFrame);
      window.cancelAnimationFrame(innerFrame);
    };
  }, [isOpen]);

  /** 페이드아웃 transition이 끝난 뒤에만 언마운트합니다. */
  const handleOverlayTransitionEnd = (event: TransitionEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || event.propertyName !== "opacity") {
      return;
    }

    if (!isOpen) {
      setIsMounted(false);
    }
  };

  if (!isMounted) {
    return null;
  }

  /** 스크림만 눌렀을 때 닫고, 다이얼로그 내부 클릭은 유지합니다. */
  const handleOverlayClick = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) {
      onClose();
    }
  };

  return (
    <div
      className={
        isVisible ? `${styles.overlay} ${styles.overlayVisible}` : styles.overlay
      }
      onClick={handleOverlayClick}
      onTransitionEnd={handleOverlayTransitionEnd}
    >
      <section
        aria-labelledby="added-to-cart-title"
        aria-modal="true"
        className={styles.dialog}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <h2 className={styles.productName} id="added-to-cart-title">
          {productName}
        </h2>
        <p className={styles.message}>{copy.wasAddedToCart}</p>

        {/* 장바구니 담김을 나타내는 쇼핑백+체크 아이콘 */}
        <div aria-hidden="true" className={styles.iconRing}>
          <svg
            className={styles.bagIcon}
            fill="none"
            viewBox="0 0 64 64"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              d="M18 22h28l-2.5 28H20.5L18 22Z"
              stroke="currentColor"
              strokeLinejoin="round"
              strokeWidth="1.6"
            />
            <path
              d="M24 22c0-4.4 3.1-8 7-8s7 3.6 7 8"
              stroke="currentColor"
              strokeLinecap="round"
              strokeWidth="1.6"
            />
            <path
              d="M27 38l4 4 8-9"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="1.8"
            />
          </svg>
        </div>

        <p className={styles.actions}>
          <button className={styles.actionLink} onClick={onClose} type="button">
            {copy.continueShopping}
          </button>
          <span aria-hidden="true">·</span>
          <Link className={styles.actionLink} href="/cart" onClick={onClose}>
            {copy.checkoutLink}
          </Link>
        </p>

        <button
          aria-label={copy.close}
          className={styles.closeButton}
          data-autofocus
          onClick={onClose}
          type="button"
        >
          ×
        </button>
      </section>
    </div>
  );
}
