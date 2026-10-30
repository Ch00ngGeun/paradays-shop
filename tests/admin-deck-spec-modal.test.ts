import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  AdminDeckSpecForm,
  deckSpecFailureMessage,
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

  it("builds a spec with blank fields as null, refusing a wrong field or no number at all", () => {
    const inputs = {
      nose: "6.875",
      tail: "6.5",
      width: "8.5",
      length: "31.75",
      wheelbase: "14.25",
    };
    expect(parseDeckSpecInputs(inputs)).toEqual(spec);
    // A blank field is saved as null.
    expect(parseDeckSpecInputs({ ...inputs, tail: " " })).toEqual({
      ...spec,
      tail: null,
    });
    // One wrong field still blocks the spec, and so does having no number at all.
    expect(parseDeckSpecInputs({ ...inputs, width: "0" })).toBeNull();
    expect(parseDeckSpecInputs({ ...inputs, tail: "", width: "0" })).toBeNull();
    expect(
      parseDeckSpecInputs({ nose: "", tail: "", width: "", length: "", wheelbase: "" }),
    ).toBeNull();
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
    expect(empty).toContain("Enter at least one value to see the diagram preview.");
    expect(filled).toMatch(/<button[^>]*type="submit"[^>]*>Save<\/button>/);
    expect(filled).toContain(">Delete</button>");
    expect(filled).toContain(">Cancel</button>");
  });

  const optionSpec = { ...spec, width: 8.25, wheelbase: 14 };
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

  it("renders the option form and its notice in English without Korean", () => {
    const markup = renderToStaticMarkup(
      createElement(AdminDeckSpecForm, {
        locale: "en",
        onCancel: () => {},
        onSave: noop,
        otherOptions: ["8.25"],
        size: "8.5",
      }),
    );

    expect(markup).not.toMatch(/[가-힣]/u);
    expect(markup).toContain("Option name");
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
    // A half-filled chart saves with the new name, its blank fields as null.
    expect(
      getDeckSpecSaveState({ ...empty, nose: "6.875" }, option("8.25 wide")),
    ).toMatchObject({
      ready: true,
      spec: { nose: 6.875, tail: null, width: null, length: null, wheelbase: null },
    });
    // A wrong field still blocks it.
    expect(
      getDeckSpecSaveState({ ...empty, nose: "0" }, option("8.25 wide")).ready,
    ).toBe(false);
  });

  it("saves a partial chart, deletes when every field is emptied, and has nothing to save when there was nothing", () => {
    const partial = { ...empty, width: "8.5", length: "31.75" };
    expect(getDeckSpecSaveState(partial)).toMatchObject({
      ready: true,
      spec: { nose: null, tail: null, width: 8.5, length: 31.75, wheelbase: null },
    });
    // Emptying every field of a saved chart is the same as deleting it.
    expect(getDeckSpecSaveState(empty, undefined, true)).toMatchObject({
      ready: true,
      spec: null,
    });
    expect(getDeckSpecSaveState(empty, option("8.25"), true).ready).toBe(true);
    // With no saved chart and no new name, an empty form has nothing to save.
    expect(getDeckSpecSaveState(empty).ready).toBe(false);
    expect(getDeckSpecSaveState(empty, option("8.25")).ready).toBe(false);
  });

  it("reopens a chart with blank fields as empty inputs, a preview with null, and saves an edit", async () => {
    const partial = {
      nose: null,
      tail: 6.5,
      width: 8.5,
      length: null,
      wheelbase: null,
    };
    const markup = renderToStaticMarkup(
      createElement(AdminDeckSpecForm, {
        initialSpec: partial,
        onCancel: () => {},
        onSave: noop,
      }),
    );
    // Blank fields come back empty, never as the word null.
    expect(markup).not.toContain('value="null"');
    expect(markup.match(/value=""/g)).toHaveLength(3);
    expect(markup).toContain('value="6.5"');
    // The preview shows at once, with null on the blank fields.
    expect(markup).toContain('role="img"');
    expect(markup).toContain("nose null");
    expect(markup).toMatch(/<button[^>]*type="submit"[^>]*>저장<\/button>/);
    expect(markup).not.toMatch(/<button[^>]*disabled=""[^>]*type="submit"/);
    // Editing one field of what was reopened saves the rest unchanged.
    const reopened = { nose: "", tail: "6.5", width: "8.5", length: "", wheelbase: "" };
    expect(
      getDeckSpecSaveState({ ...reopened, length: "31.75" }, undefined, true).spec,
    ).toEqual({ ...partial, length: 31.75 });
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

  it("a caller notice shows at the top of the form, and none leaves the markup unchanged", () => {
    const base = { onCancel: () => {}, onSave: noop, otherOptions: [], size: "M" };
    const plain = renderToStaticMarkup(createElement(AdminDeckSpecForm, base));
    const withUndefined = renderToStaticMarkup(
      createElement(AdminDeckSpecForm, {
        ...base,
        notice: undefined,
        describeError: () => undefined,
      }),
    );
    const noticed = renderToStaticMarkup(
      createElement(AdminDeckSpecForm, { ...base, notice: "CALLER_NOTICE" }),
    );

    expect(withUndefined).toBe(plain);
    expect(noticed).toContain("CALLER_NOTICE");
    expect(noticed.indexOf("CALLER_NOTICE")).toBeLessThan(noticed.indexOf("옵션 이름"));
    // The default-mode form, which the modal opens without a size, shows a notice too.
    expect(
      renderToStaticMarkup(
        createElement(AdminDeckSpecForm, {
          onCancel: () => {},
          onSave: noop,
          notice: "DEFAULT_NOTICE",
        }),
      ),
    ).toContain("DEFAULT_NOTICE");
  });

  it("a save failure uses the caller's description and falls back to the general message", () => {
    const reserved = new Error("reserved");
    const describe = (error: unknown) =>
      error === reserved ? "RESERVED_TEXT" : undefined;

    expect(deckSpecFailureMessage(reserved, describe, true)).toBe("RESERVED_TEXT");
    expect(deckSpecFailureMessage(new Error("other"), describe, true)).toBe(
      "저장하지 못했습니다. 입력값은 그대로 두었으니 다시 저장해 주세요.",
    );
    expect(deckSpecFailureMessage(reserved, undefined, false)).toBe(
      "Could not save. Your input is kept, so save again.",
    );
    // A throwing description falls back instead of escaping the save handler.
    const throwing = () => {
      throw new Error("describe failed");
    };
    expect(deckSpecFailureMessage(reserved, throwing, true)).toBe(
      "저장하지 못했습니다. 입력값은 그대로 두었으니 다시 저장해 주세요.",
    );
  });

  it("keeps the inch explanation behind a help button and shows the range only for a wrong value", () => {
    const clean = renderToStaticMarkup(
      createElement(AdminDeckSpecForm, {
        initialSpec: spec,
        onCancel: () => {},
        onSave: noop,
      }),
    );
    const wrong = renderToStaticMarkup(
      createElement(AdminDeckSpecForm, {
        initialSpec: { ...spec, width: 0 },
        onCancel: () => {},
        onSave: noop,
      }),
    );
    const english = renderToStaticMarkup(
      createElement(AdminDeckSpecForm, {
        initialSpec: { ...spec, width: 0 },
        locale: "en",
        onCancel: () => {},
        onSave: noop,
      }),
    );

    expect(clean).toContain('aria-label="상세사이즈 입력 도움말"');
    expect(clean).not.toContain("인치로 입력하면");
    expect(clean).not.toContain("0 초과 100 이하");
    expect(wrong).toContain("0 초과 100 이하의 인치로, 소수 4자리까지 입력해 주세요.");
    // The wrong field points at the range message.
    const errorId = /<p[^>]*id="([^"]+)"[^>]*>0 초과 100 이하/.exec(wrong)?.[1];
    expect(errorId).toBeTruthy();
    expect(wrong).toMatch(
      new RegExp(
        `<input[^>]*aria-describedby="${errorId}"[^>]*aria-invalid="true"[^>]*name="width"`,
      ),
    );
    expect(english).toContain('aria-label="Help: Size chart input"');
    expect(english).toContain(
      "Enter inches above 0 and up to 100, with up to 4 decimals.",
    );
    expect(english).not.toMatch(/[가-힣]/u);
  });

  it("still shows the default-value status for an option without its own chart", () => {
    const markup = renderToStaticMarkup(
      createElement(AdminDeckSpecForm, {
        onCancel: () => {},
        onSave: noop,
        size: "8.5",
      }),
    );

    expect(markup).toContain(
      "이 옵션은 지금 기본값을 표시합니다. 저장하면 이 옵션에만 적용됩니다.",
    );
  });
});
