import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildAdminEntryHref,
  buildAdminStoreResumeHref,
  getAdminStoreResumeSnapshot,
  getAdminStoreReturnSnapshot,
  getServerAdminStoreReturnSnapshot,
  getServerStorefrontHashSnapshot,
  getStorefrontHashSnapshot,
  parseAdminStoreReturnPath,
  sanitizeStorefrontReturnPath,
  subscribeToStorefrontHash,
} from "@/lib/admin-ui/store-return";
import {
  ADMIN_SECTIONS,
  buildAdminSectionHref,
  navigateToAdminProductEditor,
  navigateToAdminSection,
  parseAdminSection,
} from "@/lib/admin-ui/navigation";
import { consumeAuthReturnPath, rememberAuthReturnPath } from "@/lib/auth/return-path";

afterEach(() => vi.unstubAllGlobals());

function createBrowser(path: string) {
  const location = new URL(path, "https://paradays.example");
  const target = new EventTarget();
  const stored = new Map<string, string>();
  const sessionStorage = {
    getItem: vi.fn((key: string) => stored.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => stored.set(key, value)),
    removeItem: vi.fn((key: string) => stored.delete(key)),
  };
  const move = (_state: unknown, _unused: string, href: string) => {
    location.href = new URL(href, location).href;
  };
  vi.stubGlobal("window", {
    location,
    sessionStorage,
    history: { pushState: vi.fn(move), replaceState: vi.fn(move) },
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
  });
  return { location, target, sessionStorage, stored };
}

