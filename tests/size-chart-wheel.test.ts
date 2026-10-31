import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SizeChartWheel } from "@/components/size-chart-wheel";

const values = { diameter: 54, width: 33.5, contactWidth: 20 };

describe("wheel size chart diagram", () => {
  it("shows mm only: W above and below, T above, and the diameter at the side", () => {
    const markup = renderToStaticMarkup(
      createElement(SizeChartWheel, { values, locale: "ko" }),
    );
    const labels = [...markup.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map(
      ([, text]) => text,
    );
    expect(labels).toEqual(["33.5mm", "20mm", "33.5mm", "54mm"]);
    expect(markup).not.toContain("<tspan");
    expect(markup).not.toContain("cm");
    expect(markup).toContain('transform="translate(50 310) rotate(-90)"');
    expect(markup).toContain('role="img"');
  });

  it("preserves maximum and decimal millimeters without adding a conversion line", () => {
    const markup = renderToStaticMarkup(
      createElement(SizeChartWheel, {
        values: { diameter: 100, width: 99.9, contactWidth: 100 },
        locale: "en",
      }),
    );
    const labels = [...markup.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map(
      ([, text]) => text,
    );

    expect(labels).toEqual(["99.9mm", "100mm", "99.9mm", "100mm"]);
    expect(markup).not.toContain("<tspan");
    expect(markup).toContain(
      "Diameter 100mm, W overall width 99.9mm, T contact width 100mm",
    );
  });

  it("names every measurement in the screen language", () => {
    const korean = renderToStaticMarkup(
      createElement(SizeChartWheel, { values, locale: "ko" }),
    );
    expect(korean).toContain(
      'aria-label="휠: 지름 54mm, W 전체 폭 33.5mm, T 바닥 닿는 폭 20mm"',
    );
    const english = renderToStaticMarkup(
      createElement(SizeChartWheel, { values, locale: "en" }),
    );
    expect(english).toContain(
      'aria-label="Wheel: Diameter 54mm, W overall width 33.5mm, T contact width 20mm"',
    );
  });

  it("draws a blank wheel field as null without mm", () => {
    const markup = renderToStaticMarkup(
      createElement(SizeChartWheel, {
        values: { diameter: 54, width: null, contactWidth: null },
        locale: "en",
      }),
    );
    const labels = [...markup.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map(
      ([, text]) => text,
    );
    // W shows twice, above and below.
    expect(labels).toEqual(["null", "null", "null", "54mm"]);
    expect(markup).not.toContain("nullmm");
    expect(markup).toContain(
      'aria-label="Wheel: Diameter 54mm, W overall width null, T contact width null"',
    );
  });
});
