// 역할: 정적 export에 없는 새 발행 상품도 공개 catalog API로 상세 화면을 표시합니다.
"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { ProductDetail } from "@/components/product-detail";
import { getProductBySlug } from "@/data/products";
import { getPublishedCatalogProduct } from "@/lib/commerce/public-catalog-api-client";
import type { Product } from "@/types/store";

import styles from "./public-product-lookup.module.css";

/** 검색 파라미터에서 받은 slug 하나의 공개 상품 상세를 로드합니다. */
export function PublicProductLookup({ slug }: Readonly<{ slug: string | null }>) {
  if (!slug) {
    return <ProductUnavailable />;
  }

  return <ProductLookupContent key={slug} slug={slug} />;
}

/** URL query는 client-only로 읽어 static export 중 request 의존 서버 렌더링을 만들지 않습니다. */
export function PublicProductLookupFromSearchParams() {
  const searchParams = useSearchParams();

  return <PublicProductLookup slug={searchParams.get("slug")} />;
}

/** slug 변경 시 이전 API 결과를 보여주지 않도록 key로 새 상태를 시작합니다. */
function ProductLookupContent({ slug }: Readonly<{ slug: string }>) {
  const staticProduct = getProductBySlug(slug);
  const [remoteProduct, setRemoteProduct] = useState<Product | null>(null);
  const [loadComplete, setLoadComplete] = useState(false);
  const [hasLoadError, setHasLoadError] = useState(false);

  useEffect(() => {
    let isCurrent = true;

    void getPublishedCatalogProduct(slug)
      .then((product) => {
        if (!isCurrent) {
          return;
        }

        setRemoteProduct(product);
        setLoadComplete(true);
      })
      .catch(() => {
        if (isCurrent) {
          setHasLoadError(true);
          setLoadComplete(true);
        }
      });

    return () => {
      isCurrent = false;
    };
  }, [slug]);

  const product = remoteProduct ?? staticProduct;

  if (product) {
    return <ProductDetail product={product} />;
  }

  if (!loadComplete && !hasLoadError) {
    return <p className={styles.status}>상품 정보를 불러오는 중입니다.</p>;
  }

  return <ProductUnavailable />;
}

function ProductUnavailable() {
  return (
    <section className={styles.unavailable} aria-labelledby="product-unavailable-title">
      <p className={styles.eyebrow}>PARADAYS CATALOG</p>
      <h1 id="product-unavailable-title">상품을 찾을 수 없습니다.</h1>
      <p>상품이 아직 발행되지 않았거나 주소가 변경되었습니다.</p>
      <Link href="/">스토어로 돌아가기</Link>
    </section>
  );
}
