import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SizeChartBottom } from "@/components/size-chart-bottom";

const values = { length: 100, waist: 40, hip: 52, thigh: 32, rise: 30, hem: 21.5 };

describe("bottom size chart diagram", () => {
  it.each(["longPants", "shorts"] as const)(
    "draws every %s value as cm with smaller inches, one label each",
    (kind) => {
      const markup = renderToStaticMarkup(
        createElement(SizeChartBottom, { kind, values, locale: "ko" }),
      );
      for (const cm of ["100cm", "40cm", "52cm", "32cm", "30cm", "21.5cm"])
        expect(markup).toContain(`>${cm}<tspan class="_sub_`);
      for (const inches of ['39.4"', '15.7"', '20.5"', '12.6"', '11.8"', '8.5"'])
        expect(markup).toContain(`>(${inches.replace('"', "&quot;")})</tspan>`);
      expect(markup.match(/<text/g)).toHaveLength(6);
      expect(markup.match(/<tspan[^>]*x="0" dy="30"/g)).toHaveLength(6);
      expect(markup.match(/<path class="_measure_/g)).toHaveLength(
        kind === "longPants" ? 7 : 6,
      );
      expect(markup).toContain('role="img"');
    },
  );

  it.each(["longPants", "shorts"] as const)(
    "preserves maximum and blank %s measurements while separating the inch conversion",
    (kind) => {
      const markup = renderToStaticMarkup(
        createElement(SizeChartBottom, {
          kind,
          values: {
            length: 299.9,
            waist: 300,
            hip: 299.9,
            thigh: 300,
            rise: null,
            hem: 300,
          },
          locale: "en",
        }),
      );

      expect(markup.match(/>299\.9cm<tspan/g)).toHaveLength(2);
      expect(markup.match(/>300cm<tspan/g)).toHaveLength(3);
      expect(markup.match(/<tspan[^>]*x="0" dy="30"/g)).toHaveLength(5);
      expect(markup).toContain(">null</text>");
      expect(markup).toContain("Rise null");
      expect(markup).not.toContain("nullcm");
    },
  );

  it("names the drawing and every measurement in the screen language", () => {
    const korean = renderToStaticMarkup(
      createElement(SizeChartBottom, { kind: "shorts", values, locale: "ko" }),
    );
    expect(korean).toContain(
      'aria-label="반바지: 총장 100cm (39.4&quot;), 허리단면 40cm (15.7&quot;), 엉덩이단면 52cm (20.5&quot;), 허벅지단면 32cm (12.6&quot;), 밑위 30cm (11.8&quot;), 밑단단면 21.5cm (8.5&quot;)"',
    );
    const english = renderToStaticMarkup(
      createElement(SizeChartBottom, { kind: "longPants", values, locale: "en" }),
    );
    const label = /aria-label="([^"]*)"/.exec(english)?.[1] ?? "";
    expect(label).toContain("Long pants: Length 100cm");
    expect(label).toContain("Rise 30cm");
    expect(label).not.toMatch(/\p{Script=Hangul}/u);
  });
});
