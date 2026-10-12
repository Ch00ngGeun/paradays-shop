/**
 * 역할: 결제 서버가 가격·옵션을 다시 계산할 때 사용하는 최소 상품 카탈로그를 정의함.
 * 기능: 브라우저 요청의 가격을 신뢰하지 않고, 판매 가능한 상품 ID·사이즈·원화 가격만 제공함.
 */

/** 결제 가격 검증에 필요한 상품의 불변 속성입니다. */
export type ServerCatalogProduct = Readonly<{
  id: string;
  name: string;
  price: number;
  sizes: readonly string[];
}>;

/** 데모 스토어의 서버 기준 카탈로그입니다. 운영 전 CMS·재고 서비스로 교체해야 합니다. */
export const serverCatalog: readonly ServerCatalogProduct[] = [
  {
    id: "odwyer-sync-deck",
    name: "O'Dwyer 'Sync 1' [8.375”]",
    price: 108000,
    sizes: ["8.25”", "8.375”", "8.5”"],
  },
  {
    id: "plaid-overshirt",
    name: "Plaid Overshirt [Charcoal]",
    price: 168000,
    sizes: ["S", "M", "L", "XL"],
  },
  {
    id: "triangle-sweater",
    name: "Triangle Knit Sweater [Blue/Brown]",
    price: 158000,
    sizes: ["S", "M", "L", "XL"],
  },
  {
    id: "dekeyzer-deck",
    name: "De Keyzer Deck [8.25”]",
    price: 108000,
    sizes: ["8.0”", "8.25”", "8.5”"],
  },
  {
    id: "imagine-hat",
    name: "Imagine Thinking Hat [Black]",
    price: 70000,
    sizes: ["One Size"],
  },
  {
    id: "clay-wheels",
    name: "Proto Clay Wheels [56mm / 82A]",
    price: 65000,
    sizes: ["56mm"],
  },
  {
    id: "rizzo-deck",
    name: "Rizzo Deck [8.25”]",
    price: 108000,
    sizes: ["8.0”", "8.25”", "8.5”"],
  },
  {
    id: "odwyer-deck-8-5",
    name: "O'Dwyer Deck [8.5”]",
    price: 108000,
    sizes: ["8.25”", "8.5”", "8.75”"],
  },
];
