import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AdminHelpButton, adminHelpLabels } from "@/components/admin-help-button";

const render = (locale: "ko" | "en", target: string) =>
  renderToStaticMarkup(
    createElement(AdminHelpButton, {
      locale,
      target,
      children: createElement("p", null, "BODY"),
    }),
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
});
