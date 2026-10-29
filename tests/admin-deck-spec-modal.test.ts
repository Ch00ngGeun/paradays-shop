import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  AdminDeckSpecEditor,
  AdminDeckSpecForm,
  getDeckSpecSaveState,
  optionNameError,
  parseDeckInches,
  parseDeckSpecInputs,
} from "@/components/admin-deck-spec-modal";

const spec = { nose: 6.875, tail: 6.5, width: 8.5, length: 31.75, wheelbase: 14.25 };
const noop = async () => {};

describe("admin deck spec modal", () => {
  it("accepts only positive inches up to 100", () => {
    expect(parseDeckInches(" 6.875 ")).toBe(6.875);
    expect(parseDeckInches("100")).toBe(100);
    for (const invalid of [
      "",
      "0",
      "-1",
      "100.5",
      "6,875",
      "1e2",
      '8.5"',
      "abc",
      "0.00001",
      "1e-7",
    ]) {
      expect(parseDeckInches(invalid)).toBeNull();
    }
  });

  it("every accepted value reopens as the same valid input", () => {
    for (const input of ["0.0001", "0.0625", "6.875", "8", "31.75", "99.9999", "100"]) {
      const inches = parseDeckInches(input);
      expect(inches).not.toBeNull();
      expect(parseDeckInches(String(inches))).toBe(inches);
    }
  });

  it("builds a spec only when all five fields are valid", () => {
    const inputs = {
      nose: "6.875",
      tail: "6.5",
      width: "8.5",
      length: "31.75",
      wheelbase: "14.25",
    };
    expect(parseDeckSpecInputs(inputs)).toEqual(spec);
    expect(parseDeckSpecInputs({ ...inputs, tail: "" })).toBeNull();
    expect(parseDeckSpecInputs({ ...inputs, width: "0" })).toBeNull();
  });

  it("a new spec starts empty with save disabled and no delete button", () => {
    const markup = renderToStaticMarkup(
      createElement(AdminDeckSpecForm, { onCancel: () => {}, onSave: noop }),
    );

    expect(markup.match(/<input/g)).toHaveLength(5);
    expect(markup).toMatch(
      /<button[^>]*disabled=""[^>]*type="submit"[^>]*>저장<\/button>/,
    );
    expect(markup).not.toContain("삭제");
    expect(markup).not.toContain("<svg");
  });

  it("an existing spec is prefilled with live cm, a preview, and a delete button", () => {
    const markup = renderToStaticMarkup(
      createElement(AdminDeckSpecForm, {
        initialSpec: spec,
        onCancel: () => {},
        onSave: noop,
      }),
    );

    expect(markup).toContain('value="6.875"');
    expect(markup).toContain("(17.5cm)");
    expect(markup).toContain("<svg");
    expect(markup).toContain("삭제");
    expect(markup).toMatch(/<button[^>]*type="submit"[^>]*>저장<\/button>/);
    expect(markup).not.toMatch(/<button[^>]*disabled=""[^>]*type="submit"/);
  });

  it("renders the form in English without Korean when the admin uses English", () => {
    const empty = renderToStaticMarkup(
      createElement(AdminDeckSpecForm, {
        locale: "en",
        onCancel: () => {},
        onSave: noop,
      }),
    );
    const filled = renderToStaticMarkup(
      createElement(AdminDeckSpecForm, {
        initialSpec: spec,
        locale: "en",
        onCancel: () => {},
        onSave: noop,
      }),
    );

    expect(empty + filled).not.toMatch(/[가-힣]/u);
    expect(empty).toContain("Fill in all 5 fields to see the diagram preview.");
    expect(filled).toMatch(/<button[^>]*type="submit"[^>]*>Save<\/button>/);
    expect(filled).toContain(">Delete</button>");
    expect(filled).toContain(">Cancel</button>");
  });

  const optionSpec = { ...spec, width: 8.25, wheelbase: 14 };
  const editor = (props: Partial<Parameters<typeof AdminDeckSpecEditor>[0]> = {}) =>
    renderToStaticMarkup(
      createElement(AdminDeckSpecEditor, {
        onCancel: () => {},
        onSave: noop,
        ...props,
      }),
    );

  it("without size options the editor renders exactly the plain form", () => {
    const plain = renderToStaticMarkup(
      createElement(AdminDeckSpecForm, {
        initialSpec: spec,
        onCancel: () => {},
        onSave: noop,
      }),
    );

    expect(editor({ initialSpec: spec })).toBe(plain);
    expect(editor({ initialSpec: spec, sizeOptions: [] })).toBe(plain);
    expect(plain).not.toContain("<select");
  });

  it("offers the default first, then each saved option marked when it has values", () => {
    const markup = editor({
      initialSpec: spec,
      initialSpecsBySize: { "8.25": optionSpec },
      sizeOptions: ["8.25", "8.5", "8.25", "__proto__", "constructor", "prototype"],
    });

    const options = [
      ...markup.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)<\/option>/g),
    ];
    expect(options.map(([, value, label]) => [value, label])).toEqual([
      ["", "기본 (모든 옵션 공통) · 등록됨"],
      ["8.25", "8.25 · 등록됨"],
      ["8.5", "8.5"],
    ]);
    expect(markup).toContain("적용 대상");
    expect(markup).toContain(
      "옵션을 고르지 않고 저장하면 모든 옵션 공통 기본값에 저장됩니다.",
    );
    // The default target is selected and its values fill the form.
    expect(markup).toMatch(/<option value=""[^>]*selected=""/);
    expect(markup).toContain('value="14.25"');
    expect(markup).toContain(">삭제</button>");
  });

  it("an option target shows its own values, or empty inputs with a default notice", () => {
    const own = renderToStaticMarkup(
      createElement(AdminDeckSpecForm, {
        initialSpec: optionSpec,
        onCancel: () => {},
        onSave: noop,
        size: "8.25",
      }),
    );
    const missing = renderToStaticMarkup(
      createElement(AdminDeckSpecForm, {
        onCancel: () => {},
        onSave: noop,
        size: "8.5",
      }),
    );

    expect(own).toContain('value="14"');
    expect(own).toContain(">삭제</button>");
    expect(own).not.toContain("이 옵션은 지금 기본값을 표시합니다.");
    expect(missing).not.toContain('value="6.875"');
    expect(missing).not.toContain("삭제");
    expect(missing).toContain(
      "이 옵션은 지금 기본값을 표시합니다. 저장하면 이 옵션에만 적용됩니다.",
    );
  });

  it("renders the option picker and notices in English without Korean", () => {
    const markup =
      editor({
        locale: "en",
        initialSpec: spec,
        initialSpecsBySize: { "8.25": optionSpec },
        sizeOptions: ["8.25", "8.5"],
      }) +
      renderToStaticMarkup(
        createElement(AdminDeckSpecForm, {
          locale: "en",
          onCancel: () => {},
          onSave: noop,
          size: "8.5",
        }),
      );

    expect(markup).not.toMatch(/[가-힣]/u);
    expect(markup).toContain("Applies to");
    expect(markup).toContain(">Default (all options) · set</option>");
    expect(markup).toContain(">8.25 · set</option>");
    expect(markup).toContain(
      "Without an option, saving updates the default for all options.",
    );
    expect(markup).toContain(
      "This option shows the default now. Saving applies to this option only.",
    );
  });

  const filled = {
    nose: "6.875",
    tail: "6.5",
    width: "8.25",
    length: "31.75",
    wheelbase: "14",
  };
  const empty = { nose: "", tail: "", width: "", length: "", wheelbase: "" };
  const option = (name: string, otherOptions: readonly string[] = ["8.5"]) => ({
    size: "8.25",
    name,
    otherOptions,
  });

  it("an option form shows its current name, while the default form has no name field", () => {
    const optionForm = renderToStaticMarkup(
      createElement(AdminDeckSpecForm, {
        onCancel: () => {},
        onSave: noop,
        otherOptions: ["8.5"],
        size: "8.25",
      }),
    );
    const defaultForm = renderToStaticMarkup(
      createElement(AdminDeckSpecForm, { onCancel: () => {}, onSave: noop }),
    );

    expect(optionForm).toContain("옵션 이름");
    expect(optionForm).toMatch(/<input[^>]*name="optionName"[^>]*value="8.25"/);
    expect(optionForm.match(/<input/g)).toHaveLength(6);
    // An unchanged name with empty fields cannot save, exactly like the H-035 option form.
    expect(optionForm).toMatch(/<button[^>]*disabled=""[^>]*type="submit"/);
    expect(defaultForm).not.toContain("옵션 이름");
    expect(defaultForm.match(/<input/g)).toHaveLength(5);
  });

  it("an unchanged name saves only a valid chart and is never re-checked", () => {
    expect(getDeckSpecSaveState(filled, option("8.25"))).toMatchObject({
      ready: true,
      sizeName: undefined,
      nameResult: null,
    });
    expect(getDeckSpecSaveState(empty, option(" 8.25 ")).ready).toBe(false);
    // A legacy name the new-name rules refuse still saves its chart while unchanged.
    expect(
      getDeckSpecSaveState(filled, {
        size: "8.5, wide",
        name: "8.5, wide",
        otherOptions: [],
      }),
    ).toMatchObject({ ready: true, nameResult: null });
    expect(getDeckSpecSaveState(filled).ready).toBe(true);
    expect(getDeckSpecSaveState(empty).ready).toBe(false);
  });

  it("a valid new name saves with a chart or alone with all five fields empty", () => {
    expect(getDeckSpecSaveState(filled, option(" 8.25 wide "))).toMatchObject({
      ready: true,
      sizeName: "8.25 wide",
    });
    expect(getDeckSpecSaveState(empty, option("8.25 wide"))).toMatchObject({
      ready: true,
      spec: null,
      sizeName: "8.25 wide",
    });
    // A half-filled chart never saves, even with a valid new name.
    expect(
      getDeckSpecSaveState({ ...empty, nose: "6.875" }, option("8.25 wide")).ready,
    ).toBe(false);
  });

  it("an invalid new name blocks saving with a reason", () => {
    for (const [name, reason] of [
      ["", "empty-option"],
      ["8.75, 9.0", "multiple-options"],
      ["x".repeat(51), "option-too-long"],
      ["constructor", "reserved-option"],
      ["8.5", "duplicate-option"],
    ] as const) {
      expect(getDeckSpecSaveState(filled, option(name))).toMatchObject({
        ready: false,
        nameResult: { ok: false, reason },
      });
    }
  });

  it("option name errors read in Korean and English without Korean in English", () => {
    const reasons = [
      "empty-option",
      "multiple-options",
      "option-too-long",
      "reserved-option",
      "duplicate-option",
    ] as const;
    const korean = reasons.map((reason) => optionNameError(reason, true));
    const english = reasons.map((reason) => optionNameError(reason, false));

    expect(new Set(korean).size).toBe(reasons.length);
    expect(korean.every((text) => /[가-힣]/u.test(text))).toBe(true);
    expect(english.join("")).not.toMatch(/[가-힣]/u);
    expect(english).toContain("This option name already exists.");
  });
});
