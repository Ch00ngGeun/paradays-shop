// 역할: 가입·로그인 폼 유효성 규칙을 검증함.
import { describe, expect, it } from "vitest";

import {
  getPasswordRuleStates,
  isValidEmail,
  isValidLoginIdentifier,
  isValidPassword,
  normalizeEmail,
  normalizeLoginIdentifier,
  passwordsMatch,
} from "@/lib/auth/form-validation";

describe("auth form-validation", () => {
  it("normalizes email case and whitespace", () => {
    expect(normalizeEmail("  Foo@PARADAYS.com ")).toBe("foo@paradays.com");
    expect(isValidEmail("  Foo@PARADAYS.com ")).toBe(true);
    expect(isValidEmail("not-an-email")).toBe(false);
  });

  it("normalizes login ID with default gmail domain", () => {
    expect(normalizeLoginIdentifier("choong1385")).toBe("choong1385@gmail.com");
    expect(normalizeLoginIdentifier("Choong1385@Gmail.com")).toBe(
      "choong1385@gmail.com",
    );
    expect(isValidLoginIdentifier("choong1385")).toBe(true);
    expect(isValidLoginIdentifier("bad@")).toBe(false);
  });

  it("enforces password policy", () => {
    expect(isValidPassword("Abcd1234!xyz")).toBe(true);
    expect(isValidPassword("Abcd123!")).toBe(false);
    expect(isValidPassword("short1!")).toBe(false);
    expect(getPasswordRuleStates("Abcd1234!xyz").every((rule) => rule.met)).toBe(
      true,
    );
    expect(passwordsMatch("Abcd1234!xyz", "Abcd1234!xyz")).toBe(true);
    expect(passwordsMatch("Abcd1234!xyz", "Abcd1234!xyZ")).toBe(false);
  });
});
