import { describe, expect, it } from "vitest";

import {
  confirmForgotPassword,
  forgotPassword,
  isValidKoreanPhoneNumber,
  normalizeKoreanPhoneNumber,
} from "@/lib/auth/cognito-direct-auth";
import type { CognitoAuthConfig } from "@/lib/auth/cognito-config";

const testConfig: CognitoAuthConfig = {
  domain: "https://example.auth.ap-northeast-2.amazoncognito.com",
  clientId: "public-client-id",
  redirectUri: "http://localhost:3010/auth/callback",
  logoutUri: "http://localhost:3010",
  scopes: ["openid", "email"],
  issuer: "https://cognito-idp.ap-northeast-2.amazonaws.com/ap-northeast-2_example",
};

describe("normalizeKoreanPhoneNumber", () => {
  it("converts local mobile numbers to E.164", () => {
    expect(normalizeKoreanPhoneNumber("010-1234-5678")).toBe("+821012345678");
    expect(normalizeKoreanPhoneNumber("01012345678")).toBe("+821012345678");
  });

  it("accepts already international numbers", () => {
    expect(normalizeKoreanPhoneNumber("+82 10 1234 5678")).toBe("+821012345678");
  });

  it("rejects invalid values", () => {
    expect(isValidKoreanPhoneNumber("123")).toBe(false);
    expect(normalizeKoreanPhoneNumber("")).toBeNull();
  });
});

describe("Cognito email password recovery", () => {
  it("uses only the signup email for ForgotPassword and ConfirmForgotPassword", async () => {
    const calls: RequestInit[] = [];
    const fetcher = async (_input: string, init: RequestInit) => {
      calls.push(init);

      return new Response(JSON.stringify({}), { status: 200 });
    };

    await forgotPassword({
      config: testConfig,
      email: "skater@example.com",
      fetcher,
    });
    await confirmForgotPassword({
      config: testConfig,
      email: "skater@example.com",
      code: " 123456 ",
      newPassword: "Valid-password-123!",
      fetcher,
    });

    expect(calls).toHaveLength(2);
    expect(calls[0].headers).toMatchObject({
      "X-Amz-Target": "AWSCognitoIdentityProviderService.ForgotPassword",
    });
    expect(JSON.parse(String(calls[0].body))).toEqual({
      ClientId: "public-client-id",
      Username: "skater@example.com",
    });
    expect(calls[1].headers).toMatchObject({
      "X-Amz-Target": "AWSCognitoIdentityProviderService.ConfirmForgotPassword",
    });
    expect(JSON.parse(String(calls[1].body))).toEqual({
      ClientId: "public-client-id",
      Username: "skater@example.com",
      ConfirmationCode: "123456",
      Password: "Valid-password-123!",
    });
  });
});
