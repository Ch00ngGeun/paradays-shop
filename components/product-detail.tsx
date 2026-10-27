// 역할: 카드에서 진입한 상품의 정보, 옵션, 수량과 장바구니 추가 동작을 한 화면에 제공합니다.
"use client";

import Image from "next/image";
import { useRef, useState, type PointerEvent } from "react";

import { useCart } from "@/contexts/cart-context";
import { useLocale } from "@/contexts/locale-context";
import {
  getLocalizedProductDescription,
  getLocalizedProductName,
} from "@/lib/commerce/product-i18n";
import type { Product } from "@/types/store";

import { AddedToCartModal } from "./added-to-cart-modal";
import styles from "./product-detail.module.css";

type ProductDetailProps = {
  product: Product;
};

/** 상세 가격·비교가에 쓰는 원화 포맷터. */
const currencyFormatter = new Intl.NumberFormat("ko-KR", {
  style: "currency",
  currency: "KRW",
  maximumFractionDigits: 0,
});

/** 스와이프로 이미지 넘기기 최소 거리(px) */
const SWIPE_THRESHOLD_PX = 48;

/** 상세 갤러리 경로 목록. images가 없으면 대표 image 한 장만 씁니다. */
function getGalleryImages(product: Product) {
  if (product.images && product.images.length > 0) {
    return product.images;
  }

  return [product.image];
}

/**
 * `/products/[slug]` 본문.
 * PC: 이미지 상자 안 좌우 화살표. 모바일: 화살표 없이 드래그/스와이프.
 */
