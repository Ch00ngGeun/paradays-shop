// 역할: 홈에서 상품 사진·이름·가격만 보여주는 카드형 카탈로그를 렌더링합니다.
"use client";

import Image from "next/image";
import Link from "next/link";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type CSSProperties,
} from "react";

import { useCatalogFilter } from "@/contexts/catalog-filter-context";
import { useLocale } from "@/contexts/locale-context";
import { products } from "@/data/products";
import { filterProducts } from "@/lib/catalog-filter";
import { getLocalizedProductName } from "@/lib/commerce/product-i18n";
import {
  isSamePublishedCatalog,
  readPublishedCatalogCache,
  readPublishedCatalogMemoryCache,
  writePublishedCatalogCache,
} from "@/lib/commerce/published-catalog-cache";
import { listPublishedCatalogProducts } from "@/lib/commerce/public-catalog-api-client";
import type { Product } from "@/types/store";

import styles from "./product-grid.module.css";

/** 공개 카탈로그 API가 이 시간 안에 응답하지 않으면 정적 목록을 먼저 보여 줍니다. */
const CATALOG_FALLBACK_DELAY_MS = 1200;

/** 원화 표기용 포맷터 (소수 없음). */
const currencyFormatter = new Intl.NumberFormat("ko-KR", {
  style: "currency",
  currency: "KRW",
  maximumFractionDigits: 0,
});

