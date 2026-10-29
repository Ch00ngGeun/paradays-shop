import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  AdminHelpButton,
  adminHelpLabels,
  handleHelpEscape,
} from "@/components/admin-help-button";

const render = (locale: "ko" | "en", target: string) =>
  renderToStaticMarkup(
    createElement(
      AdminHelpButton,
      { locale, target },
      createElement("p", null, "BODY"),
    ),
  );

describe("admin help button", () => {
  it("names the button after its target in Korean and English", () => {
    expect(adminHelpLabels("옵션 추가", "ko")).toEqual({
      button: "옵션 추가 도움말",
      title: "옵션 추가 도움말",
      close: "닫기",
    });
    expect(adminHelpLabels("Add option", "en")).toEqual({
      button: "Help: Add option",
      title: "Help: Add option",
      close: "Close",
    });
  });

  it("renders only a closed '?' button with a dialog popup hint", () => {
    const markup = render("ko", "옵션 추가");

    expect(markup).toMatch(/^<button[^>]*type="button"/);
    expect(markup).toContain('aria-label="옵션 추가 도움말"');
    expect(markup).toContain('aria-haspopup="dialog"');
    // The visible mark is decorative; the accessible name comes from aria-label.
    expect(markup).toMatch(/<span aria-hidden="true"[^>]*>\?<\/span>/);
    // Help text stays out of the page until the button opens it.
    expect(markup).not.toContain("BODY");
    expect(markup).not.toContain('role="dialog"');
  });

  it("has no Korean in English", () => {
    const markup = render("en", "Add option");

    expect(markup).toContain('aria-label="Help: Add option"');
    expect(markup).not.toMatch(/[가-힣]/u);
  });

  it("Esc closes only the top help dialog and stops it reaching dialogs below", () => {
    const stack = ["lower", "upper"];
    const event = { key: "Escape", preventDefault: vi.fn(), stopPropagation: vi.fn() };
    const closeLower = vi.fn();
    const closeUpper = vi.fn();

    // Window capture listeners run in the order they were added: lower first, then upper.
    handleHelpEscape(event, "lower", closeLower, stack);
    handleHelpEscape(event, "upper", closeUpper, stack);

    expect(closeLower).not.toHaveBeenCalled();
    expect(closeUpper).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalledOnce();
  });

  it("other keys pass through untouched", () => {
    const event = { key: "Tab", preventDefault: vi.fn(), stopPropagation: vi.fn() };
    const close = vi.fn();

    handleHelpEscape(event, "only", close, ["only"]);

    expect(close).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("each help button gets its own dialog title id", () => {
    // Two closed buttons render no dialog, so this checks the source wiring instead of markup.
    const source = readFileSync(
      new URL("../components/admin-help-button.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toContain("aria-labelledby={titleId}");
    expect(source).toContain("id={titleId}");
    expect(source).not.toContain('"admin-help-title"');
  });
});
