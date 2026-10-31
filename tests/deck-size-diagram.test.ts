import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  DeckSizeDiagram,
  formatDeckCm,
  formatDeckInches,
} from "@/components/deck-size-diagram";

describe("deck size diagram", () => {
  it("converts inches to cm rounded to one decimal", () => {
    expect(formatDeckCm(6.875)).toBe("17.5cm");
    expect(formatDeckCm(8.5)).toBe("21.6cm");
    expect(formatDeckCm(31.75)).toBe("80.6cm");
    expect(formatDeckCm(14.25)).toBe("36.2cm");
    expect(formatDeckCm(8)).toBe("20.3cm");
    expect(formatDeckInches(14.25)).toBe('14.25"');
    // A blank field has no inch mark.
    expect(formatDeckInches(null)).toBe("null");
  });

  it("draws every measurement as inches with cm on its own line and marks the nose and tail ends", () => {
    const markup = renderToStaticMarkup(
      createElement(DeckSizeDiagram, {
        spec: { nose: 6.875, tail: 6.5, width: 8.5, length: 31.75, wheelbase: 14.25 },
      }),
    );

    for (const [inches, cm] of [
      ["6.875", "17.5"],
      ["6.5", "16.5"],
      ["8.5", "21.6"],
      ["31.75", "80.6"],
      ["14.25", "36.2"],
    ]) {
      expect(markup).toContain(`${inches}&quot;<tspan`);
      expect(markup).toContain(`>(${cm}cm)</tspan>`);
    }
    // Each conversion starts a new centered line, so it cannot lengthen its inch label.
    expect(markup.match(/<tspan[^>]*x="0" dy="24"/g)).toHaveLength(5);
    expect(markup.match(/<text/g)).toHaveLength(7);
    expect(markup).toMatch(/<text[^>]*y="20"[^>]*>nose<\/text>/);
    expect(markup).toMatch(/<text[^>]*y="600"[^>]*>tail<\/text>/);
    expect(markup).toContain('role="img"');
    expect(markup).toContain("nose 6.875&quot; (17.5cm)");
  });

  it("draws a blank field as null alone, without inches or cm, in the drawing and its name", () => {
    const markup = renderToStaticMarkup(
      createElement(DeckSizeDiagram, {
        spec: { nose: null, tail: 6.5, width: 8.5, length: null, wheelbase: 14.25 },
      }),
    );

    expect(markup.match(/>null</g)).toHaveLength(2);
    expect(markup).not.toContain("null&quot;");
    expect(markup).not.toContain("(nullcm)");
    // The filled fields keep their inches and cm.
    expect(markup).toContain("6.5&quot;<tspan");
    expect(markup).toContain(">(16.5cm)</tspan>");
    expect(markup).toContain(
      'aria-label="nose null, tail 6.5&quot; (16.5cm), width 8.5&quot; (21.6cm), length null, wheelbase 14.25&quot; (36.2cm)"',
    );
    expect(markup.match(/<text/g)).toHaveLength(7);
  });

  it("preserves all digits at the supported upper precision instead of shortening the visible value", () => {
    const markup = renderToStaticMarkup(
      createElement(DeckSizeDiagram, {
        spec: {
          nose: 99.9999,
          tail: 100,
          width: 99.9999,
          length: 100,
          wheelbase: null,
        },
      }),
    );

    expect(markup.match(/>99\.9999&quot;<tspan/g)).toHaveLength(2);
    expect(markup.match(/>100&quot;<tspan/g)).toHaveLength(2);
    expect(markup.match(/>\(254\.0cm\)<\/tspan>/g)).toHaveLength(4);
    expect(markup).toContain("wheelbase null");
    expect(markup).not.toContain("textLength=");
  });
});
