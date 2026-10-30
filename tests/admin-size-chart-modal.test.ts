import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  AdminSizeChartForm,
  getSizeChartSaveState,
  sizeChartKindChangeText,
  sizeChartRangeText,
} from "@/components/admin-size-chart-modal";

const values = {
  length: 72,
  shoulder: 50.5,
  chest: 56,
  sleeveLength: 22,
  hem: 55,
  sleeveWidth: 20.5,
  armhole: 24,
};
const inputs = Object.fromEntries(
  Object.entries(values).map(([k, v]) => [k, String(v)]),
);
const noop = async () => {};
const render = (props: Record<string, unknown>) =>
  renderToStaticMarkup(
    createElement(AdminSizeChartForm, {
      category: "Top",
      kind: "shortSleeve",
      onCancel: () => {},
      onSave: noop,
      onChangeKind: noop,
      ...props,
    }),
  );

/** The disabled drawing select is described by the note that explains it. */
function expectNoteFor(markup: string, note: string) {
  const describedBy = /<select aria-describedby="([^"]+)"/.exec(markup)?.[1];
  expect(describedBy).toBeTruthy();
  expect(markup).toContain(`id="${describedBy}">${note}</p>`);
}

describe("admin size chart modal", () => {
  it("saves values with blank fields as null, refuses a wrong field, and renames with every field empty", () => {
    expect(getSizeChartSaveState("shortSleeve", inputs).values).toEqual(values);
    expect(getSizeChartSaveState("shortSleeve", inputs).ready).toBe(true);
    // A blank field no longer blocks saving; it is saved as null.
    expect(
      getSizeChartSaveState("shortSleeve", { ...inputs, armhole: "" }),
    ).toMatchObject({
      values: { ...values, armhole: null },
      ready: true,
    });
    expect(
      getSizeChartSaveState("shortSleeve", { ...inputs, length: "300.1" }).ready,
    ).toBe(false);
    const option = { size: "M", otherOptions: ["S", "L"] };
    const empty = Object.fromEntries(Object.keys(values).map((key) => [key, ""]));
    // A rename with no values saves the name alone.
    const renamed = getSizeChartSaveState("shortSleeve", empty, {
      ...option,
      name: "XL",
    });
    expect(renamed).toMatchObject({ values: null, sizeName: "XL", ready: true });
    // The same name is not checked again and does not save on its own.
    expect(
      getSizeChartSaveState("shortSleeve", empty, { ...option, name: "M" }).ready,
    ).toBe(false);
    expect(
      getSizeChartSaveState("shortSleeve", inputs, { ...option, name: "S" }).ready,
    ).toBe(false);
  });

  it("names the range per unit and warns before a drawing switch", () => {
    expect(sizeChartRangeText("longPants", true)).toBe(
      "0 초과 300 이하의 cm로, 소수 1자리까지 입력해 주세요.",
    );
    expect(sizeChartRangeText("wheel", false)).toBe(
      "Enter mm above 0 and up to 100, with up to 1 decimal.",
    );
    expect(sizeChartKindChangeText("raglanLongSleeve", true)).toBe(
      "도면 종류를 '래글런 긴팔'(으)로 바꾸면 기본값과 옵션별로 입력한 상세사이즈가 모두 지워집니다.",
    );
    expect(sizeChartKindChangeText("shorts", false)).not.toMatch(/\p{Script=Hangul}/u);
  });

  it("a new default lists the category's drawings, the drawing's fields and no delete", () => {
    const markup = render({});
    // A switchable drawing has no note and is not disabled.
    expect(markup).toContain('<select name="sizeChartKind">');
    expect(markup).toContain('<option value="shortSleeve" selected="">반팔</option>');
    expect(markup).toContain('<option value="raglanLongSleeve">래글런 긴팔</option>');
    expect(markup.match(/<input/g)).toHaveLength(7);
    for (const name of [
      "총장",
      "어깨너비",
      "가슴단면",
      "소매길이",
      "밑단단면",
      "소매통",
      "암홀",
    ])
      expect(markup).toContain(`>${name}</span>`);
    expect(markup).toMatch(
      /<button[^>]*disabled=""[^>]*type="submit"[^>]*>저장<\/button>/,
    );
    expect(markup).not.toContain("삭제");
    expect(markup).toContain("7칸을 모두 입력하면 도면 미리보기가 나타납니다.");
  });

  it("an existing default shows inches beside cm, a live preview and a delete button", () => {
    const markup = render({ initialValues: values });
    expect(markup).toContain('value="72"');
    expect(markup).toContain("(28.3&quot;)</span>");
    expect(markup).toContain('role="img"');
    expect(markup).toContain("삭제");
    expect(markup).toContain("상세사이즈 입력 도움말");
  });

  it("an option keeps the product's drawing and offers its name", () => {
    const markup = render({ size: "M", otherOptions: ["S"] });
    expect(markup).toMatch(/<select[^>]*disabled=""[^>]*name="sizeChartKind"/);
    expectNoteFor(
      markup,
      "옵션은 상품의 도면 종류를 따릅니다. 종류는 기본값 화면에서 바꿀 수 있습니다.",
    );
    expect(markup).toContain('name="optionName"');
    expect(markup).toContain('value="M"');
    expect(markup).toContain("이 옵션은 지금 기본값을 표시합니다.");
  });

  it("a wheel has one drawing, mm fields without inches, and English names", () => {
    expectNoteFor(
      render({ category: "Wheels", kind: "wheel" }),
      "이 카테고리는 도면 종류가 하나뿐입니다.",
    );
    const markup = render({
      category: "Wheels",
      kind: "wheel",
      initialValues: { diameter: 54, width: 33.5, contactWidth: 20 },
      locale: "en",
    });
    expect(markup).toMatch(/<select[^>]*disabled=""[^>]*name="sizeChartKind"/);
    // The default screen says why there is nothing to switch to.
    expectNoteFor(markup, "This category has only one drawing.");
    expect(markup.match(/<input/g)).toHaveLength(3);
    expect(markup).toContain(">Diameter</span>");
    expect(markup).toContain('<span aria-hidden="true">mm</span>');
    expect(markup).not.toContain("&quot;)");
    expect(markup).not.toMatch(/\p{Script=Hangul}/u);
  });
});
