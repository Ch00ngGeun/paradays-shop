import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
const auth = vi.hoisted(() => ({
  status: "authenticated",
  isAuthenticated: true,
  user: { sub: "synthetic-admin", groups: ["admin"] } as {
    sub: string;
    groups: string[];
  } | null,
}));
vi.mock("@/contexts/auth-context", () => ({ useAuth: () => auth }));
import { AdminOrderSimulationPanel } from "@/components/admin-order-simulation";
beforeEach(() => {
  auth.status = "authenticated";
  auth.isAuthenticated = true;
  auth.user = { sub: "synthetic-admin", groups: ["admin"] };
});
describe("simulation access and IO isolation", () => {
  it("admin sees distinct permanent warning and opt-in only; no pre-created active test order", () => {
    const html = renderToStaticMarkup(createElement(AdminOrderSimulationPanel));
    expect(html).toContain("모의 주문·재고 테스트");
    expect(html).toContain("실제 결제나 재고 검증 결과가 아닙니다.");
    expect(html).toContain("브라우저 메모리");
    expect(html).toMatch(/<button[^>]+disabled/);
    expect(html).not.toContain("TEST_PRODUCT_DECK");
  });
  it("members, anonymous and initializing sessions cannot render the test controls", () => {
    auth.user = { sub: "synthetic-member", groups: [] };
    expect(renderToStaticMarkup(createElement(AdminOrderSimulationPanel))).toBe("");
    auth.user = null;
    auth.status = "anonymous";
    auth.isAuthenticated = false;
    expect(renderToStaticMarkup(createElement(AdminOrderSimulationPanel))).toBe("");
    auth.status = "initializing";
    expect(renderToStaticMarkup(createElement(AdminOrderSimulationPanel))).toBe("");
  });
  it("simulation component and calculator have no network, production-adapter, storage or URL-mode dependencies", () => {
    for (const file of [
      "../components/admin-order-simulation.tsx",
      "../lib/admin-ui/order-inventory-simulation.ts",
    ]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source).not.toMatch(
        /\b(fetch|XMLHttpRequest|localStorage|sessionStorage|URLSearchParams|sendBeacon)\b/,
      );
      expect(source).not.toMatch(
        /from\s+["'][^"']*(commerce|infra|admin-api-client)[^"']*["']/,
      );
    }
  });
});
