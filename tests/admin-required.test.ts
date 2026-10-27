import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const required = readFileSync("components/admin-required.module.css", "utf8");
const dashboard = readFileSync("components/admin-dashboard.module.css", "utf8");
const globals = readFileSync("app/globals.css", "utf8");
const block = (css: string, selector: string) =>
  css.slice(css.indexOf(selector), css.indexOf("}", css.indexOf(selector)));
const value = (css: string, name: string) =>
  css.match(new RegExp(`--${name}:\\s*([^;]+);`))![1].trim();
const rgb = (hex: string) =>
  [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));

describe("shared required-field rule", () => {
  it("uses the selected inventory box style (blue border, 6% blue wash) in light and dark themes", () => {
    const selected = block(dashboard, '.inventorySelect[aria-pressed="true"]');
    expect(selected).toContain(
      "background: color-mix(in srgb, #2864b4 6%, var(--color-paper));",
    );
    expect(selected).toContain("border-color: #2864b4;");
    const light = block(globals, ":root {");
    const dark = block(globals, ':root[data-theme="dark"]');
    for (const [theme, scope] of [
      [light, block(required, ".requiredScope {")],
      [dark, block(required, ':global(:root[data-theme="dark"]) .requiredScope')],
    ]) {
      const paper = rgb(value(theme, "color-paper"));
      const blue = rgb("#2864b4");
      const mixed = paper.map((p, i) => Math.round(blue[i] * 0.06 + p * 0.94));
      const background = rgb(value(scope, "required-background"));
      background.forEach((channel, i) =>
        expect(Math.abs(channel - mixed[i])).toBeLessThanOrEqual(1),
      );
      expect(value(scope, "required-border")).toBe("#2864b4");
    }
  });

  it("targets only enabled required inputs that are still empty or invalid", () => {
    expect(required).toMatch(
      /:required:is\(:invalid, :placeholder-shown\):not\(\s*:disabled\s*\)/,
    );
    expect(required).toContain(":is(input, select, textarea)");
    expect(required).toContain("forced-colors: active");
  });
});
