// 역할: 상품명·설명을 현재 로케일에 맞게 고름 (i18n 필드 우선, 없으면 원문).

import { translateProductDescription } from "@/contexts/locale-context";
import type { Locale } from "@/types/store";

export type ProductNameI18n = Readonly<{ en?: string; ko?: string }>;
export type ProductDescriptionI18n = Readonly<{
  en?: readonly string[];
  ko?: readonly string[];
}>;

export type LocalizableProduct = Readonly<{
  name: string;
  description: readonly string[];
  nameI18n?: ProductNameI18n;
  descriptionI18n?: ProductDescriptionI18n;
}>;

export function getLocalizedProductName(
  product: Pick<LocalizableProduct, "name" | "nameI18n">,
  locale: Locale,
) {
  const localized = product.nameI18n?.[locale]?.trim();

  return localized || product.name;
}

export function getLocalizedProductDescription(
  product: Pick<LocalizableProduct, "description" | "descriptionI18n">,
  locale: Locale,
) {
  const localized = product.descriptionI18n?.[locale];
  const lines =
    localized && localized.length > 0 ? localized : product.description;

  // i18n.ko가 영문 복사본인 시드/레거시 데이터도 KO 사전으로 한 번 더 변환.
  // 이미 한글인 줄은 사전에 없어 원문 그대로 유지됨.
  return lines.map((line) => translateProductDescription(locale, line));
}
