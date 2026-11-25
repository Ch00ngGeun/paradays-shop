// 역할: 사이즈표 종류별 측정 필드·단위·범주별 기본값과 측정값 범위·null 저장 규칙을 검증함.
import { describe, expect, it } from "vitest";

import {
  SIZE_CHART_KIND_INFO,
  SIZE_CHART_KINDS,
  defaultSizeChartKind,
  formatSizeChartValue,
  isSizeChartKind,
  isSizeChartValues,
  parseSizeChartInputs,
  parseSizeChartValue,
  sizeChartKindsFor,
} from "@/lib/size-chart";

const names = (kind: (typeof SIZE_CHART_KINDS)[number]) =>
  SIZE_CHART_KIND_INFO[kind].fields.map((field) => field.label.ko);

describe("size chart kinds and fields", () => {
  it("names each drawing's measurements in drawing order", () => {
    expect(names("shortSleeve")).toEqual([
      "총장",
      "어깨너비",
      "가슴단면",
      "소매길이",
      "밑단단면",
      "소매통",
      "암홀",
    ]);
    expect(names("raglanLongSleeve")).toEqual([
      "총장",
      "가슴단면",
      "소매부리",
      "화장",
      "밑단단면",
      "암홀",
    ]);
    const pants = ["총장", "허리단면", "엉덩이단면", "허벅지단면", "밑위", "밑단단면"];
    expect(names("longPants")).toEqual(pants);
    expect(names("shorts")).toEqual(pants);
    expect(names("wheel")).toEqual(["지름", "W 전체 폭", "T 바닥 닿는 폭"]);
  });

  it("uses cm for clothes and mm for wheels, with unique keys and English names", () => {
    for (const kind of SIZE_CHART_KINDS) {
      const { unit, fields, label } = SIZE_CHART_KIND_INFO[kind];
      expect(unit).toBe(kind === "wheel" ? "mm" : "cm");
      const keys = fields.map((field) => field.key);
      expect(new Set(keys).size).toBe(keys.length);
      for (const text of [label.en, ...fields.map((field) => field.label.en)])
        expect(text, kind).not.toMatch(/\p{Script=Hangul}/u);
    }
  });

  it("offers kinds per category with the first one as the default", () => {
    expect(sizeChartKindsFor("Top")).toEqual(["shortSleeve", "raglanLongSleeve"]);
    expect(sizeChartKindsFor("Outerwear")).toEqual(["raglanLongSleeve", "shortSleeve"]);
    expect(sizeChartKindsFor("Bottom")).toEqual(["longPants", "shorts"]);
    expect(sizeChartKindsFor("Wheels")).toEqual(["wheel"]);
    expect(defaultSizeChartKind("Top")).toBe("shortSleeve");
    expect(defaultSizeChartKind("Outerwear")).toBe("raglanLongSleeve");
    expect(defaultSizeChartKind("Bottom")).toBe("longPants");
    expect(defaultSizeChartKind("Wheels")).toBe("wheel");
    // 데크는 자기 deckSpec을 유지하고, 모르는 이름과 상속된 이름은 아무것도 받지 않음.
    for (const category of ["Deck", "Bottoms", "toString", "__proto__"]) {
      expect(sizeChartKindsFor(category)).toEqual([]);
      expect(defaultSizeChartKind(category)).toBeNull();
    }
    expect(isSizeChartKind("wheel")).toBe(true);
    expect(isSizeChartKind("deck")).toBe(false);
  });
});

describe("size chart values", () => {
  it("accepts more than 0 up to 300cm or 100mm with one decimal place", () => {
    expect(parseSizeChartValue("shortSleeve", " 72.5 ")).toBe(72.5);
    expect(parseSizeChartValue("shortSleeve", "300")).toBe(300);
    expect(parseSizeChartValue("shortSleeve", "0.1")).toBe(0.1);
    expect(parseSizeChartValue("wheel", "100")).toBe(100);
    for (const value of [
      "",
      "0",
      "0.0",
      "300.1",
      "1.25",
      "-1",
      "1e2",
      "1,000",
      ".5",
      "5.",
    ])
      expect(parseSizeChartValue("shortSleeve", value), value).toBeNull();
    expect(parseSizeChartValue("wheel", "100.1")).toBeNull();
  });

  it("builds values with blank fields as null, refusing any invalid field or no number at all", () => {
    expect(
      parseSizeChartInputs("wheel", {
        diameter: "54",
        width: "33.5",
        contactWidth: "20",
      }),
    ).toEqual({ diameter: 54, width: 33.5, contactWidth: 20 });
    // 비었거나 없는 필드는 null로 저장되며 도면의 모든 키를 유지함.
    expect(parseSizeChartInputs("wheel", { diameter: "54", width: " " })).toEqual({
      diameter: 54,
      width: null,
      contactWidth: null,
    });
    // 잘못된 필드가 하나라도 있으면 전체 저장을 막음.
    expect(
      parseSizeChartInputs("wheel", {
        diameter: "54",
        width: "33.5",
        contactWidth: "101",
      }),
    ).toBeNull();
    expect(
      parseSizeChartInputs("wheel", { diameter: "", width: "abc", contactWidth: "" }),
    ).toBeNull();
    // 숫자가 하나도 없으면 값으로 저장할 것이 없으므로 대신 삭제가 됨.
    expect(
      parseSizeChartInputs("wheel", { diameter: "", width: "", contactWidth: "" }),
    ).toBeNull();
  });

  it("checks stored values for exactly the kind's fields within range", () => {
    const wheel = { diameter: 54, width: 33.5, contactWidth: 20 };
    expect(isSizeChartValues("wheel", wheel)).toBe(true);
    // 숫자가 하나라도 남아 있으면 빈 필드는 null임.
    expect(
      isSizeChartValues("wheel", { ...wheel, width: null, contactWidth: null }),
    ).toBe(true);
    for (const bad of [
      null,
      [],
      { diameter: null, width: null, contactWidth: null },
      { ...wheel, width: undefined },
      { diameter: 54, width: 33.5 },
      { ...wheel, extra: 1 },
      { ...wheel, width: "33.5" },
      { ...wheel, width: 33.55 },
      { ...wheel, width: 0 },
      { ...wheel, width: 101 },
      { ...wheel, width: Number.NaN },
      Object.assign(Object.create({ contactWidth: 20 }), { diameter: 54, width: 33.5 }),
      JSON.parse('{"diameter":54,"width":33.5,"__proto__":{"contactWidth":20}}'),
    ])
      expect(isSizeChartValues("wheel", bad), JSON.stringify(bad)).toBe(false);
    // 같은 숫자라도 필드가 다른 종류에는 유효하지 않음.
    expect(isSizeChartValues("shorts", wheel)).toBe(false);
  });

  it("shows inches in brackets for cm and mm alone for wheels", () => {
    expect(formatSizeChartValue("shortSleeve", 72)).toBe('72cm (28.3")');
    expect(formatSizeChartValue("longPants", 2.5)).toBe('2.5cm (1.0")');
    expect(formatSizeChartValue("wheel", 54)).toBe("54mm");
  });

  it("shows a blank field as null alone, without a unit or inches", () => {
    expect(formatSizeChartValue("shortSleeve", null)).toBe("null");
    expect(formatSizeChartValue("wheel", null)).toBe("null");
  });
});
