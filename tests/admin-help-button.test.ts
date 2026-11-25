// 역할: 관리자 도움말 버튼의 이름·닫힌 상태 렌더링·영어 문구와 최상위 도움말만 닫는 Esc 처리를 검증함.
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
    // 보이는 표시는 장식이고 접근성 이름은 aria-label에서 옴.
    expect(markup).toMatch(/<span aria-hidden="true"[^>]*>\?<\/span>/);
    // 도움말 글은 버튼으로 열기 전까지 페이지에 없음.
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

    // window 캡처 리스너는 추가된 순서로 실행됨: 아래 것이 먼저, 그다음 위 것.
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
    // 닫힌 버튼 두 개는 대화상자를 렌더링하지 않으므로 마크업 대신 소스 연결을 확인함.
    const source = readFileSync(
      new URL("../components/admin-help-button.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toContain("aria-labelledby={titleId}");
    expect(source).toContain("id={titleId}");
    expect(source).not.toContain('"admin-help-title"');
  });
});
