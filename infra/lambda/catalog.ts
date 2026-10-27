/**
 * 역할: 결제 서버가 가격·옵션을 다시 계산할 때 쓰는 상품 카탈로그 항목의 타입을 정의함.
 * 기능: 브라우저 요청의 가격을 신뢰하지 않고, 판매 가능한 상품 ID·사이즈·원화 가격만 다룸.
 */

/** 결제 가격 검증에 필요한 상품의 불변 속성입니다. */
export type ServerCatalogProduct = Readonly<{
  id: string;
  name: string;
  price: number;
  sizes: readonly string[];
}>;
