import { afterEach, describe, expect, it, vi } from "vitest";

describe("isFirebasePhoneAuthAvailable", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("stays off when only public Firebase env exists", async () => {
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_API_KEY", "test-key");
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN", "example.firebaseapp.com");
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_PROJECT_ID", "example");
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_APP_ID", "1:123:web:abc");
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_PHONE_AUTH_ENABLED", "");

    const { isFirebasePhoneAuthAvailable, isFirebasePhoneAuthEnabled } = await import(
      "@/lib/auth/firebase-phone-auth"
    );

    expect(isFirebasePhoneAuthEnabled()).toBe(false);
    expect(isFirebasePhoneAuthAvailable()).toBe(false);
  });

  it("requires an explicit enable flag in addition to public config", async () => {
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_API_KEY", "test-key");
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN", "example.firebaseapp.com");
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_PROJECT_ID", "example");
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_APP_ID", "1:123:web:abc");
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_PHONE_AUTH_ENABLED", "true");

    const { isFirebasePhoneAuthAvailable, isFirebasePhoneAuthEnabled } = await import(
      "@/lib/auth/firebase-phone-auth"
    );

    expect(isFirebasePhoneAuthEnabled()).toBe(true);
    expect(isFirebasePhoneAuthAvailable()).toBe(true);
  });
});
