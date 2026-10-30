import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  SizeChartTop,
  arrowHead,
  sizeChartDescription,
} from "@/components/size-chart-top";

const shortSleeve = {
  length: 72,
  shoulder: 50.5,
  chest: 56,
  sleeveLength: 22,
  hem: 55,
  sleeveWidth: 20.5,
  armhole: 24,
};
const raglan = {
  length: 70,
  chest: 58,
  cuff: 10,
  neckToCuff: 80.5,
  hem: 50,
  armhole: 30,
};

describe("top size chart diagram", () => {
  it("draws every short-sleeve value as cm with smaller inches, one label each", () => {
    const markup = renderToStaticMarkup(
      createElement(SizeChartTop, {
        kind: "shortSleeve",
        values: shortSleeve,
        locale: "ko",
      }),
    );
    for (const cm of ["72cm", "50.5cm", "56cm", "22cm", "55cm", "20.5cm", "24cm"])
      expect(markup).toContain(`>${cm}<tspan class="_sub_`);
    for (const inches of ['28.3"', '19.9"', '22.0"', '8.7"', '21.7"', '8.1"', '9.4"'])
      expect(markup).toContain(`>(${inches.replace('"', "&quot;")})</tspan>`);
    expect(markup.match(/<text/g)).toHaveLength(7);
    expect(markup).toContain('role="img"');
    expect(markup).toContain(
      "반팔: 총장 72cm (28.3&quot;), 어깨너비 50.5cm (19.9&quot;), 가슴단면 56cm (22.0&quot;)",
    );
  });

  it("draws the raglan drawing's six values and names them in English", () => {
    const markup = renderToStaticMarkup(
      createElement(SizeChartTop, {
        kind: "raglanLongSleeve",
        values: raglan,
        locale: "en",
      }),
    );
    expect(markup.match(/<text/g)).toHaveLength(6);
    for (const cm of ["70cm", "58cm", "10cm", "80.5cm", "50cm", "30cm"])
      expect(markup).toContain(`>${cm}<tspan`);
    const label = /aria-label="([^"]*)"/.exec(markup)?.[1] ?? "";
    expect(label).toContain("Raglan long sleeve: Length 70cm");
    expect(label).toContain("Sleeve length from neck 80.5cm");
    expect(label).not.toMatch(/\p{Script=Hangul}/u);
  });

  it("describes values in drawing order", () => {
    expect(sizeChartDescription("raglanLongSleeve", raglan, "ko")).toBe(
      '래글런 긴팔: 총장 70cm (27.6"), 가슴단면 58cm (22.8"), 소매부리 10cm (3.9"), 화장 80.5cm (31.7"), 밑단단면 50cm (19.7"), 암홀 30cm (11.8")',
    );
  });

  it("points arrow heads back along the line", () => {
    // A head at the right end of a horizontal line opens to the left.
    expect(arrowHead(100, 50, 0, 50)).toBe("M 93.7 47.0 L 100 50 L 93.7 53.0");
  });
});
