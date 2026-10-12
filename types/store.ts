// 역할: 카탈로그, 장바구니, 메뉴, 로케일 컴포넌트에서 공유하는 엄격한 도메인 타입을 정의합니다.

/** UI·스토리지에서 쓰는 지원 언어 */
export type Locale = "en" | "ko";

/** 카탈로그 상품 (홈 카드·상세·장바구니 라인의 공통 필드) */
export type Product = {
  id: string;
  slug: string;
  name: string;
  /** 로케일별 상품명 (등록 시 자동 번역으로 채움) */
  nameI18n?: { en?: string; ko?: string };
  category: string;
  /** 메뉴 Brand 필터용 */
  brand: string;
  price: number;
  compareAtPrice?: number;
  /** 대표 이미지 (그리드·장바구니 썸네일) */
  image: string;
  /** 상세 갤러리. 없으면 [image] 한 장으로 표시 */
  images?: string[];
  description: string[];
  /** 로케일별 스펙 줄 */
  descriptionI18n?: { en?: string[]; ko?: string[] };
  sizes: string[];
  /** 발행 상품 재고. 0 이하면 스토어에서 soldout 처리 */
  inventoryQuantity?: number;
  /** 신상품(New) 배지 */
  featured?: boolean;
};

/** 장바구니에 담긴 한 줄 (상품·선택 옵션·수량). 결제 요청은 이 식별자 대신 productId+selectedSize만 전송합니다. */
export type CartLine = Product & {
  lineId: string;
  selectedSize: string;
  quantity: number;
};

/** 리듀서가 다루는 장바구니 전체 상태 */
export type CartState = {
  items: CartLine[];
};

/** cartReducer가 받는 액션 유니온 */
export type CartAction =
  | { type: "hydrate"; payload: CartState }
  | {
      type: "add";
      product: Product;
      selectedSize: string;
      quantity: number;
    }
  | { type: "remove"; lineId: string }
  | { type: "setQuantity"; lineId: string; quantity: number }
  | { type: "clear" };

/** 메뉴 단일 항목 (en/ko 라벨) */
export type NavigationItem = {
  id: string;
  label: Record<Locale, string>;
};

/** 하위 items를 가진 메뉴 그룹 */
export type NavigationGroup = NavigationItem & {
  items: NavigationItem[];
};
