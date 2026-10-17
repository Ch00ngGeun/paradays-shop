// 역할: 공개 메뉴 필터 ID만 탭 세션에 보관해 전체 문서 이동 뒤에도 복원합니다.
import {
  BRAND_FILTER_IDS,
  CLOTHES_FILTER_IDS,
  SKATE_FILTER_IDS,
} from "@/lib/catalog-filter";

export const CATALOG_FILTER_SESSION_KEY = "paradays:catalog-filters:v1";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const FILTER_GROUPS = [
  { ids: CLOTHES_FILTER_IDS, all: "clothes-all" },
  { ids: SKATE_FILTER_IDS, all: "skateboard-all" },
  { ids: BRAND_FILTER_IDS, all: "brand-all" },
] as const;
const ALLOWED_IDS = new Set<string>([
  ...CLOTHES_FILTER_IDS,
  ...SKATE_FILTER_IDS,
  ...BRAND_FILTER_IDS,
  "sale",
]);
const MAX_SESSION_LENGTH = 4_096;

function validateIds(value: unknown): Set<string> | null {
  if (
    !Array.isArray(value) ||
    value.length > ALLOWED_IDS.size ||
    !value.every((id) => typeof id === "string" && ALLOWED_IDS.has(id))
  ) {
    return null;
  }

  const ids = new Set<string>(value);
  if (ids.size !== value.length) return null;
  for (const group of FILTER_GROUPS) {
    if (ids.has(group.all) && group.ids.some((id) => id !== group.all && ids.has(id)))
      return null;
  }
  return ids;
}

/** 초기 빈 값을 덮어쓰지 않고 검증된 공개 메뉴 ID만 읽습니다. */
export function readCatalogFilterSession(
  storage: StorageLike | null = getSessionStorage(),
): Set<string> {
  if (!storage) return new Set();

  try {
    const raw = storage.getItem(CATALOG_FILTER_SESSION_KEY);
    if (!raw || raw.length > MAX_SESSION_LENGTH) return new Set();
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return new Set();
    const record = parsed as Record<string, unknown>;
    if (
      record.version !== 1 ||
      Object.keys(record).length !== 2 ||
      !Object.hasOwn(record, "selectedIds")
    ) {
      return new Set();
    }
    return validateIds(record.selectedIds) ?? new Set();
  } catch {
    return new Set();
  }
}

/** 사용자 조작만 동기 저장하고 All/clear는 필터 키 하나만 삭제합니다. */
export function writeCatalogFilterSession(
  selectedIds: ReadonlySet<string>,
  storage: StorageLike | null = getSessionStorage(),
): void {
  if (!storage) return;
  const validated = validateIds([...selectedIds]);
  if (!validated) return;

  try {
    if (validated.size === 0) {
      storage.removeItem(CATALOG_FILTER_SESSION_KEY);
    } else {
      storage.setItem(
        CATALOG_FILTER_SESSION_KEY,
        JSON.stringify({ version: 1, selectedIds: [...validated].sort() }),
      );
    }
  } catch {
    // 저장소가 차단되거나 가득 차도 현재 화면의 메모리 필터는 계속 사용합니다.
  }
}

function getSessionStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}
