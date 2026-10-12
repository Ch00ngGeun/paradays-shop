// 역할: descriptionI18n.ko가 영문 복사본이어도 KO 사전으로 스펙이 번역되는지 검증합니다.
import { describe, expect, it } from "vitest";

import { getLocalizedProductDescription } from "@/lib/commerce/product-i18n";

describe("getLocalizedProductDescription", () => {
  it("falls back to KO dictionary when descriptionI18n.ko is an English copy", () => {
    const lines = [
      "7-Ply Canadian Maple",
      "Medium Concave",
      "8.375 inch Width",
      "Brian O'Dwyer Pro Model",
    ] as const;

    const result = getLocalizedProductDescription(
      {
        description: lines,
        descriptionI18n: { en: [...lines], ko: [...lines] },
      },
      "ko",
    );

    expect(result).toEqual([
      "캐나다산 7겹 메이플",
      "미디엄 컨케이브",
      "8.375인치 너비",
      "Brian O'Dwyer 프로 모델",
    ]);
  });

  it("keeps already-translated KO lines unchanged", () => {
    const result = getLocalizedProductDescription(
      {
        description: ["7-Ply Canadian Maple"],
        descriptionI18n: {
          en: ["7-Ply Canadian Maple"],
          ko: ["캐나다산 7겹 메이플"],
        },
      },
      "ko",
    );

    expect(result).toEqual(["캐나다산 7겹 메이플"]);
  });
});
