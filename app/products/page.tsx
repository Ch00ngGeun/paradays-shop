// 역할: 관리자에서 새로 발행한 상품을 정적 export에서도 query-based 상세 경로로 표시합니다.
import { Suspense } from "react";

import { PublicProductLookupFromSearchParams } from "@/components/public-product-lookup";

/** `/products?slug=...`: 공개 catalog API를 사용하는 정적 상세 fallback입니다. */
export default function ProductLookupPage() {
  return (
    <Suspense fallback={<p>상품 정보를 불러오는 중입니다.</p>}>
      <PublicProductLookupFromSearchParams />
    </Suspense>
  );
}
