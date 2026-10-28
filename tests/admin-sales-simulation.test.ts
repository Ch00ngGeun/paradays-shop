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
  getAccessToken: vi.fn(() => {
    throw new Error("No token allowed in simulation");
  }),
}));
vi.mock("@/contexts/auth-context", () => ({ useAuth: () => auth }));
import { AdminSalesLedgerPanel } from "@/components/admin-sales-ledger";
import { AdminSalesSimulationPanel } from "@/components/admin-sales-simulation";

beforeEach(() => {
  auth.status = "authenticated";
  auth.isAuthenticated = true;
  auth.user = { sub: "synthetic-admin", groups: ["admin"] };
  auth.getAccessToken.mockClear();
});
describe("sales simulation mode rendering and IO separation", () => {
  it("opens on explicit mode choice without mounting the real ledger or an active simulation", () => {
    const html = renderToStaticMarkup(
      createElement(AdminSalesLedgerPanel, { products: [] }),
    );
    expect(html).toContain("매출·일마감 모드 선택");
    expect(html).toContain("실제 매출·일마감 열기");
    expect(html).toContain("실제 장부와 재고를 바꾸지 않는 모의 체험임을 확인했습니다");
    expect(html).toMatch(/<button[^>]+disabled[^>]*>모의 매출·일마감 체험/);
    expect(html).not.toContain('id="sales-ledger-title"');
    expect(html).not.toContain('id="sales-simulation-title"');
    expect(html).not.toContain("장부 조회");
    expect(auth.getAccessToken).not.toHaveBeenCalled();
  });
  it("renders the mode choice in English when the admin locale is English", () => {
    const html = renderToStaticMarkup(
      createElement(AdminSalesLedgerPanel, { products: [], locale: "en" }),
    );
    expect(html).toContain("Choose sales and daily close mode");
    expect(html).toContain("Open real operations · Open real sales and daily close");
    expect(html).toMatch(/<button[^>]+disabled[^>]*>Try mock sales and daily close/);
    expect(html).not.toMatch(/[가-힣]/);
  });
  it("renders a synthetic world with permanent warnings, blank editable form and zero online total", () => {
    const html = renderToStaticMarkup(
      createElement(AdminSalesSimulationPanel, { onExit: () => {} }),
    );
    expect(html).toContain("모의 전용입니다.");
    expect(html).toContain("실제 매출 또는 재고 검증 결과가 아닙니다.");
    expect(html).toContain("TEST_DAY_001");
    expect(html).toContain("온라인 매출은 합성 0원");
    expect(html).toContain("메뉴를 옮겼다 돌아오면 유지");
    expect(html).toContain("초기화·종료·새로고침·로그아웃·계정 교체 시 폐기");
    expect(html).toContain('aria-label="가상 데크 재고">10개');
    expect(html).toContain('aria-label="가상 그립 재고">5개');
    expect(html).toContain('aria-label="모의 온라인 매출">0원');
    expect(html).toContain("모의 초안 저장");
    expect(html).toContain("가상 재고 예정표 확인");
    expect(html).toContain("모의 일마감 확정");
    expect(html).toContain("저장된 모의 전표가 없습니다.");
    expect(html).not.toContain("TEST_SALE_001");
    expect(auth.getAccessToken).not.toHaveBeenCalled();
  });
  it("members, anonymous and initializing sessions cannot enter either mode", () => {
    for (const session of [
      {
        status: "authenticated",
        isAuthenticated: true,
        user: { sub: "synthetic-member", groups: [] },
      },
      { status: "anonymous", isAuthenticated: false, user: null },
      { status: "initializing", isAuthenticated: false, user: null },
    ]) {
      Object.assign(auth, session);
      expect(
        renderToStaticMarkup(createElement(AdminSalesLedgerPanel, { products: [] })),
      ).toBe("");
    }
  });
  it("simulation component and model have no auth, transport, production adapter or persistent storage references", () => {
    for (const file of [
      "../components/admin-sales-simulation.tsx",
      "../lib/admin-ui/sales-ledger-simulation.ts",
    ]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source).not.toMatch(
        /\b(fetch|XMLHttpRequest|localStorage|sessionStorage|URLSearchParams|sendBeacon|getAccessToken|useAuth)\b/,
      );
      expect(source).not.toMatch(
        /from\s+["'][^"']*(commerce|infra|admin-api-client|auth-context)[^"']*["']/,
      );
    }
  });
  it("keys mode ownership by account and prevents leaving a busy or unresolved real ledger", () => {
    const source = readFileSync(
      new URL("../components/admin-sales-ledger.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toContain("<SalesModeSession key={user.sub}");
    expect(source).toContain('if (mode === "simulation")');
    expect(source).toContain("<AdminSalesSimulationPanel onExit={chooseMode}");
    expect(source).toContain("if (!busyRef.current && !attempt) onExit();");
    expect(source).toContain("disabled={locked}");
  });
});
