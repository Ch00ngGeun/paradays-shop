/**
 * 역할: 관리자 전용 Lambda가 Cognito JWT group claim을 같은 방식으로 검증하게 함.
 * 기능: 브라우저의 화면 숨김과 무관하게 API 경계에서 admin group과 subject를 확인함.
 *
 * Cognito access token에는 기본적으로 `cognito:groups`가 없음(ID token에만 있음).
 * claim이 비어 있으면 Cognito AdminListGroupsForUser로 서버에서 재검증함.
 */

import {
  AdminListGroupsForUserCommand,
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";

import { getUserSub } from "./request-helpers.js";

const cognitoClient = new CognitoIdentityProviderClient({});

/** 관리자 handler가 안전하게 분기할 수 있는 인증 결과입니다. */
export type AdminAuthorization =
  | Readonly<{ ok: true; userSub: string }>
  | Readonly<{
      ok: false;
      statusCode: 401 | 403;
      code: "UNAUTHORIZED" | "ADMIN_ROLE_REQUIRED";
    }>;

/** Cognito group claim이 배열·comma 문자열·JSON 배열 문자열인 경우를 엄격히 처리합니다. */
export function isAdminGroupClaim(claim: unknown): boolean {
  return readGroupNames(claim).some((groupName) => groupName === "admin");
}

/**
 * API Gateway가 검증한 JWT에서 subject를 읽고,
 * claim 또는 Cognito 그룹 조회로 admin 여부를 확인합니다.
 */
export async function authorizeAdmin(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<AdminAuthorization> {
  const userSub = getUserSub(event);

  if (!userSub) {
    return { ok: false, statusCode: 401, code: "UNAUTHORIZED" };
  }

  const groupsClaim =
    event.requestContext.authorizer.jwt.claims["cognito:groups"];

  if (isAdminGroupClaim(groupsClaim)) {
    return { ok: true, userSub };
  }

  const username = readUsernameClaim(event);
  const userPoolId = process.env.USER_POOL_ID?.trim();

  if (!username || !userPoolId) {
    return { ok: false, statusCode: 403, code: "ADMIN_ROLE_REQUIRED" };
  }

  try {
    const response = await cognitoClient.send(
      new AdminListGroupsForUserCommand({
        UserPoolId: userPoolId,
        Username: username,
      }),
    );
    const isAdmin = (response.Groups ?? []).some(
      (group) => group.GroupName === "admin",
    );

    if (isAdmin) {
      return { ok: true, userSub };
    }
  } catch {
    return { ok: false, statusCode: 403, code: "ADMIN_ROLE_REQUIRED" };
  }

  return { ok: false, statusCode: 403, code: "ADMIN_ROLE_REQUIRED" };
}

/** Access·ID token에서 Cognito username claim만 읽습니다. */
function readUsernameClaim(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): string | undefined {
  const claims = event.requestContext.authorizer.jwt.claims;

  for (const key of ["username", "cognito:username"] as const) {
    const value = claims[key];

    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return undefined;
}

/** claim의 느슨한 부분 문자열 비교를 피하고 정확히 일치하는 group 이름만 반환합니다. */
function readGroupNames(claim: unknown): string[] {
  if (Array.isArray(claim)) {
    return claim
      .filter(
        (value): value is string => typeof value === "string" && Boolean(value.trim()),
      )
      .map((value) => value.trim());
  }

  if (typeof claim !== "string" || !claim.trim()) {
    return [];
  }

  const normalizedClaim = claim.trim();

  if (normalizedClaim.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(normalizedClaim);

      if (Array.isArray(parsed)) {
        return parsed
          .filter(
            (value): value is string =>
              typeof value === "string" && Boolean(value.trim()),
          )
          .map((value) => value.trim());
      }
    } catch {
      return [];
    }
  }

  return normalizedClaim
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}
