// 역할: Cognito 공개 설정이 API 전용 access-token scope를 빠뜨리지 않는지 검증합니다.
import { describe, expect, it } from "vitest";

import { getCognitoConfiguration } from "@/lib/auth/cognito-config";

/** 테스트마다 Cognito 공개 환경값의 유효한 공통 부분을 재사용합니다. */
const baseEnvironment = {
  domain: "https://paradays.auth.ap-northeast-2.amazoncognito.com",
  clientId: "example-public-client-id",
  redirectUri: "http://localhost:3010/auth/callback",
  logoutUri: "http://localhost:3010",
};

describe("getCognitoConfiguration", () => {
  it("scope를 생략해도 access token 전용 commerce scope를 기본 요청함", () => {
    const configuration = getCognitoConfiguration(baseEnvironment);

    expect(configuration).toEqual({
      available: true,
      config: {
        ...baseEnvironment,
        scopes: ["openid", "email", "profile", "paradays-commerce/api"],
      },
    });
  });

  it("명시 scope에서도 openid를 보강하면서 commerce scope를 유지함", () => {
    const configuration = getCognitoConfiguration({
      ...baseEnvironment,
      scopes: "email,paradays-commerce/api",
    });

    expect(configuration).toEqual({
      available: true,
      config: {
        ...baseEnvironment,
        scopes: ["openid", "email", "paradays-commerce/api"],
      },
    });
  });

  it("logout URI의 trailing slash를 Cognito allowlist에 맞게 제거함", () => {
    const configuration = getCognitoConfiguration({
      ...baseEnvironment,
      logoutUri: "http://localhost:3010/",
    });

    expect(configuration.available).toBe(true);
    if (configuration.available) {
      expect(configuration.config.logoutUri).toBe("http://localhost:3010");
    }
  });
});