/** 메뉴 필터가 적용된 카탈로그 그리드. */
export function ProductGrid() {
  const { selectedIds } = useCatalogFilter();
  const { copy, locale } = useLocale();
  // undefined = 아직 목록을 확정하지 못함. 서버·하이드레이션 첫 렌더는 항상 undefined라 마크업이 어긋나지 않습니다.
  const [publishedProducts, setPublishedProducts] = useState<
    Product[] | null | undefined
  >(() => readPublishedCatalogMemoryCache());

  // 새로고침 직후에는 sessionStorage 캐시를 첫 페인트 전에 반영해 등장 애니메이션이 한 번만 재생되게 합니다.
  useLayoutEffect(() => {
    const cached = readPublishedCatalogCache();

    if (cached !== undefined) {
      // 하이드레이션 이후·첫 페인트 전에만 읽을 수 있는 스토리지 값이라 레이아웃 이펙트에서 동기 반영해야 합니다.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPublishedProducts((current) => (current === undefined ? cached : current));
    }
  }, []);

  /** 배포된 CMS API가 있을 때만 발행 상품을 합치며, 로컬 정적 데모는 계속 작동하게 합니다. */
  useEffect(() => {
    let isCurrent = true;
    const showStaticFallback = () => {
      if (isCurrent) {
        setPublishedProducts((current) => (current === undefined ? null : current));
      }
    };
    const fallbackTimer = window.setTimeout(
      showStaticFallback,
      CATALOG_FALLBACK_DELAY_MS,
    );

    void listPublishedCatalogProducts()
      .then((remoteProducts) => {
        writePublishedCatalogCache(remoteProducts);

        if (isCurrent) {
          setPublishedProducts((current) =>
            isSamePublishedCatalog(current, remoteProducts) ? current : remoteProducts,
          );
        }
      })
      .catch(() => {
        // 공개 카탈로그 API 장애가 기존 스토어 상품 전체를 빈 화면으로 만들지 않게 정적 목록을 유지합니다.
        showStaticFallback();
      })
      .finally(() => {
        window.clearTimeout(fallbackTimer);
      });

    return () => {
      isCurrent = false;
      window.clearTimeout(fallbackTimer);
    };
  }, []);

  const isCatalogPending = publishedProducts === undefined;

  const catalogProducts = useMemo(
    () => mergeCatalogProducts(products, publishedProducts ?? null),
    [publishedProducts],
  );
  const publishedProductSlugs = useMemo(
    () => new Set(publishedProducts?.map((product) => product.slug) ?? []),
    [publishedProducts],
  );
  const visibleProducts = useMemo(() => {
    const filtered = filterProducts(catalogProducts, selectedIds);
    return [...filtered].sort((left, right) => {
      const rank = (product: Product) => {
        if (isProductSoldOut(product)) {
          return 2;
        }

        if (product.featured) {
          return 0;
        }

        return 1;
      };

      return rank(left) - rank(right);
    });
  }, [catalogProducts, selectedIds]);

  if (isCatalogPending) {
    return (
      <ul
        aria-busy="true"
        aria-label="PARADAYS products"
        className={`${styles.grid} ${styles.gridPending}`}
      />
    );
  }

  if (visibleProducts.length === 0) {
    return <p className={styles.empty}>{copy.noResults}</p>;
  }

  const filterRevealKey =
    selectedIds.size === 0
      ? "all"
      : [...selectedIds].sort().join("|");

  return (
    <ul
      aria-label="PARADAYS products"
      className={styles.grid}
      key={filterRevealKey}
    >
      {visibleProducts.map((product, index) => {
        const displayName = getLocalizedProductName(product, locale);
        const soldOut = isProductSoldOut(product);

        return (
          <li
            className={styles.card}
            key={product.slug}
            style={
              {
                "--reveal-index": Math.min(index, 14),
              } as CSSProperties
            }
          >
            <Link
              aria-label={
                soldOut
                  ? `${displayName} SOLD OUT 상품상세 보기`
                  : `${displayName} 상품상세 보기`
              }
              className={styles.cardLink}
              href={
                publishedProductSlugs.has(product.slug)
                  ? `/products?slug=${encodeURIComponent(product.slug)}`
                  : `/products/${product.slug}`
              }
            >
              <div
                className={
                  soldOut ? `${styles.media} ${styles.mediaSoldOut}` : styles.media
                }
              >
                {product.featured ? (
                  <span className={styles.newBadge}>New</span>
                ) : null}
                {isExternalImage(product.image) ? (
                  // 외부 CDN 이미지는 Next image allowlist에 없는 발행 상품도 표시할 수 있도록 브라우저가 직접 읽습니다.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    alt={displayName}
                    className={styles.mediaImage}
                    loading={index === 0 ? "eager" : "lazy"}
                    referrerPolicy="no-referrer"
                    src={product.image}
                  />
                ) : (
                  <Image
                    alt={displayName}
                    className={styles.mediaImage}
                    fill
                    loading={index === 0 ? "eager" : "lazy"}
                    sizes="(max-width: 767px) 88vw, 30vw"
                    src={product.image}
                  />
                )}
                {soldOut ? (
                  <span aria-hidden="true" className={styles.soldOutBadge}>
                    SOLD OUT
                  </span>
                ) : null}
              </div>
              <div
                className={
                  soldOut
                    ? `${styles.details} ${styles.detailsSoldOut}`
                    : styles.details
                }
              >
                <h2>{displayName}</h2>
                <p className={styles.price}>
                  {currencyFormatter.format(product.price)}
                </p>
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/** API 상품이 같은 id/slug를 발행하면 정적 데모 데이터보다 최신 관리 데이터를 우선합니다. */
function mergeCatalogProducts(
  staticProducts: readonly Product[],
  remoteProducts: readonly Product[] | null,
) {
  if (!remoteProducts?.length) {
    return staticProducts;
  }

  const remoteById = new Map(remoteProducts.map((product) => [product.id, product]));
  const remoteBySlug = new Map(
    remoteProducts.map((product) => [product.slug, product]),
  );
  const mergedProducts = staticProducts.map(
    (product) =>
      remoteById.get(product.id) ?? remoteBySlug.get(product.slug) ?? product,
  );
  const knownIds = new Set(mergedProducts.map((product) => product.id));

  return [
    ...mergedProducts,
    ...remoteProducts.filter((product) => !knownIds.has(product.id)),
  ];
}

function isProductSoldOut(product: Product) {
  return (
    typeof product.inventoryQuantity === "number" && product.inventoryQuantity <= 0
  );
}

function isExternalImage(image: string) {
  return image.startsWith("https://");
}
