import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  AdminGuideButton,
  adminGuideLabels,
  guideMarkShape,
  isTopModalLayer,
  nextGuideStep,
  placeGuideBubble,
  recoverGuideStep,
  type AdminGuideStep,
} from "@/components/admin-guide";

const viewport = { width: 1280, height: 720 };
const bubble = { width: 300, height: 140 };

describe("guide bubble placement", () => {
  it("sits below the target with an arrow pointing up at it", () => {
    const place = placeGuideBubble(
      { left: 500, top: 100, width: 200, height: 40 },
      bubble,
      viewport,
    );

    expect(place.side).toBe("below");
    expect(place.left).toBe(450);
    expect(place.top).toBe(154);
    expect(place.arrow).toEqual({ x1: 600, y1: 154, x2: 600, y2: 142 });
  });

  it("moves above the target when there is no room below", () => {
    const place = placeGuideBubble(
      { left: 500, top: 620, width: 200, height: 40 },
      bubble,
      viewport,
    );

    expect(place.side).toBe("above");
    expect(place.top).toBe(620 - 14 - 140);
    expect(place.arrow.y1).toBe(place.top + 140);
    expect(place.arrow.y2).toBe(618);
  });

  it("stays inside a 375px screen at both edges", () => {
    const narrow = { width: 375, height: 667 };
    const left = placeGuideBubble(
      { left: 0, top: 50, width: 40, height: 40 },
      bubble,
      narrow,
    );
    const right = placeGuideBubble(
      { left: 340, top: 50, width: 30, height: 40 },
      bubble,
      narrow,
    );

    expect(left.left).toBe(12);
    expect(right.left).toBe(375 - 12 - 300);
    // The arrow still starts on the bubble and ends at the target's centre.
    expect(right.arrow.x2).toBe(355);
    expect(right.arrow.x1).toBeLessThanOrEqual(right.left + 300);
  });
});

describe("guide marks", () => {
  const target = { left: 10, top: 20, width: 100, height: 30 };

  it("rings the target with padding by default", () => {
    expect(guideMarkShape(target)).toEqual({
      kind: "ring",
      x: 4,
      y: 14,
      width: 112,
      height: 42,
    });
  });

  it("underlines an input", () => {
    expect(guideMarkShape(target, "underline")).toEqual({
      kind: "underline",
      x1: 10,
      y1: 53,
      x2: 110,
      y2: 53,
    });
  });
});

describe("guide step order", () => {
  const steps: AdminGuideStep[] = ["list", "hidden", "form", "save"].map((target) => ({
    target,
    title: target,
    body: target,
  }));
  const onScreen = (step: AdminGuideStep) => step.target !== "hidden";

  it("skips steps whose target is not on screen in both directions", () => {
    expect(nextGuideStep(steps, -1, 1, onScreen)).toBe(0);
    expect(nextGuideStep(steps, 0, 1, onScreen)).toBe(2);
    expect(nextGuideStep(steps, 2, -1, onScreen)).toBe(0);
    expect(nextGuideStep(steps, 3, 1, onScreen)).toBe(-1);
    expect(nextGuideStep(steps, 0, -1, onScreen)).toBe(-1);
    expect(nextGuideStep(steps, -1, 1, () => false)).toBe(-1);
  });
});

describe("guide button", () => {
  it("renders a closed '? Help' button with a screen-help name in both languages", () => {
    const korean = renderToStaticMarkup(
      createElement(AdminGuideButton, { steps: [], locale: "ko" }),
    );
    const english = renderToStaticMarkup(
      createElement(AdminGuideButton, { steps: [], locale: "en" }),
    );

    expect(korean).toContain('aria-label="화면 도움말"');
    expect(korean).toContain('aria-haspopup="dialog"');
    expect(korean).toContain(">도움말</span>");
    expect(korean).not.toContain('role="dialog"');
    expect(english).toContain('aria-label="Screen help"');
    expect(english).not.toMatch(/[가-힣]/u);
  });

  it("labels steps and the empty case in both languages", () => {
    expect(adminGuideLabels("ko").count(2, 4)).toBe("2/4단계");
    expect(adminGuideLabels("en").count(2, 4)).toBe("Step 2 of 4");
    expect(Object.values(adminGuideLabels("en")).join(" ")).not.toMatch(/[가-힣]/u);
  });
});

describe("guide robustness", () => {
  const steps: AdminGuideStep[] = ["a", "b", "c"].map((target) => ({
    target,
    title: target,
    body: target,
  }));

  it("moves forward, then back, then to the empty state when the current target goes away", () => {
    expect(recoverGuideStep(steps, 1, (step) => step.target !== "b")).toBe(2);
    expect(recoverGuideStep(steps, 2, (step) => step.target === "a")).toBe(0);
    expect(recoverGuideStep(steps, 1, () => false)).toBe(-1);
  });

  it("lets Esc close only the dialog in the last modal layer on the page", () => {
    const layer = (name: string) => ({ name, dataset: { modalLayer: "true" } });
    const app = { name: "app", dataset: {} };
    const guide = layer("guide");
    const help = layer("help");

    expect(isTopModalLayer(guide, [app, guide])).toBe(true);
    // Whichever opened later is on top; the one below ignores the key.
    expect(isTopModalLayer(guide, [app, guide, help])).toBe(false);
    expect(isTopModalLayer(help, [app, guide, help])).toBe(true);
    expect(isTopModalLayer(guide, [app])).toBe(false);
  });

  it("announces steps politely and respects reduced motion when scrolling", () => {
    // The overlay only renders in a browser, so this checks its wiring in the source.
    const source = readFileSync(
      new URL("../components/admin-guide.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toContain('aria-live="polite"');
    expect(source).toContain('matchMedia("(prefers-reduced-motion: reduce)")');
    expect(source).toContain('behavior: reduceMotion ? "instant" : "smooth"');
  });
});
