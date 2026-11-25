// 역할: 상품명 번역의 줄 단위 번역·줄 수 유지·빈 줄 처리를 모의 번역 서비스로 검증함.
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildProductI18nFields } from "@/lib/commerce/translate-text";

/** MyMemory 대역: 질의마다 표시를 붙인 사본으로 답하고 요청 내용을 기록함. */
function stubTranslator() {
  const queries: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const query = new URL(input).searchParams.get("q") ?? "";
      queries.push(query);
      return new Response(
        JSON.stringify({ responseData: { translatedText: `EN(${query})` } }),
        { status: 200 },
      );
    }),
  );
  return queries;
}

afterEach(() => vi.unstubAllGlobals());

describe("product name translation", () => {
  it("translates a two-line name line by line and keeps the line count", async () => {
    const queries = stubTranslator();

    const fields = await buildProductI18nFields({
      name: "합성 데크\n8.25 인치",
      descriptionLines: [],
      sourceLocale: "ko",
    });

    expect(queries).toEqual(["합성 데크", "8.25 인치"]);
    expect(fields.nameI18n).toEqual({
      ko: "합성 데크\n8.25 인치",
      en: "EN(합성 데크)\nEN(8.25 인치)",
    });
    expect(fields.name).toBe("EN(합성 데크)\nEN(8.25 인치)");
  });

  it("drops blank lines and outer spaces so both languages have the same lines", async () => {
    const queries = stubTranslator();

    const fields = await buildProductI18nFields({
      name: "  합성 데크  \r\n\n   \n 8.25 인치 \n",
      descriptionLines: [],
      sourceLocale: "ko",
    });

    expect(queries).toEqual(["합성 데크", "8.25 인치"]);
    expect(fields.nameI18n.ko.split("\n")).toHaveLength(2);
    expect(fields.nameI18n.en.split("\n")).toHaveLength(2);
    expect(fields.nameI18n.ko).toBe("합성 데크\n8.25 인치");
  });

  it("keeps a one-line name on the previous single request", async () => {
    const queries = stubTranslator();

    const fields = await buildProductI18nFields({
      name: "  합성 데크 8.25  ",
      descriptionLines: [],
      sourceLocale: "ko",
    });

    expect(queries).toEqual(["합성 데크 8.25"]);
    expect(fields.nameI18n).toEqual({ ko: "합성 데크 8.25", en: "EN(합성 데크 8.25)" });
  });

  it("still refuses a name made only of blank lines", async () => {
    stubTranslator();

    await expect(
      buildProductI18nFields({
        name: " \n \n",
        descriptionLines: [],
        sourceLocale: "ko",
      }),
    ).rejects.toMatchObject({ code: "TRANSLATE_EMPTY" });
  });
});
