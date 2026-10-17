import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CatalogFilterProvider,
  useCatalogFilter,
} from "@/contexts/catalog-filter-context";
import { nextSelectedFilterIds } from "@/lib/catalog-filter";
import {
  CATALOG_FILTER_SESSION_KEY,
  readCatalogFilterSession,
  writeCatalogFilterSession,
} from "@/lib/catalog-filter-session";

function createStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    }),
  };
}

const stored = (ids: unknown) => JSON.stringify({ version: 1, selectedIds: ids });

afterEach(() => vi.unstubAllGlobals());

describe("catalog filter session", () => {
  it("does not read browser storage on the server", () => {
    expect(readCatalogFilterSession()).toEqual(new Set());
    expect(() => writeCatalogFilterSession(new Set(["deck"]))).not.toThrow();
  });

  it("leaves an untouched initial session empty without writing a key", () => {
    const storage = createStorage();
    expect(readCatalogFilterSession(storage)).toEqual(new Set());
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it("restores category, brand and sale selections after a new document reads them", () => {
    const storage = createStorage();
    const selected = new Set(["deck", "brand-april", "sale"]);
    writeCatalogFilterSession(selected, storage);

    expect(readCatalogFilterSession(storage)).toEqual(selected);
    expect(JSON.parse(storage.values.get(CATALOG_FILTER_SESSION_KEY)!)).toEqual({
      version: 1,
      selectedIds: ["brand-april", "deck", "sale"],
    });
  });

  it("allows independent category/brand groups and group All selections", () => {
    const storage = createStorage();
    const selected = new Set(["clothes-all", "skateboard-all", "brand-all", "sale"]);
    writeCatalogFilterSession(selected, storage);
    expect(readCatalogFilterSession(storage)).toEqual(selected);
  });

  it("retains the existing OR/AND and group replacement selection semantics", () => {
    const storage = createStorage();
    writeCatalogFilterSession(new Set(["clothes-all", "brand-butter"]), storage);
    const next = nextSelectedFilterIds(readCatalogFilterSession(storage), "top");
    writeCatalogFilterSession(next, storage);
    expect(readCatalogFilterSession(storage)).toEqual(new Set(["top", "brand-butter"]));
  });

  it("root All deletes only its own key and remains clear after the next reload", () => {
    const storage = createStorage();
    storage.setItem("unrelated:pending", "keep-existing-state");
    writeCatalogFilterSession(new Set(["deck", "brand-april"]), storage);
    writeCatalogFilterSession(
      nextSelectedFilterIds(readCatalogFilterSession(storage), "all"),
      storage,
    );
    expect(readCatalogFilterSession(storage)).toEqual(new Set());
    expect(storage.values.has(CATALOG_FILTER_SESSION_KEY)).toBe(false);
    expect([...storage.values]).toEqual([["unrelated:pending", "keep-existing-state"]]);
  });

  it("explicit clear deletes the stored selection", () => {
    const storage = createStorage();
    writeCatalogFilterSession(new Set(["deck"]), storage);
    writeCatalogFilterSession(new Set(), storage);
    expect(readCatalogFilterSession(storage)).toEqual(new Set());
    expect(storage.removeItem).toHaveBeenCalledWith(CATALOG_FILTER_SESSION_KEY);
  });

  it.each([
    "not-json",
    "null",
    "[]",
    "1",
    JSON.stringify({ selectedIds: ["deck"] }),
    JSON.stringify({ version: 2, selectedIds: ["deck"] }),
    JSON.stringify({ version: 1, selectedIds: ["deck"], extra: "not-a-filter" }),
    stored("deck"),
    stored([1]),
    stored(["all"]),
    stored(["unknown"]),
    stored(["deck", "deck"]),
    stored(["clothes-all", "top"]),
    stored(["skateboard-all", "deck"]),
    stored(["brand-all", "brand-april"]),
    stored(Array.from({ length: 100 }, () => "deck")),
    " ".repeat(4_097),
  ])("falls back safely for corrupt or unsupported payload %s", (payload) => {
    const storage = createStorage();
    storage.setItem(CATALOG_FILTER_SESSION_KEY, payload);
    storage.setItem("unrelated:pending", "keep-existing-state");
    expect(readCatalogFilterSession(storage)).toEqual(new Set());
    expect(storage.values.get("unrelated:pending")).toBe("keep-existing-state");
  });

  it("does not persist unsupported or conflicting IDs", () => {
    const storage = createStorage();
    writeCatalogFilterSession(new Set(["deck"]), storage);
    writeCatalogFilterSession(new Set(["private-value"]), storage);
    writeCatalogFilterSession(new Set(["brand-all", "brand-april"]), storage);
    expect(readCatalogFilterSession(storage)).toEqual(new Set(["deck"]));
    expect(storage.setItem).toHaveBeenCalledTimes(1);
  });

  it("handles storage get, set, and remove failures without throwing", () => {
    const denied = () => {
      throw new Error("Storage is unavailable");
    };
    const storage = { getItem: denied, setItem: denied, removeItem: denied };
    expect(readCatalogFilterSession(storage)).toEqual(new Set());
    expect(() => writeCatalogFilterSession(new Set(["deck"]), storage)).not.toThrow();
    expect(() => writeCatalogFilterSession(new Set(), storage)).not.toThrow();
    expect(readCatalogFilterSession(null)).toEqual(new Set());
    expect(() => writeCatalogFilterSession(new Set(["deck"]), null)).not.toThrow();
  });

  it("handles browser sessionStorage getter denial", () => {
    vi.stubGlobal("window", {
      get sessionStorage() {
        throw new Error("Storage access is blocked");
      },
    });
    expect(readCatalogFilterSession()).toEqual(new Set());
    expect(() => writeCatalogFilterSession(new Set(["deck"]))).not.toThrow();
  });

  it("keeps server markup empty even if a browser-like storage object exists", () => {
    const storage = createStorage();
    writeCatalogFilterSession(new Set(["deck"]), storage);
    vi.stubGlobal("window", { sessionStorage: storage });
    const Probe = () =>
      createElement("span", null, [...useCatalogFilter().selectedIds].join(","));

    const markup = renderToString(
      createElement(CatalogFilterProvider, null, createElement(Probe)),
    );
    expect(markup).toBe("<span></span>");
    expect(storage.getItem).not.toHaveBeenCalled();
    expect(storage.setItem).toHaveBeenCalledTimes(1);
  });
});
