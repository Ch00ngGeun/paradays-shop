/**
 * 역할: public/images 기반 데모 상품을 paradays-dev-catalog에 PUBLISHED로 등록합니다.
 * 사용: node --experimental-strip-types scripts/seed-catalog-products.mts
 * wheels 재고 0, O'Dwyer featured=true.
 */

import { createHash } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

const TABLE_NAME = "paradays-dev-catalog";
const REGION = "ap-northeast-2";
const SEED_ACTOR = "seed_catalog_images";
const NOW = new Date().toISOString();

/** 스토어 `translateProductDescription` KO 사전과 동일 — 시드 ko 필드에 영문 복사를 넣지 않음 */
const descriptionKo: Readonly<Record<string, string>> = {
  "7-Ply Canadian Maple": "캐나다산 7겹 메이플",
  "Medium Concave": "미디엄 컨케이브",
  "8.25 inch Width": "8.25인치 너비",
  "8.375 inch Width": "8.375인치 너비",
  "8.5 inch Width": "8.5인치 너비",
  "Brian O'Dwyer Pro Model": "Brian O'Dwyer 프로 모델",
  "Heavy Flannel Weave": "헤비 플란넬 조직",
  "Dual Chest Pockets": "더블 체스트 포켓",
  "Button Front Closure": "버튼 프론트 여밈",
  "Relaxed Boxy Fit": "릴랙스드 박시 핏",
  "All-Over Triangle Knit": "올오버 트라이앵글 니트",
  "Ribbed Collar, Cuffs & Hem": "골지 카라·커프스·밑단",
  "Crewneck Fit": "크루넥 핏",
  "100% Cotton": "면 100%",
  "6-Panel Crown": "6패널 크라운",
  "Embroidered Front Mark": "전면 자수 마크",
  "Adjustable Back Strap": "길이 조절 백 스트랩",
  "One Size": "원사이즈",
  "56mm Diameter": "56mm 직경",
  "82A Durometer": "82A 경도",
  "Conical Shape": "코니컬 쉐입",
  "Set of 4": "4개 세트",
};

function toKoDescription(lines: readonly string[]) {
  return lines.map((line) => descriptionKo[line] ?? line);
}

type SeedProduct = Readonly<{
  productId: string;
  slug: string;
  name: string;
  brandName: string;
  category: string;
  price: number;
  compareAtPrice?: number;
  image: string;
  images?: readonly string[];
  description: readonly string[];
  sizes: readonly string[];
  inventoryQuantity: number;
  featured: boolean;
}>;

