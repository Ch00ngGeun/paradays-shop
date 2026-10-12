import { describe, expect, it } from "vitest";

import {
  AUTH_SESSION_STORAGE_KEY,
  clearPersistedAuthSession,
  persistAuthSession,
  readPersistedAuthSession,
  type InMemoryAuthSession,
} from "@/lib/auth/cognito-client";

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();

  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.has(key) ? (values.get(key) ?? null) : null;
    },
    key(index: number) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
}

describe("auth session persistence", () => {
  it("restores a session from sessionStorage after clear of in-memory state", () => {
    const storage = createMemoryStorage();
    const session: InMemoryAuthSession = {
      accessToken: "access-token",
      expiresAt: Date.now() + 60_000,
      user: {
        sub: "sub-1",
        username: "tester",
        groups: ["admin"],
        email: "tester@example.com",
      },
    };

    persistAuthSession(storage, session);

    expect(storage.getItem(AUTH_SESSION_STORAGE_KEY)).toContain("access-token");

    const restored = readPersistedAuthSession(storage);

    expect(restored?.user.username).toBe("tester");
    expect(restored?.user.groups).toEqual(["admin"]);
    expect(restored?.accessToken).toBe("access-token");
  });

  it("clears persisted session on logout", () => {
    const storage = createMemoryStorage();
    const session: InMemoryAuthSession = {
      accessToken: "access-token",
      expiresAt: Date.now() + 60_000,
      user: {
        sub: "sub-1",
        username: "tester",
        groups: [],
      },
    };

    persistAuthSession(storage, session);
    clearPersistedAuthSession(storage);

    expect(readPersistedAuthSession(storage)).toBeNull();
  });
});
