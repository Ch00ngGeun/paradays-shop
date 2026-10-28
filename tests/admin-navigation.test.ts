import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ADMIN_SECTIONS,
  buildAdminSectionHref,
  getAdminProductEditorId,
  getAdminSectionSnapshot,
  getServerAdminSectionSnapshot,
  navigateToAdminSection,
  navigateToAdminProductEditor,
  parseAdminSection,
  PRODUCT_EDITOR_SESSION_LIMIT,
  ProductEditorSessions,
  subscribeToAdminSection,
} from "@/lib/admin-ui/navigation";
import type { AdminProductDraft } from "@/lib/admin-ui/types";

afterEach(() => vi.unstubAllGlobals());

function createBrowser(href = "https://paradays.example/admin") {
  const target = new EventTarget();
  const location = new URL(href);
  const updateLocation = (_data: unknown, _unused: string, nextHref: string) => {
    location.href = new URL(nextHref, location).href;
  };
  const history = {
    pushState: vi.fn(updateLocation),
    replaceState: vi.fn(updateLocation),
  };
  vi.stubGlobal("window", {
    location,
    history,
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
  });
  return { location, history, target };
}

describe("admin section navigation", () => {
  it.each(ADMIN_SECTIONS)("accepts only the %s section", (section) => {
    expect(parseAdminSection(`?section=${section}`)).toBe(section);
  });

  it.each([
    "",
    "?section=",
    "?section=unknown",
    "?section=INVENTORY",
    "?section=javascript%3Aalert(1)",
    "?section=inventory&section=sales",
    "?section=inventory&section=inventory",
  ])("falls back to overview for %s", (search) => {
    expect(parseAdminSection(search)).toBe("overview");
  });

  it("preserves unrelated query and hash while updating or removing the section", () => {
    expect(
      buildAdminSectionHref(
        "https://paradays.example/admin?locale=ko&section=products#review",
        "inventory",
      ),
    ).toBe("/admin?locale=ko&section=inventory#review");
    expect(
      buildAdminSectionHref(
        "https://paradays.example/admin?locale=ko&section=inventory#review",
        "overview",
      ),
    ).toBe("/admin?locale=ko#review");
  });

  it("has a deterministic server snapshot without reading a browser", () => {
    expect(getServerAdminSectionSnapshot()).toBe("overview");
    expect(getAdminSectionSnapshot()).toBe("overview");
  });

  it("records a changed section and notifies the store without reload or route replacement", () => {
    const { location, history } = createBrowser();
    const onChange = vi.fn();
    const unsubscribe = subscribeToAdminSection(onChange);
    navigateToAdminSection("inventory");
    expect(location.pathname).toBe("/admin");
    expect(location.search).toBe("?section=inventory");
    expect(getAdminSectionSnapshot()).toBe("inventory");
    expect(history.pushState).toHaveBeenCalledExactlyOnceWith(
      null,
      "",
      "/admin?section=inventory",
    );
    expect(history.replaceState).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("does not duplicate history when the active menu is selected again", () => {
    const { history } = createBrowser(
      "https://paradays.example/admin?section=inventory",
    );
    const onChange = vi.fn();
    const unsubscribe = subscribeToAdminSection(onChange);
    navigateToAdminSection("inventory");
    expect(history.pushState).not.toHaveBeenCalled();
    expect(history.replaceState).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("canonicalizes an invalid overview selection with replace rather than an extra history entry", () => {
    const { location, history } = createBrowser(
      "https://paradays.example/admin?locale=en&section=unknown#review",
    );
    navigateToAdminSection("overview");
    expect(location.href).toBe("https://paradays.example/admin?locale=en#review");
    expect(history.pushState).not.toHaveBeenCalled();
    expect(history.replaceState).toHaveBeenCalledExactlyOnceWith(
      null,
      "",
      "/admin?locale=en#review",
    );
  });

  it("observes Back/Forward popstate and removes both subscriptions on cleanup", () => {
    const { location, target } = createBrowser(
      "https://paradays.example/admin?section=inventory",
    );
    const observed: string[] = [];
    const unsubscribe = subscribeToAdminSection(() => {
      observed.push(getAdminSectionSnapshot());
    });
    location.search = "";
    target.dispatchEvent(new Event("popstate"));
    location.search = "?section=inventory";
    target.dispatchEvent(new Event("popstate"));
    expect(observed).toEqual(["overview", "inventory"]);
    unsubscribe();
    target.dispatchEvent(new Event("popstate"));
    navigateToAdminSection("brands");
    expect(observed).toEqual(["overview", "inventory"]);
  });
});

const editorA = "00000000-0000-4000-8000-000000000001";
const editorB = "00000000-0000-4000-8000-000000000002";
const draft = (name: string, productId?: string): AdminProductDraft => ({
  name,
  brand: "Synthetic brand",
  category: "Deck",
  sku: "SYNTHETIC",
  price: "10000",
  compareAtPrice: "",
  stock: "10",
  imageUrl: "/images/product-placeholder.svg",
  sizes: "TEST",
  description: "Synthetic draft only",
  isVisible: false,
  isFeatured: false,
  ...(productId ? { productId, version: 7 } : {}),
});

describe("workspace-only product editor history", () => {
  it("puts only the opaque ID in navigation and preserves unrelated query/hash", () => {
    const { location, history } = createBrowser(
      "https://paradays.example/admin?locale=ko#preview",
    );
    navigateToAdminProductEditor(editorA);
    expect(location.href).toBe(
      `https://paradays.example/admin?locale=ko&section=products&editor=${editorA}#preview`,
    );
    expect(history.pushState).toHaveBeenCalledExactlyOnceWith(
      null,
      "",
      `/admin?locale=ko&section=products&editor=${editorA}#preview`,
    );
    navigateToAdminProductEditor(editorA);
    expect(history.pushState).toHaveBeenCalledTimes(1);
    navigateToAdminSection("products");
    expect(location.search).toBe("?locale=ko&section=products");
    expect(history.pushState).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid, duplicate, out-of-section and unknown editor IDs", () => {
    const { location } = createBrowser();
    const sessions = new ProductEditorSessions(() => editorA);
    expect(sessions.getServerSnapshot()).toBeNull();
    for (const search of [
      "?section=products&editor=",
      "?section=products&editor=not-an-id",
      `?section=inventory&editor=${editorA}`,
      `?section=products&editor=${editorA}&editor=${editorB}`,
    ]) {
      location.search = search;
      expect(getAdminProductEditorId()).toBeNull();
      expect(sessions.getSnapshot()).toBeNull();
    }
    location.search = `?section=products&editor=${editorA}`;
    expect(getAdminProductEditorId()).toBe(editorA);
    expect(sessions.getSnapshot()).toBeNull();
  });

  it("restores the right draft and image on Back/Forward without releasing another editor", () => {
    const { location, target } = createBrowser();
    const release = vi.fn();
    const createId = vi.fn().mockReturnValueOnce(editorA).mockReturnValueOnce(editorB);
    const sessions = new ProductEditorSessions(createId, release);
    const file = new File(["synthetic image"], "synthetic.png", { type: "image/png" });
    sessions.open("edit", draft("Product A", "product-A"));
    navigateToAdminProductEditor(editorA);
    sessions.updateDraft(editorA, (current) => ({ ...current, name: "A unsaved" }));
    sessions.setImage(editorA, file, "blob:synthetic-A");
    const a = sessions.getSnapshot();
    navigateToAdminSection("brands");
    expect(sessions.getSnapshot()).toBeNull();
    sessions.open("edit", draft("Product B", "product-B"));
    navigateToAdminProductEditor(editorB);
    expect(sessions.getSnapshot()?.draft.name).toBe("Product B");
    location.search = `?section=products&editor=${editorA}`;
    target.dispatchEvent(new Event("popstate"));
    expect(sessions.getSnapshot()).toBe(a);
    expect(sessions.getSnapshot()?.draft.productId).toBe("product-A");
    expect(sessions.getSnapshot()?.imageFile).toBe(file);
    expect(sessions.getSnapshot()?.draft.imageUrl).toBe("blob:synthetic-A");
    expect(release).not.toHaveBeenCalled();
    location.search = `?section=products&editor=${editorB}`;
    target.dispatchEvent(new Event("popstate"));
    const b = sessions.getSnapshot();
    const bUrl = location.href;
    sessions.finishImageUpload(editorA, "/synthetic-upload-A.png");
    expect(sessions.getSnapshot()).toBe(b);
    expect(location.href).toBe(bUrl);
    expect(release).toHaveBeenCalledExactlyOnceWith("blob:synthetic-A");
  });

  it("revokes replaced images and keeps edit identity during explicit input reset", () => {
    createBrowser();
    const release = vi.fn();
    const sessions = new ProductEditorSessions(() => editorA, release);
    sessions.open("edit", draft("Product A", "product-A"));
    navigateToAdminProductEditor(editorA);
    const file = new File(["image"], "synthetic.png");
    sessions.setImage(editorA, file, "blob:first");
    sessions.setImage(editorA, file, "blob:second");
    expect(release).toHaveBeenCalledExactlyOnceWith("blob:first");
    sessions.reset(editorA, draft(""));
    expect(sessions.getSnapshot()?.mode).toBe("edit");
    expect(sessions.getSnapshot()?.draft.productId).toBe("product-A");
    expect(sessions.getSnapshot()?.draft.version).toBe(7);
    expect(sessions.getSnapshot()?.draft.name).toBe("");
    expect(sessions.getSnapshot()?.imageFile).toBeNull();
    expect(release).toHaveBeenNthCalledWith(2, "blob:second");
  });

  it("makes closed/saved/deleted sessions safely fall back to the list", () => {
    createBrowser();
    const createId = vi.fn().mockReturnValueOnce(editorA).mockReturnValueOnce(editorB);
    const sessions = new ProductEditorSessions(createId);
    sessions.open("edit", draft("Product A", "product-A"));
    sessions.open("edit", draft("Product B", "product-B"));
    sessions.invalidateProducts(new Set(["product-A"]));
    navigateToAdminProductEditor(editorA);
    expect(sessions.getSnapshot()).toBeNull();
    navigateToAdminProductEditor(editorB);
    expect(sessions.getSnapshot()?.draft.productId).toBe("product-B");
    sessions.remove(editorB);
    expect(sessions.getSnapshot()).toBeNull();
    sessions.updateDraft(editorB, () => draft("Must not revive"));
    expect(sessions.getSnapshot()).toBeNull();
  });

  it("bounds memory to 20 editors and releases evicted blobs", () => {
    createBrowser();
    let index = 0;
    const release = vi.fn();
    const sessions = new ProductEditorSessions(
      () => `00000000-0000-4000-8000-${String(++index).padStart(12, "0")}`,
      release,
    );
    const oldest = sessions.open("create", draft("First"));
    sessions.setImage(oldest, new File(["image"], "synthetic.png"), "blob:oldest");
    for (let i = 0; i < PRODUCT_EDITOR_SESSION_LIMIT; i++)
      sessions.open("create", draft(`Synthetic ${i}`));
    expect(sessions.has(oldest)).toBe(false);
    expect(release).toHaveBeenCalledExactlyOnceWith("blob:oldest");
    navigateToAdminProductEditor(oldest);
    expect(sessions.getSnapshot()).toBeNull();
  });

  it("discards all draft/file memory on workspace disposal or a new workspace", () => {
    createBrowser();
    const release = vi.fn();
    const sessions = new ProductEditorSessions(() => editorA, release);
    sessions.open("create", draft("Unsaved name"));
    sessions.setImage(editorA, new File(["image"], "synthetic.png"), "blob:memory");
    navigateToAdminProductEditor(editorA);
    expect(sessions.getSnapshot()?.draft.name).toBe("Unsaved name");
    expect(new ProductEditorSessions().getSnapshot()).toBeNull();
    sessions.dispose();
    expect(sessions.getSnapshot()).toBeNull();
    expect(release).toHaveBeenCalledExactlyOnceWith("blob:memory");
    sessions.setImage(editorA, new File(["late"], "late.png"), "blob:late");
    expect(release).toHaveBeenNthCalledWith(2, "blob:late");
  });

  it("notifies immutable store updates and cleans all subscriptions", () => {
    const { target } = createBrowser();
    const sessions = new ProductEditorSessions(() => editorA);
    const listener = vi.fn();
    const unsubscribe = sessions.subscribe(listener);
    sessions.open("create", draft("Before"));
    navigateToAdminProductEditor(editorA);
    const before = sessions.getSnapshot();
    sessions.updateDraft(editorA, (current) => ({ ...current, name: "After" }));
    expect(sessions.getSnapshot()).not.toBe(before);
    expect(before?.draft.name).toBe("Before");
    expect(sessions.getSnapshot()?.draft.name).toBe("After");
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    target.dispatchEvent(new Event("popstate"));
    sessions.remove(editorA);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