const products: readonly SeedProduct[] = [
  {
    productId: "prd_odwyer_sync_deck",
    slug: "odwyer-sync-1-8-375",
    name: "O'Dwyer 'Sync 1' [8.375”]",
    brandName: "April",
    category: "Deck",
    price: 108000,
    image: "/images/odwyer-deck-8-375.webp",
    description: [
      "7-Ply Canadian Maple",
      "Medium Concave",
      "8.375 inch Width",
      "Brian O'Dwyer Pro Model",
    ],
    sizes: ["8.25”", "8.375”", "8.5”"],
    inventoryQuantity: 12,
    featured: true,
  },
  {
    productId: "prd_plaid_overshirt",
    slug: "plaid-overshirt-charcoal",
    name: "Plaid Overshirt [Charcoal]",
    brandName: "Butter",
    category: "Top",
    price: 168000,
    image: "/images/plaid-shirt.jpg",
    images: ["/images/plaid-shirt.jpg", "/images/triangle-sweater.webp"],
    description: [
      "Heavy Flannel Weave",
      "Dual Chest Pockets",
      "Button Front Closure",
      "Relaxed Boxy Fit",
    ],
    sizes: ["S", "M", "L", "XL"],
    inventoryQuantity: 8,
    featured: false,
  },
  {
    productId: "prd_triangle_sweater",
    slug: "triangle-knit-sweater",
    name: "Triangle Knit Sweater [Blue/Brown]",
    brandName: "PARADAYS",
    category: "Top",
    price: 158000,
    compareAtPrice: 198000,
    image: "/images/triangle-sweater.webp",
    description: [
      "All-Over Triangle Knit",
      "Ribbed Collar, Cuffs & Hem",
      "Crewneck Fit",
      "100% Cotton",
    ],
    sizes: ["S", "M", "L", "XL"],
    inventoryQuantity: 6,
    featured: false,
  },
  {
    productId: "prd_dekeyzer_deck",
    slug: "dekeyzer-deck-8-25",
    name: "De Keyzer Deck [8.25”]",
    brandName: "Butter",
    category: "Deck",
    price: 108000,
    image: "/images/dekeyzer-deck.webp",
    description: ["7-Ply Canadian Maple", "Medium Concave", "8.25 inch Width"],
    sizes: ["8.0”", "8.25”", "8.5”"],
    inventoryQuantity: 10,
    featured: false,
  },
  {
    productId: "prd_imagine_hat",
    slug: "imagine-thinking-hat-black",
    name: "Imagine Thinking Hat [Black]",
    brandName: "Fucking Awesome",
    category: "Accessories",
    price: 70000,
    image: "/images/imagine-hat-black.jpg",
    description: [
      "6-Panel Crown",
      "Embroidered Front Mark",
      "Adjustable Back Strap",
      "One Size",
    ],
    sizes: ["One Size"],
    inventoryQuantity: 15,
    featured: false,
  },
  {
    productId: "prd_clay_wheels",
    slug: "proto-clay-wheels-56mm",
    name: "Proto Clay Wheels [56mm / 82A]",
    brandName: "Spitfire",
    category: "Wheels",
    price: 65000,
    image: "/images/clay-wheels.webp",
    description: ["56mm Diameter", "82A Durometer", "Conical Shape", "Set of 4"],
    sizes: ["56mm"],
    inventoryQuantity: 0,
    featured: false,
  },
  {
    productId: "prd_rizzo_deck",
    slug: "rizzo-deck-8-25",
    name: "Rizzo Deck [8.25”]",
    brandName: "Polar",
    category: "Deck",
    price: 108000,
    image: "/images/rizzo-deck.webp",
    description: ["7-Ply Canadian Maple", "Medium Concave", "8.25 inch Width"],
    sizes: ["8.0”", "8.25”", "8.5”"],
    inventoryQuantity: 9,
    featured: false,
  },
  {
    productId: "prd_odwyer_deck_8_5",
    slug: "odwyer-deck-8-5",
    name: "O'Dwyer Deck [8.5”]",
    brandName: "Deathwish",
    category: "Deck",
    price: 108000,
    image: "/images/odwyer-deck-8-5.webp",
    description: [
      "7-Ply Canadian Maple",
      "Medium Concave",
      "8.5 inch Width",
      "Brian O'Dwyer Pro Model",
    ],
    sizes: ["8.25”", "8.5”", "8.75”"],
    inventoryQuantity: 11,
    featured: true,
  },
];

function brandIdFor(brandName: string) {
  return `brand_${Buffer.from(brandName).toString("base64url").slice(0, 80)}`;
}

function stableSku(slug: string) {
  return `SKU-${createHash("sha1").update(slug).digest("hex").slice(0, 8).toUpperCase()}`;
}

async function main() {
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }), {
    marshallOptions: { removeUndefinedValues: true },
  });

  for (const product of products) {
    const images = product.images?.length ? [...product.images] : [product.image];
    const item = {
      productId: product.productId,
      slug: product.slug,
      name: product.name,
      nameI18n: { en: product.name, ko: product.name },
      sku: stableSku(product.slug),
      brandId: brandIdFor(product.brandName),
      brandName: product.brandName,
      category: product.category,
      price: product.price,
      ...(product.compareAtPrice ? { compareAtPrice: product.compareAtPrice } : {}),
      currency: "KRW",
      status: "PUBLISHED",
      publicationStatus: "PUBLISHED",
      inventoryQuantity: product.inventoryQuantity,
      featured: product.featured,
      image: product.image,
      images,
      description: [...product.description],
      descriptionI18n: {
        en: [...product.description],
        ko: toKoDescription(product.description),
      },
      sizes: [...product.sizes],
      version: 1,
      createdAt: NOW,
      updatedAt: NOW,
      createdBy: SEED_ACTOR,
      updatedBy: SEED_ACTOR,
    };

    await client.send(
      new PutCommand({
        TableName: TABLE_NAME,
        Item: item,
      }),
    );

    console.log(
      `OK ${product.productId} stock=${product.inventoryQuantity} featured=${product.featured}`,
    );
  }

  console.log(`Seeded ${products.length} products into ${TABLE_NAME}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
