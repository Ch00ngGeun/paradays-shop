// 역할: 카드에서 전달된 고정 카탈로그 슬러그를 검증하고 동일한 상품상세 화면을 렌더링합니다.
import { notFound } from "next/navigation";

import { PublicProductLookup } from "@/components/public-product-lookup";
import { getProductBySlug, products } from "@/data/products";

/** 정적 export용: 카탈로그에 있는 slug만 미리 빌드합니다. */
export function generateStaticParams() {
  return products.map((product) => ({ slug: product.slug }));
}

/**
 * `/products/[slug]` 상세 라우트.
 * 알 수 없는 slug는 notFound로 처리해 임의 페이지 생성을 막습니다.
 */
export default async function ProductPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const product = getProductBySlug(slug);

  // 지정하지 않은 경로는 새 페이지를 만들지 않고 Next 기본 not-found 처리로 제한합니다.
  if (!product) {
    notFound();
  }

  return <PublicProductLookup slug={product.slug} />;
}