export function ProductDetail({ product }: ProductDetailProps) {
  const { addItem } = useCart();
  const { copy, locale } = useLocale();
  const displayName = getLocalizedProductName(product, locale);
  const displayDescription = getLocalizedProductDescription(product, locale);
  const isSoldOut =
    typeof product.inventoryQuantity === "number" && product.inventoryQuantity <= 0;
  const [quantity, setQuantity] = useState(1);
  const [selectedSize, setSelectedSize] = useState(product.sizes[0]);
  const [isAddedModalOpen, setIsAddedModalOpen] = useState(false);
  const gallery = getGalleryImages(product);
  const [imageIndex, setImageIndex] = useState(0);
  const hasGallery = gallery.length > 1;
  const currentImage = gallery[imageIndex] ?? gallery[0];
  const swipeStartXRef = useRef<number | null>(null);

  const handleAddToCart = () => {
    if (isSoldOut) {
      return;
    }

    // 선택한 사이즈와 수량을 하나의 variant 라인으로 저장해 서버 Checkout에도 그대로 전달합니다.
    addItem(product, selectedSize, quantity);
    setIsAddedModalOpen(true);
  };

  const showPreviousImage = () => {
    setImageIndex((index) => (index - 1 + gallery.length) % gallery.length);
  };

  const showNextImage = () => {
    setImageIndex((index) => (index + 1) % gallery.length);
  };

  const handleGalleryPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!hasGallery) {
      return;
    }

    swipeStartXRef.current = event.clientX;
  };

  const handleGalleryPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!hasGallery || swipeStartXRef.current === null) {
      return;
    }

    const deltaX = event.clientX - swipeStartXRef.current;
    swipeStartXRef.current = null;

    if (Math.abs(deltaX) < SWIPE_THRESHOLD_PX) {
      return;
    }

    if (deltaX < 0) {
      showNextImage();
    } else {
      showPreviousImage();
    }
  };

  const handleGalleryPointerCancel = () => {
    swipeStartXRef.current = null;
  };

  return (
    <article className={styles.productPage}>
      <div
        className={
          isSoldOut
            ? `${styles.productInfo} ${styles.productInfoSoldOut}`
            : styles.productInfo
        }
      >
        <h1>{displayName}</h1>
        <ul className={styles.description}>
          {displayDescription.map((detail) => (
            <li key={detail}>{detail}</li>
          ))}
        </ul>

        <div className={styles.options}>
          <fieldset>
            <legend>{copy.productQuantity}</legend>
            <div className={styles.quantityControl}>
              <button
                aria-label="수량 감소"
                disabled={isSoldOut || quantity === 1}
                onClick={() => setQuantity((value) => Math.max(1, value - 1))}
                type="button"
              >
                −
              </button>
              <span aria-live="polite">{quantity}</span>
              <button
                aria-label="수량 증가"
                disabled={isSoldOut}
                onClick={() => setQuantity((value) => value + 1)}
                type="button"
              >
                +
              </button>
            </div>
          </fieldset>
          <fieldset>
            <legend>{copy.productSize}</legend>
            <div className={styles.sizeList}>
              {product.sizes.map((size) => (
                <button
                  aria-pressed={selectedSize === size}
                  disabled={isSoldOut}
                  key={size}
                  onClick={() => setSelectedSize(size)}
                  type="button"
                >
                  {size}
                </button>
              ))}
            </div>
          </fieldset>
        </div>

        <button
          className={
            isSoldOut
              ? `${styles.addButton} ${styles.addButtonSoldOut}`
              : styles.addButton
          }
          disabled={isSoldOut}
          onClick={handleAddToCart}
          type="button"
        >
          {isSoldOut ? (
            <span className={styles.addButtonSoldOutLabel}>SOLD OUT</span>
          ) : (
            <>
              <span>
                {currencyFormatter.format(product.price)}
                {product.compareAtPrice ? (
                  <s>{currencyFormatter.format(product.compareAtPrice)}</s>
                ) : null}
              </span>
              <span aria-hidden="true">＋</span>
              <span className="srOnly">{`${selectedSize} ${displayName} ${copy.addToCart}`}</span>
            </>
          )}
        </button>
      </div>

      <div className={styles.gallery}>
        <div
          className={
            isSoldOut
              ? `${styles.productImage} ${styles.productImageSoldOut}`
              : styles.productImage
          }
          onPointerCancel={handleGalleryPointerCancel}
          onPointerDown={handleGalleryPointerDown}
          onPointerUp={handleGalleryPointerUp}
        >
          {product.featured ? <span className={styles.newBadge}>New</span> : null}
          {isExternalImage(currentImage) ? (
            // 발행된 상품이 승인된 외부 CDN 이미지를 쓸 수 있도록 상세에서도 browser image를 지원합니다.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              alt={displayName}
              draggable={false}
              referrerPolicy="no-referrer"
              src={currentImage}
            />
          ) : (
            <Image
              alt={displayName}
              draggable={false}
              fill
              priority
              sizes="(max-width: 767px) 100vw, 55vw"
              src={currentImage}
            />
          )}

          {isSoldOut ? (
            <span aria-hidden="true" className={styles.soldOutBadge}>
              SOLD OUT
            </span>
          ) : null}

          {hasGallery ? (
            <>
              <button
                aria-label={copy.previousImage}
                className={`${styles.galleryArrow} ${styles.galleryArrowPrev}`}
                onClick={showPreviousImage}
                type="button"
              >
                ‹
              </button>
              <button
                aria-label={copy.nextImage}
                className={`${styles.galleryArrow} ${styles.galleryArrowNext}`}
                onClick={showNextImage}
                type="button"
              >
                ›
              </button>
            </>
          ) : null}
        </div>

        {hasGallery ? (
          <div
            aria-label={`${displayName} images`}
            className={styles.dots}
            role="tablist"
          >
            {gallery.map((src, index) => (
              <button
                aria-label={`${displayName} image ${index + 1}`}
                aria-selected={index === imageIndex}
                className={
                  index === imageIndex
                    ? `${styles.dot} ${styles.dotActive}`
                    : styles.dot
                }
                key={`${src}-${index}`}
                onClick={() => setImageIndex(index)}
                role="tab"
                type="button"
              />
            ))}
          </div>
        ) : null}
      </div>

      <AddedToCartModal
        isOpen={isAddedModalOpen}
        onClose={() => setIsAddedModalOpen(false)}
        productName={displayName}
      />
    </article>
  );
}

function isExternalImage(image: string) {
  return image.startsWith("https://");
}
