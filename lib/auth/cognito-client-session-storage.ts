// 역할: 탭 복원용으로 저장된 인증 세션 JSON을 검증·복원하고 localStorage 접근을 감쌉니다.
import {
  AUTH_SESSION_STORAGE_KEY,
  type AuthenticatedUser,
  type InMemoryAuthSession,
  type SessionStorageLike,
} from "@/lib/auth/cognito-client";

function isAuthenticatedUser(value: unknown): value is AuthenticatedUser {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;

  return (
    typeof record.sub === "string" &&
    record.sub.length > 0 &&
    typeof record.username === "string" &&
    record.username.length > 0 &&
    Array.isArray(record.groups) &&
    record.groups.every((group) => typeof group === "string") &&
    (record.email === undefined || typeof record.email === "string") &&
    (record.displayName === undefined || typeof record.displayName === "string")
  );
}

function isInMemoryAuthSession(value: unknown): value is InMemoryAuthSession {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;

  return (
    typeof record.accessToken === "string" &&
    record.accessToken.length > 0 &&
    typeof record.expiresAt === "number" &&
    Number.isFinite(record.expiresAt) &&
    isAuthenticatedUser(record.user)
  );
}

export function parseStoredAuthSession(
  raw: string | null,
  storage: SessionStorageLike | null,
  now: number,
): InMemoryAuthSession | null {
  if (!raw) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(raw);

    if (!isInMemoryAuthSession(parsed) || parsed.expiresAt <= now) {
      if (storage) {
        try {
          storage.removeItem(AUTH_SESSION_STORAGE_KEY);
        } catch {
          // ignore
        }
      }

      return null;
    }

    return {
      accessToken: parsed.accessToken,
      expiresAt: parsed.expiresAt,
      user: {
        sub: parsed.user.sub,
        username: parsed.user.username,
        groups: [...parsed.user.groups],
        ...(parsed.user.email ? { email: parsed.user.email } : {}),
        ...(parsed.user.displayName ? { displayName: parsed.user.displayName } : {}),
      },
    };
  } catch {
    if (storage) {
      try {
        storage.removeItem(AUTH_SESSION_STORAGE_KEY);
      } catch {
        // ignore
      }
    }

    return null;
  }
}

export function getLocalStorage(): SessionStorageLike | null {
  try {
    if (typeof window === "undefined") {
      return null;
    }

    return window.localStorage;
  } catch {
    return null;
  }
}
