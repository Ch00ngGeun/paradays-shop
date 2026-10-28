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
  });

  it("draws every measurement as inches with a smaller cm value instead of a word label", () => {
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
    expect(markup.match(/<text/g)).toHaveLength(5);
    expect(markup).toContain('role="img"');
    expect(markup).toContain("nose 6.875&quot; (17.5cm)");
  });
});
