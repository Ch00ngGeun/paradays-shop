import type { AdminProductDraft } from "./types";

/** 관리자 메뉴 이동을 주소와 브라우저 이전/다음 기록에 연결합니다. */
export const ADMIN_SECTIONS = [
  "overview",
  "products",
  "inventory",
  "sales",
  "brands",
  "members",
  "coupons",
  "marketing",
  "ocr",
] as const;

export type AdminSection = (typeof ADMIN_SECTIONS)[number];

const SECTION_CHANGE_EVENT = "paradays:admin-section-change";
export const PRODUCT_EDITOR_SESSION_LIMIT = 20;

/** 허용 목록 밖의 값이나 중복 파라미터는 운영 홈으로 안전하게 처리합니다. */
export function parseAdminSection(search: string): AdminSection {
  const values = new URLSearchParams(search).getAll("section");
  return values.length === 1 && ADMIN_SECTIONS.some((section) => section === values[0])
    ? (values[0] as AdminSection)
    : "overview";
}

export function buildAdminSectionHref(
  currentHref: string,
  section: AdminSection,
): string {
  const url = new URL(currentHref);
  url.searchParams.delete("editor");
  if (section === "overview") url.searchParams.delete("section");
  else url.searchParams.set("section", section);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function getAdminSectionSnapshot(): AdminSection {
  return typeof window === "undefined"
    ? getServerAdminSectionSnapshot()
    : parseAdminSection(window.location.search);
}

export function getServerAdminSectionSnapshot(): AdminSection {
  return "overview";
}

export function subscribeToAdminSection(onChange: () => void): () => void {
  window.addEventListener("popstate", onChange);
  window.addEventListener(SECTION_CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener(SECTION_CHANGE_EVENT, onChange);
  };
}

/** 같은 메뉴 재선택은 기록을 늘리지 않고 기존 query/hash는 보존합니다. */
export function navigateToAdminSection(
  section: AdminSection,
  options?: Readonly<{ replace?: boolean }>,
): void {
  const href = buildAdminSectionHref(window.location.href, section);
  const currentHref = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (currentHref === href) return;
  if (
    options?.replace ||
    (getAdminSectionSnapshot() === section && !getAdminProductEditorId())
  ) {
    window.history.replaceState(null, "", href);
  } else {
    window.history.pushState(null, "", href);
  }
  window.dispatchEvent(new Event(SECTION_CHANGE_EVENT));
}

export function getAdminProductEditorId(): string | null {
  if (typeof window === "undefined" || getAdminSectionSnapshot() !== "products")
    return null;
  const values = new URLSearchParams(window.location.search).getAll("editor");
  return values.length === 1 && /^[0-9a-f-]{36}$/.test(values[0]) ? values[0] : null;
}

export function navigateToAdminProductEditor(id: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set("section", "products");
  url.searchParams.set("editor", id);
  const href = `${url.pathname}${url.search}${url.hash}`;
  const currentHref = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (currentHref === href) return;
  window.history.pushState(null, "", href);
  window.dispatchEvent(new Event(SECTION_CHANGE_EVENT));
}

export type ProductEditorSession = Readonly<{
  id: string;
  mode: "create" | "edit";
  draft: AdminProductDraft;
  imageFile: File | null;
  objectUrl: string | null;
}>;

/** 초안·파일은 이 워크스페이스 메모리에만 둡니다. URL에는 무작위 ID만 둡니다. */
export class ProductEditorSessions {
  private readonly sessions = new Map<string, ProductEditorSession>();
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly createId = () => crypto.randomUUID(),
    private readonly releaseObjectUrl = (url: string) => URL.revokeObjectURL(url),
  ) {}

  getSnapshot = (): ProductEditorSession | null => {
    const id = getAdminProductEditorId();
    return id ? (this.sessions.get(id) ?? null) : null;
  };

  getServerSnapshot = (): null => null;

  subscribe = (onChange: () => void): (() => void) => {
    this.listeners.add(onChange);
    const unsubscribe = subscribeToAdminSection(onChange);
    return () => {
      this.listeners.delete(onChange);
      unsubscribe();
    };
  };

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  open(mode: "create" | "edit", draft: AdminProductDraft): string {
    while (this.sessions.size >= PRODUCT_EDITOR_SESSION_LIMIT) {
      const oldest = this.sessions.keys().next().value;
      if (oldest) this.remove(oldest);
    }
    const id = this.createId();
    this.sessions.set(id, {
      id,
      mode,
      draft: { ...draft },
      imageFile: null,
      objectUrl: null,
    });
    return id;
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  updateDraft(
    id: string,
    update: (draft: AdminProductDraft) => AdminProductDraft,
  ): void {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.set(id, { ...session, draft: update(session.draft) });
    this.emit();
  }

  setImage(id: string, imageFile: File, objectUrl: string): void {
    const session = this.sessions.get(id);
    if (!session) {
      this.releaseObjectUrl(objectUrl);
      return;
    }
    if (session.objectUrl) this.releaseObjectUrl(session.objectUrl);
    this.sessions.set(id, {
      ...session,
      imageFile,
      objectUrl,
      draft: { ...session.draft, imageUrl: objectUrl },
    });
    this.emit();
  }

  finishImageUpload(id: string, imageUrl: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    if (session.objectUrl) this.releaseObjectUrl(session.objectUrl);
    this.sessions.set(id, {
      ...session,
      imageFile: null,
      objectUrl: null,
      draft: { ...session.draft, imageUrl },
    });
    this.emit();
  }

  reset(id: string, emptyDraft: AdminProductDraft): void {
    const session = this.sessions.get(id);
    if (!session) return;
    if (session.objectUrl) this.releaseObjectUrl(session.objectUrl);
    this.sessions.set(id, {
      ...session,
      imageFile: null,
      objectUrl: null,
      draft: {
        ...emptyDraft,
        ...(session.mode === "edit"
          ? { productId: session.draft.productId, version: session.draft.version }
          : {}),
      },
    });
    this.emit();
  }

  remove(id: string): void {
    const session = this.sessions.get(id);
    if (session?.objectUrl) this.releaseObjectUrl(session.objectUrl);
    this.sessions.delete(id);
    this.emit();
  }

  invalidateProducts(productIds: ReadonlySet<string>): void {
    for (const session of this.sessions.values()) {
      if (session.draft.productId && productIds.has(session.draft.productId))
        this.remove(session.id);
    }
  }

  dispose(): void {
    for (const session of this.sessions.values()) {
      if (session.objectUrl) this.releaseObjectUrl(session.objectUrl);
    }
    this.sessions.clear();
    this.emit();
  }
}
