import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AdminNotice,
  AdminStatusBadge,
  getStockStatus,
  StockStatusBadge,
  type AdminSeverity,
  type AdminStatus,
  type StockStatus,
} from "@/components/admin-status";

const statusCases: [AdminStatus, AdminSeverity, string][] = [
  ["urgent", "danger", "긴급"],
  ["blocking", "danger", "진행 불가"],
  ["danger", "danger", "오류"],
  ["success", "success", "완료"],
  ["attention", "warning", "확인 필요"],
  ["warning", "warning", "주의"],
  ["neutral", "neutral", "안내"],
];

describe("admin status badges", () => {
  it.each(statusCases)(
    "%s retains a visible status name and a decorative dot",
    (status, severity, label) => {
      const html = renderToStaticMarkup(createElement(AdminStatusBadge, { status }));
      expect(html).toContain(`data-status="${status}"`);
      expect(html).toContain(`data-severity="${severity}"`);
      expect(html).toContain(`>${label}</span>`);
      expect(html).toMatch(/<span aria-hidden="true" class="[^"]+"><\/span>/);
      expect(html).not.toMatch(/\srole=|\saria-live=|\saria-label=/);
    },
  );

  it("keeps the status name alongside extra context and ReactNode children", () => {
    const html = renderToStaticMarkup(
      createElement(
        AdminStatusBadge,
        {
          status: "attention",
          label: "저장 결과",
          className: "caller-badge",
        },
        createElement("strong", null, "다시 확인해 주세요"),
      ),
    );
    expect(html).toContain("확인 필요 · 저장 결과");
    expect(html).toContain("<strong>다시 확인해 주세요</strong>");
    expect(html).toContain("caller-badge");
  });

  it("preserves a zero child and escapes plain text instead of injecting HTML", () => {
    const html = renderToStaticMarkup(
      createElement(AdminStatusBadge, { status: "neutral", label: "<b>수량</b>" }, 0),
    );
    expect(html).toContain("안내 · &lt;b&gt;수량&lt;/b&gt;");
    expect(html).toContain(" · 0</span>");
    expect(html).not.toContain("<b>수량</b>");
  });

  it("does not repeat an identical status label", () => {
    const html = renderToStaticMarkup(
      createElement(AdminStatusBadge, { status: "warning", label: "주의" }),
    );
    expect(html.match(/주의/g)).toHaveLength(1);
  });
});

describe("stock status classification", () => {
  it.each<[number | undefined, StockStatus, AdminSeverity, string]>([
    [0, "outOfStock", "neutral", "품절"],
    [-0, "outOfStock", "neutral", "품절"],
    [1, "low", "warning", "주의"],
    [5, "low", "warning", "주의"],
    [6, "normal", "success", "정상"],
    [1_000_000, "normal", "success", "정상"],
    [undefined, "unknown", "warning", "확인 필요"],
    [-1, "unknown", "warning", "확인 필요"],
    [NaN, "unknown", "warning", "확인 필요"],
    [Infinity, "unknown", "warning", "확인 필요"],
    [-Infinity, "unknown", "warning", "확인 필요"],
    [1.5, "unknown", "warning", "확인 필요"],
    [0.5, "unknown", "warning", "확인 필요"],
  ])("classifies stock %s as %s", (stock, status, severity, label) => {
    expect(getStockStatus(stock)).toBe(status);
    const html = renderToStaticMarkup(createElement(StockStatusBadge, { stock }));
    expect(html).toContain(`data-stock-status="${status}"`);
    expect(html).toContain(`data-severity="${severity}"`);
    expect(html).toContain(`>${label}</span>`);
    expect(html).not.toMatch(/완료|\srole=|\saria-live=/);
    if (status !== "normal") expect(html).not.toContain(">정상</span>");
  });

  it.each([null, "", "0", "6", true, {}, []])(
    "does not coerce unexpected runtime data (%j) into valid stock",
    (value) => {
      const stock = value as unknown as number;
      expect(getStockStatus(stock)).toBe("unknown");
      const html = renderToStaticMarkup(createElement(StockStatusBadge, { stock }));
      expect(html).toContain(">확인 필요</span>");
      expect(html).not.toContain(">정상</span>");
    },
  );

  it("accepts a caller class without a duplicate completion label", () => {
    const html = renderToStaticMarkup(
      createElement(StockStatusBadge, { stock: 6, className: "stock-cell" }),
    );
    expect(html).toContain("stock-cell");
    expect(html.match(/정상/g)).toHaveLength(1);
    expect(html).not.toContain("완료");
  });
});