describe("explicit per-entry storefront return contract", () => {
  it.each([
    "/",
    "/cart",
    "/account",
    "/products",
    "/products/odwyer-sync-1-8-375",
    "/products/odwyer-sync-1-8-375/",
    "/products?slug=prd-test-item",
    "/products?slug=prd-test-item&locale=ko#reviews",
    "/products/odwyer-sync-1-8-375?locale=en#details",
  ])("round-trips the public store path %s without global state", (path) => {
    const entry = new URL(buildAdminEntryHref(path), "https://paradays.example");
    expect(entry.pathname).toBe("/admin");
    expect(parseAdminStoreReturnPath(entry.search)).toBe(path);
  });

  it("keeps published Korean slugs through query encoding", () => {
    const path = "/products?slug=메이플-데크&locale=ko#description";
    const entry = new URL(buildAdminEntryHref(path), "https://paradays.example");
    const result = new URL(
      parseAdminStoreReturnPath(entry.search),
      "https://paradays.example",
    );
    expect(result.pathname).toBe("/products");
    expect(result.searchParams.get("slug")).toBe("메이플-데크");
    expect(result.searchParams.get("locale")).toBe("ko");
    expect(result.hash).toBe("#description");
  });

  it.each([
    "https://attacker.example/products/a",
    "http://paradays.example/products/a",
    "//attacker.example/products/a",
    "javascript:alert(1)",
    "/\\attacker.example/products/a",
    "/admin",
    "/admin?returnTo=/products/a",
    "/admin/inventory",
    "/login",
    "/signup",
    "/auth/callback?code=private",
    "/api/admin/catalog",
    "/products/../admin",
    "/products/%2e%2e/admin",
    "/products/%252e%252e/admin",
    "/products%2f../admin",
    "/products%5c../admin",
    "/%2f%2fattacker.example",
    "/products/%ZZ",
    "/products//a",
    "/products/a\n",
    "/products/a\u0000",
    "/products/a b",
    `/${"a".repeat(2_048)}`,
  ])("falls back to home for unsafe or unsupported path %s", (path) => {
    expect(sanitizeStorefrontReturnPath(path)).toBe("/");
    expect(buildAdminEntryHref(path)).toBe("/admin");
    expect(parseAdminStoreReturnPath(`?returnTo=${encodeURIComponent(path)}`)).toBe(
      "/",
    );
  });

  it.each([
    "",
    "?section=inventory",
    "?returnTo=",
    "?returnTo=%2Fproducts%2Fa&returnTo=%2Fproducts%2Fb",
    "?returnTo=%2Fproducts%2Fa&returnTo=%2Fproducts%2Fa",
    "?returnTo=%2Fproducts%3Fslug%3Da%26slug%3Db",
    "?returnTo=%2Fproducts%3Flocale%3Dko%26locale%3Den",
  ])("does not guess an ambiguous return destination from %s", (search) => {
    expect(parseAdminStoreReturnPath(search)).toBe("/");
  });

  it("copies no arbitrary token, draft, order, user or authentication fragment", () => {
    const path =
      "/products?slug=public-deck&locale=ko&access_token=private&email=person%40example.test&orderId=private&draft=private#id_token=private";
    expect(sanitizeStorefrontReturnPath(path)).toBe(
      "/products?slug=public-deck&locale=ko",
    );
    const entry = buildAdminEntryHref(path);
    expect(entry).not.toMatch(/private|token|email|orderId|draft/);
    expect(sanitizeStorefrontReturnPath("/cart?slug=public-deck#unknown")).toBe(
      "/cart",
    );
    expect(sanitizeStorefrontReturnPath("/products?locale=unknown")).toBe("/products");
  });

  it("retains the explicit entry through all menu and editor addresses", () => {
    const path = "/products?slug=public-deck&locale=en#reviews";
    const { location, sessionStorage } = createBrowser(buildAdminEntryHref(path));
    navigateToAdminSection("inventory");
    expect(getAdminStoreReturnSnapshot()).toBe(path);
    navigateToAdminSection("sales");
    expect(getAdminStoreReturnSnapshot()).toBe(path);
    navigateToAdminProductEditor("00000000-0000-0000-0000-000000000001");
    expect(getAdminStoreReturnSnapshot()).toBe(path);
    const overview = buildAdminSectionHref(location.href, "overview");
    expect(parseAdminStoreReturnPath(new URL(overview, location).search)).toBe(path);
    expect(sessionStorage.setItem).not.toHaveBeenCalled();
    expect(sessionStorage.getItem).not.toHaveBeenCalled();
  });

  it("uses the existing one-shot auth return without adding a storage key", () => {
    const path = "/products/odwyer-sync-1-8-375#details";
    const entry = buildAdminEntryHref(path);
    const { sessionStorage, stored } = createBrowser(entry);
    rememberAuthReturnPath();
    expect([...stored.keys()]).toEqual(["paradays-auth-return-to"]);
    expect(consumeAuthReturnPath()).toBe(entry);
    expect(consumeAuthReturnPath()).toBe("/");
    expect(sessionStorage.setItem).toHaveBeenCalledTimes(1);
    expect(stored.size).toBe(0);
    expect(
      parseAdminStoreReturnPath(new URL(entry, "https://paradays.example").search),
    ).toBe(path);
  });

  it("has deterministic server values without a browser or stale session memory", () => {
    expect(getServerAdminStoreReturnSnapshot()).toBe("/");
    expect(getAdminStoreReturnSnapshot()).toBe("/");
    expect(getServerStorefrontHashSnapshot()).toBe("");
    expect(getStorefrontHashSnapshot()).toBe("");
    createBrowser(buildAdminEntryHref("/products/a"));
    expect(getAdminStoreReturnSnapshot()).toBe("/products/a");
    createBrowser(buildAdminEntryHref("/products/b"));
    expect(getAdminStoreReturnSnapshot()).toBe("/products/b");
    createBrowser("/admin");
    expect(getAdminStoreReturnSnapshot()).toBe("/");
  });

  it("observes hash/back-forward events and unsubscribes cleanly", () => {
    const { location, target } = createBrowser("/products/a#details");
    const onChange = vi.fn();
    const unsubscribe = subscribeToStorefrontHash(onChange);
    expect(getStorefrontHashSnapshot()).toBe("#details");
    location.hash = "#reviews";
    target.dispatchEvent(new Event("hashchange"));
    target.dispatchEvent(new Event("popstate"));
    expect(getStorefrontHashSnapshot()).toBe("#reviews");
    expect(onChange).toHaveBeenCalledTimes(2);
    unsubscribe();
    target.dispatchEvent(new Event("hashchange"));
    target.dispatchEvent(new Event("popstate"));
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});

describe("explicit storefront round-trip admin menu resume", () => {
  const storefrontPath = "/products?slug=public-deck&locale=en#reviews";

  it.each(ADMIN_SECTIONS)("restores only the public %s menu", (section) => {
    const admin = new URL(
      buildAdminEntryHref(storefrontPath),
      "https://paradays.example",
    );
    admin.searchParams.set("section", section);
    const storeHref = buildAdminStoreResumeHref(admin.search);
    const storefront = new URL(storeHref, admin);
    expect(storefront.pathname).toBe("/products");
    expect(storefront.searchParams.get("slug")).toBe("public-deck");
    expect(storefront.searchParams.get("locale")).toBe("en");
    expect(storefront.hash).toBe("#reviews");
    expect(storefront.searchParams.get("adminSection")).toBe(
      section === "overview" ? null : section,
    );
    const resumed = new URL(buildAdminEntryHref(storeHref), admin);
    expect(parseAdminSection(resumed.search)).toBe(section);
    expect(parseAdminStoreReturnPath(resumed.search)).toBe(storefrontPath);
    expect(resumed.searchParams.get("returnTo")).not.toContain("adminSection");
    expect(buildAdminStoreResumeHref(resumed.search)).toBe(storeHref);
  });

  it.each([
    "/",
    "/cart",
    "/account",
    "/products/odwyer-sync-1-8-375?locale=ko#details",
    "/products?slug=메이플-데크#description",
  ])("preserves the storefront identity for %s", (path) => {
    const admin = new URL(buildAdminEntryHref(path), "https://paradays.example");
    admin.searchParams.set("section", "inventory");
    const resumed = new URL(
      buildAdminEntryHref(buildAdminStoreResumeHref(admin.search)),
      admin,
    );
    expect(parseAdminSection(resumed.search)).toBe("inventory");
    expect(parseAdminStoreReturnPath(resumed.search)).toBe(
      sanitizeStorefrontReturnPath(path),
    );
  });

  it.each([
    "",
    "?section=unknown",
    "?section=inventory&section=products",
    "?section=inventory&section=inventory",
  ])("falls back to overview for an invalid admin menu %s", (search) => {
    const query = new URLSearchParams(search);
    query.set("returnTo", storefrontPath);
    expect(buildAdminStoreResumeHref(query.toString())).toBe(storefrontPath);
  });

  it.each([
    "adminSection=unknown",
    "adminSection=",
    "adminSection=inventory&adminSection=products",
    "adminSection=inventory&adminSection=inventory",
    "adminSection=%2Fadmin%3Fsection%3Dinventory",
    "adminSection=Inventory",
  ])("does not resume ambiguous storefront menu markers %s", (query) => {
    const admin = new URL(
      buildAdminEntryHref(`/products?slug=public-deck&${query}#reviews`),
      "https://paradays.example",
    );
    expect(parseAdminSection(admin.search)).toBe("overview");
    expect(parseAdminStoreReturnPath(admin.search)).toBe(
      "/products?slug=public-deck#reviews",
    );
  });

  it.each([
    "https://attacker.example/products/a?adminSection=inventory",
    "//attacker.example/products/a?adminSection=inventory",
    "/admin?adminSection=inventory",
    "/products/../admin?adminSection=inventory",
    "/products/%2e%2e/admin?adminSection=inventory",
    "/products%2f../admin?adminSection=inventory",
    "/products?slug=a&slug=b&adminSection=inventory",
    "/?locale=ko&locale=en&adminSection=inventory",
  ])("rejects resume context from an unsafe storefront path %s", (path) => {
    expect(buildAdminEntryHref(path)).toBe("/admin");
  });

  it("transmits no editor, draft, file, account, mode, token or nested context", () => {
    const query = new URLSearchParams({
      returnTo:
        "/products?slug=public-deck&adminSection=members&private=private#reviews",
      section: "products",
      editor: "00000000-0000-0000-0000-000000000001",
      draft: "private",
      file: "private",
      mode: "real",
      account: "private",
      access_token: "private",
    });
    const href = buildAdminStoreResumeHref(query.toString());
    expect(href).toBe("/products?slug=public-deck&adminSection=products#reviews");
    const entry = new URL(buildAdminEntryHref(href), "https://paradays.example");
    expect([...entry.searchParams.keys()]).toEqual(["returnTo", "section"]);
    expect(parseAdminStoreReturnPath(entry.search)).toBe(
      "/products?slug=public-deck#reviews",
    );
    expect(`${href}${entry.search}`).not.toMatch(
      /private|editor|draft|file|mode|account|token|members|00000000/,
    );
  });

  it("keeps direct admin home and account/tab contexts independent without storage", () => {
    expect(getAdminStoreResumeSnapshot()).toBe("/");
    const first = createBrowser(
      `${buildAdminEntryHref(storefrontPath)}&section=inventory`,
    );
    expect(getAdminStoreResumeSnapshot()).toBe(
      "/products?slug=public-deck&locale=en&adminSection=inventory#reviews",
    );
    expect(getAdminStoreReturnSnapshot()).toBe(storefrontPath);
    const second = createBrowser("/admin");
    expect(getAdminStoreResumeSnapshot()).toBe("/");
    expect(buildAdminEntryHref("/products/unrelated-product")).toBe(
      "/admin?returnTo=%2Fproducts%2Funrelated-product",
    );
    for (const browser of [first, second]) {
      expect(browser.sessionStorage.getItem).not.toHaveBeenCalled();
      expect(browser.sessionStorage.setItem).not.toHaveBeenCalled();
      expect(browser.sessionStorage.removeItem).not.toHaveBeenCalled();
    }
  });

  it("keeps the resumed menu through the existing one-shot login return", () => {
    const path = "/products/public-deck?adminSection=inventory#details";
    const entry = buildAdminEntryHref(path);
    const { stored } = createBrowser(entry);
    rememberAuthReturnPath();
    expect([...stored.keys()]).toEqual(["paradays-auth-return-to"]);
    expect(consumeAuthReturnPath()).toBe(entry);
    const admin = new URL(entry, "https://paradays.example");
    expect(parseAdminSection(admin.search)).toBe("inventory");
    expect(parseAdminStoreReturnPath(admin.search)).toBe(
      "/products/public-deck#details",
    );
  });
});
