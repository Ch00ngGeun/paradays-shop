// 역할: 카드에서 진입한 상품의 정보, 옵션, 수량과 장바구니 추가 동작을 한 화면에 제공합니다.
"use client";

import Image from "next/image";
import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { useCart } from "@/contexts/cart-context";
import { useLocale } from "@/contexts/locale-context";
import { useFocusTrap } from "@/hooks/use-focus-trap";
import { useModalLayer } from "@/hooks/use-modal-layer";
import {
  getLocalizedProductDescription,
  getLocalizedProductName,
} from "@/lib/commerce/product-i18n";
import type { SizeChartKind, SizeChartValues } from "@/lib/size-chart";
import type { Locale, Product } from "@/types/store";

import { AddedToCartModal } from "./added-to-cart-modal";
import { DeckSizeDiagram } from "./deck-size-diagram";
import { SizeChartBottom } from "./size-chart-bottom";
import { SizeChartTop } from "./size-chart-top";
import { SizeChartWheel } from "./size-chart-wheel";
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
  const [isSizeChartOpen, setIsSizeChartOpen] = useState(false);
  // 선택한 사이즈에 옵션값이 있으면 그것을, 없으면 상품 공통 기본값을 도면에 씁니다.
  const deckSpec =
    selectedSize &&
    product.deckSpecsBySize &&
    Object.hasOwn(product.deckSpecsBySize, selectedSize)
      ? product.deckSpecsBySize[selectedSize]
      : product.deckSpec;
  // Clothing and wheels follow the same rule with their own drawing; a deck keeps the deck chart.
  const chartValues =
    selectedSize &&
    product.sizeChartsBySize &&
    Object.hasOwn(product.sizeChartsBySize, selectedSize)
      ? product.sizeChartsBySize[selectedSize]
      : product.sizeChart?.values;
  const chartKind = product.sizeChartKind ?? product.sizeChart?.kind;
  // The product's current category picks the chart: a deck spec left from an earlier category
  // never shows on a top or a wheel, and the parser already keeps only kinds the category offers.
  const sizeChartDiagram =
    product.category === "Deck" ? (
      deckSpec ? (
        <DeckSizeDiagram spec={deckSpec} />
      ) : null
    ) : chartKind && chartValues ? (
      <CategorySizeChart kind={chartKind} locale={locale} values={chartValues} />
    ) : null;
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

        {sizeChartDiagram ? (
          <button
            aria-haspopup="dialog"
            className={styles.sizeChartButton}
            onClick={() => setIsSizeChartOpen(true)}
            type="button"
          >
            <span>{copy.sizeChart}</span>
            <span aria-hidden="true">＋</span>
          </button>
        ) : null}
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

      {sizeChartDiagram && isSizeChartOpen ? (
        <SizeChartOverlay
          closeLabel={copy.close}
          diagram={sizeChartDiagram}
          image={product.image}
          name={displayName}
          onClose={() => setIsSizeChartOpen(false)}
          title={copy.sizeChart}
        />
      ) : null}
    </article>
  );
}

/** 의류·휠 상세사이즈 도면: 도면 종류에 맞는 그림을 고릅니다. */
function CategorySizeChart({
  kind,
  values,
  locale,
}: Readonly<{ kind: SizeChartKind; values: SizeChartValues; locale: Locale }>) {
  if (kind === "wheel") return <SizeChartWheel locale={locale} values={values} />;
  return (
    <WideDiagram locale={locale}>
      {kind === "shortSleeve" || kind === "raglanLongSleeve" ? (
        <SizeChartTop kind={kind} locale={locale} values={values} />
      ) : (
        <SizeChartBottom kind={kind} locale={locale} values={values} />
      )}
    </WideDiagram>
  );
}

/**
 * 가로로 넓은 도면 칸. 도면은 글자가 읽히는 폭(CSS의 최소 폭) 아래로 줄지 않고,
 * 칸이 그보다 좁으면 칸 안에서 옆으로 넘깁니다. 실제로 넘칠 때만 키보드로 넘길 수 있는 영역이 됩니다.
 */
function WideDiagram({
  children,
  locale,
}: Readonly<{ children: ReactNode; locale: Locale }>) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    // The observer also reports once right away, so the first layout is measured too.
    const observer = new ResizeObserver(() => {
      const next = box.scrollWidth > box.clientWidth;
      // The box stops being a keyboard stop once it fits; keep the focus inside the dialog.
      if (!next && document.activeElement === box)
        box.closest<HTMLElement>('[role="dialog"]')?.focus();
      setOverflows(next);
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, []);
  return (
    <div
      className={styles.wideDiagram}
      ref={boxRef}
      {...(overflows
        ? {
            "aria-label":
              locale === "ko"
                ? "상세사이즈 도면, 옆으로 넘겨 보기"
                : "Size chart drawing, scroll sideways",
            role: "region",
            tabIndex: 0,
          }
        : {})}
    >
      {children}
    </div>
  );
}

type SizeChartOverlayProps = Readonly<{
  closeLabel: string;
  diagram: ReactNode;
  image: string;
  name: string;
  onClose: () => void;
  title: string;
}>;

/** 상세사이즈 전체 화면: 왼쪽 대표 이미지, 오른쪽 치수 도면. ESC·닫기 버튼으로 닫습니다. */
function SizeChartOverlay({
  closeLabel,
  diagram,
  image,
  name,
  onClose,
  title,
}: SizeChartOverlayProps) {
  const layer = useModalLayer(true);
  const dialogRef = useFocusTrap(true, onClose);

  if (!layer) {
    return null;
  }

  return createPortal(
    <section
      aria-label={`${name} ${title}`}
      aria-modal="true"
      className={styles.sizeChartOverlay}
      ref={dialogRef}
      role="dialog"
      tabIndex={-1}
    >
      <button
        aria-label={closeLabel}
        className={styles.sizeChartClose}
        data-autofocus
        onClick={onClose}
        type="button"
      >
        ×
      </button>
      <div className={styles.sizeChartImage}>
        {isExternalImage(image) ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img alt={name} referrerPolicy="no-referrer" src={image} />
        ) : (
          <Image alt={name} fill sizes="(max-width: 767px) 100vw, 45vw" src={image} />
        )}
      </div>
      <div className={styles.sizeChartDiagram}>{diagram}</div>
    </section>,
    layer,
  );
}

function isExternalImage(image: string) {
  return image.startsWith("https://");
}
