import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AdminStepper, deriveSteps } from "@/components/admin-stepper";

const labels = ["이미지", "인식", "내용 검토", "검토본 저장", "입고 반영"];

describe("admin stepper", () => {
  it("derives complete, current and upcoming from the real completed count", () => {
    expect(deriveSteps(labels, 2).map((s) => s.state)).toEqual([
      "complete",
      "complete",
      "current",
      "upcoming",
      "upcoming",
    ]);
    expect(deriveSteps(labels, 0)[0]!.state).toBe("current");
    expect(deriveSteps(labels, 5).every((s) => s.state === "complete")).toBe(true);
    expect(deriveSteps(labels, -3)[0]!.state).toBe("current");
    expect(deriveSteps(labels, 99).map((s) => s.state)).not.toContain("current");
  });

  it("never marks a disconnected step complete, even if the count reaches it", () => {
    expect(deriveSteps(["대상", "작성", "발송"], 3, 2).map((s) => s.state)).toEqual([
      "complete",
      "complete",
      "unavailable",
    ]);
    expect(deriveSteps(["작성", "발송"], 0, 1).map((s) => s.state)).toEqual([
      "current",
      "unavailable",
    ]);
  });

  it("renders an ordered list with one aria-current step and text state names", () => {
    const html = renderToStaticMarkup(
      createElement(AdminStepper, {
        label: "입고 작업 흐름",
        steps: deriveSteps(labels, 2),
      }),
    );
    expect(html).toMatch(/^<ol aria-label="입고 작업 흐름"/);
    expect(html.match(/aria-current="step"/g)).toHaveLength(1);
    expect(html).toContain('data-state="current"');
    expect(html.match(/<li/g)).toHaveLength(5);
    expect(html).toContain("(완료)");
    expect(html).toContain("(현재 단계)");
    expect(html).toContain("(예정)");
    // Completed steps keep their number in the visible label, like the reference.
    expect(html).toMatch(/>1 <\/span>이미지/);
    expect(html).toMatch(/<svg[^>]*>/);
    expect(html).not.toMatch(/\srole=|aria-live/);
  });

  it("shows 연결 필요 visibly for disconnected steps", () => {
    const html = renderToStaticMarkup(
      createElement(AdminStepper, {
        label: "캠페인 작업 흐름",
        steps: deriveSteps(["대상", "작성", "발송"], 1, 2),
      }),
    );
    expect(html).toContain(" · 연결 필요");
    expect(html).toContain('data-state="unavailable"');
  });

  it("keeps the stepper tokens theme-aware and readable in forced colors", () => {
    const css = readFileSync("components/admin-stepper.module.css", "utf8");
    expect(css).toContain("var(--color-ink)");
    expect(css).toContain("var(--color-paper)");
    expect(css).toContain("forced-colors: active");
    expect(css).toContain("max-width: 560px");
  });
});