describe("admin notices and announcement opt in", () => {
  it.each(statusCases)(
    "%s has readable text, a decorative icon and no default live region",
    (status, severity, label) => {
      const html = renderToStaticMarkup(
        createElement(AdminNotice, { status }, "내용을 확인해 주세요."),
      );
      expect(html).toContain(`data-status="${status}"`);
      expect(html).toContain(`data-severity="${severity}"`);
      expect(html).toContain(`>${label}</strong>`);
      expect(html).toContain("내용을 확인해 주세요.");
      expect(html).toMatch(/<svg[^>]+aria-hidden="true"[^>]+focusable="false"/);
      expect(html).not.toMatch(/\srole=|\saria-live=|\saria-atomic=|<title>/);
    },
  );

  it.each(statusCases)("%s can opt in to a polite announcement", (status) => {
    const html = renderToStaticMarkup(
      createElement(
        AdminNotice,
        { status, announce: "polite" },
        "상태가 바뀌었습니다.",
      ),
    );
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-atomic="true"');
    expect(html).not.toContain('role="alert"');
  });

  it.each(statusCases)(
    "%s permits an alert only for an explicitly announced dangerous change",
    (status, severity) => {
      const html = renderToStaticMarkup(
        createElement(AdminNotice, { status, announce: "assertive" }, "변경 안내"),
      );
      expect(html).toContain(`role="${severity === "danger" ? "alert" : "status"}"`);
      expect(html).toContain('aria-atomic="true"');
    },
  );

  it("keeps a visible state beside a title and renders rich children", () => {
    const html = renderToStaticMarkup(
      createElement(
        AdminNotice,
        {
          status: "blocking",
          title: "재고 반영을 멈췄습니다",
          className: "caller-note",
        },
        createElement("p", null, "수량을 확인한 뒤 다시 시도해 주세요."),
      ),
    );
    expect(html).toContain("진행 불가 · 재고 반영을 멈췄습니다");
    expect(html).toContain("<p>수량을 확인한 뒤 다시 시도해 주세요.</p>");
    expect(html).toContain("caller-note");
    expect(html).not.toContain('role="alert"');
  });

  it("retains numeric children without duplicating a matching heading", () => {
    const html = renderToStaticMarkup(
      createElement(
        AdminNotice,
        { status: "neutral", title: "안내", announce: "off" },
        0,
      ),
    );
    expect(html.match(/안내/g)).toHaveLength(1);
    expect(html).toContain(">0</div>");
    expect(html).not.toMatch(/\srole=|\saria-atomic=/);
  });
});

const css = readFileSync(
  new URL("../components/admin-status.module.css", import.meta.url),
  "utf8",
);

function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]+)\\}`));
  expect(match, `missing CSS rule: ${selector}`).not.toBeNull();
  return match![1];
}

function token(body: string, name: string): string {
  const match = body.match(new RegExp(`--status-${name}:\\s*(#[0-9a-f]{6});`, "i"));
  expect(match, `missing literal color token: ${name}`).not.toBeNull();
  return match![1];
}

function luminance(hex: string): number {
  const channels = hex
    .slice(1)
    .match(/../g)!
    .map((channel) => {
      const value = parseInt(channel, 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrast(first: string, second: string): number {
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

describe("shared status CSS accessibility", () => {
  for (const theme of ["light", "dark"] as const) {
    it.each<AdminSeverity>(["danger", "success", "warning", "neutral"])(
      `${theme} %s text exceeds 4.5:1 and dot/icon exceeds 3:1 against its background`,
      (severity) => {
        const prefix = theme === "dark" ? ':global(:root[data-theme="dark"]) ' : "";
        const body = ruleBody(`${prefix}.${severity}`);
        const background = token(body, "background");
        expect(contrast(background, token(body, "text"))).toBeGreaterThanOrEqual(4.5);
        expect(contrast(background, token(body, "mark"))).toBeGreaterThanOrEqual(3);
      },
    );
  }

  it("uses the tested tokens for the actual badge/notice text, dot and icon", () => {
    const shared = ruleBody(".badge,\n.notice");
    expect(shared).toContain("background: var(--status-background)");
    expect(shared).toContain("color: var(--status-text)");
    expect(ruleBody(".dot")).toContain("background: var(--status-mark)");
    expect(ruleBody(".icon")).toContain("color: var(--status-mark)");
    expect(ruleBody(".notice")).toContain(
      "border-inline-start: 3px solid var(--status-mark)",
    );
  });

  it("has a real CSS rule for every literal CSS module class used by the component", () => {
    const source = readFileSync(
      new URL("../components/admin-status.tsx", import.meta.url),
      "utf8",
    );
    const classes = [...source.matchAll(/styles\.([A-Za-z][A-Za-z0-9]*)/g)].map(
      (match) => match[1],
    );
    expect(new Set(classes).size).toBeGreaterThanOrEqual(10);
    for (const className of new Set(classes)) {
      expect(css).toMatch(new RegExp(`\\.${className}(?![A-Za-z0-9_-])`));
    }
    expect(source).not.toMatch(/styles\[/);
  });

  it("wraps long text without forcing a wider flex or grid item", () => {
    const shared = ruleBody(".badge,\n.notice");
    expect(shared).toContain("max-width: 100%");
    expect(shared).toContain("min-width: 0");
    expect(shared).toContain("overflow-wrap: anywhere");
    expect(shared).toContain("white-space: normal");
    expect(ruleBody(".badgeText,\n.content")).toContain("min-width: 0");
    expect(ruleBody(".message")).toContain("overflow-wrap: anywhere");
    const longText = "확인할내용".repeat(100);
    const html = renderToStaticMarkup(
      createElement(AdminNotice, { status: "attention", title: longText }, longText),
    );
    expect(html).toContain(longText);
  });

  it("retains outlines and system colors in forced colors mode", () => {
    expect(css).toContain("@media (forced-colors: active)");
    const forcedColors = css.slice(css.indexOf("@media (forced-colors: active)"));
    expect(forcedColors).toContain("background: Canvas;");
    expect(forcedColors).toContain("border-color: CanvasText;");
    expect(forcedColors).toContain("color: CanvasText;");
    expect(forcedColors).toContain("border-inline-start-color: CanvasText;");
    expect(forcedColors).toContain("background: CanvasText;");
    expect(forcedColors).toContain("forced-color-adjust: auto;");
    expect(ruleBody(".dot")).toContain("border: 1px solid var(--status-mark)");
    expect(css).not.toContain("forced-color-adjust: none");
  });

  it("adds no motion and explicitly respects reduced motion", () => {
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    const motionDeclarations = [
      ...css.matchAll(/(?:animation|transition):\s*([^;]+);/g),
    ];
    expect(motionDeclarations).toHaveLength(2);
    for (const match of motionDeclarations) expect(match[1]).toBe("none");
    expect(css).not.toContain("@keyframes");
  });
});
