import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  AdminDeckSpecForm,
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
});
