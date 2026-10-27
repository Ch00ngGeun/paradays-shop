// 역할: 현지화된 샵 메뉴 라벨과 서브메뉴 관계를 한곳에 모읍니다.
import type { NavigationGroup, NavigationItem } from "@/types/store";

/** 데스크톱 드롭다운·모바일 동일 스타일 메뉴에 쓰는 그룹형 상위 메뉴 */
export const menuGroups: NavigationGroup[] = [
  {
    id: "clothes",
    label: { en: "Clothes", ko: "의류" },
    items: [
      { id: "clothes-all", label: { en: "All", ko: "전체" } },
      { id: "top", label: { en: "Top", ko: "상의" } },
      { id: "bottoms", label: { en: "Bottoms", ko: "하의" } },
      { id: "shoes", label: { en: "Shoes", ko: "신발" } },
      { id: "accessories", label: { en: "Accessories", ko: "액세서리" } },
      { id: "clothes-acc", label: { en: "Acc", ko: "Acc" } },
    ],
  },
  {
    id: "skateboard",
    label: { en: "SkateBoard", ko: "스케이트보드" },
    items: [
      { id: "skateboard-all", label: { en: "All", ko: "전체" } },
      { id: "deck", label: { en: "Deck", ko: "데크" } },
      { id: "wheels", label: { en: "Wheels", ko: "휠" } },
      { id: "truck", label: { en: "Truck", ko: "트럭" } },
      { id: "skate-acc", label: { en: "Acc", ko: "Acc" } },
    ],
  },
  {
    // Brand도 Clothes처럼 메뉴 열리면 하위가 바로 보입니다.
    id: "brand",
    label: { en: "Brand", ko: "브랜드" },
    items: [
      { id: "brand-all", label: { en: "All", ko: "전체" } },
      { id: "brand-april", label: { en: "April", ko: "April" } },
      { id: "brand-avenir", label: { en: "Avenir", ko: "Avenir" } },
      { id: "brand-butter", label: { en: "Butter", ko: "Butter" } },
      { id: "brand-cashonly", label: { en: "Cash Only", ko: "Cash Only" } },
      { id: "brand-dc", label: { en: "DC", ko: "DC" } },
      { id: "brand-deathwish", label: { en: "Deathwish", ko: "Deathwish" } },
      { id: "brand-dgk", label: { en: "DGK", ko: "DGK" } },
      { id: "brand-dime", label: { en: "Dime", ko: "Dime" } },
      {
        id: "brand-fuckingawesome",
        label: { en: "Fucking Awesome", ko: "Fucking Awesome" },
      },
      { id: "brand-heaps", label: { en: "Heaps", ko: "Heaps" } },
      { id: "brand-k88", label: { en: "K88", ko: "K88" } },
      { id: "brand-paradays", label: { en: "PARADAYS", ko: "PARADAYS" } },
      { id: "brand-polar", label: { en: "Polar", ko: "Polar" } },
      { id: "brand-primitive", label: { en: "Primitive", ko: "Primitive" } },
      { id: "brand-spitfire", label: { en: "Spitfire", ko: "Spitfire" } },
    ],
  },
];

/**
 * Clothes 왼쪽의 전체 보기(All) — 하위 없이 상위 라벨만.
 */
export const menuRootAll: NavigationItem = {
  id: "all",
  label: { en: "All", ko: "전체" },
};

/**
 * 상위 메뉴이지만 하위가 없는 항목 (SALE).
 * hover는 Top/Bottoms와 같고, 이후 클릭 시 세일 상품 필터에 연결합니다.
 */
export const menuLeafTops: NavigationItem[] = [
  { id: "sale", label: { en: "SALE", ko: "SALE" } },
];
