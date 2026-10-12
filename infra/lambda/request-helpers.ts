/**
 * 역할: API Gateway HTTP API 이벤트에서 JSON body·헤더·JWT claim을 안전하게 읽음.
 * 기능: Lambda handler마다 반복될 파싱·정규화 코드를 한 곳으로 모아 민감값 로그를 피함.
 */

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyEventV2WithJWTAuthorizer,
} from "aws-lambda";

/** JSON body가 없거나 파싱할 수 없을 때 handler가 400을 반환하도록 null을 반환합니다. */
export function parseJsonBody(event: APIGatewayProxyEventV2): unknown | null {
  if (!event.body) {
    return null;
  }

  try {
    const body = event.isBase64Encoded
      ? Buffer.from(event.body, "base64").toString("utf8")
      : event.body;

    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

/** HTTP API header의 대소문자 차이를 흡수해 공개 입력을 읽습니다. */
export function getHeader(
  event: Pick<APIGatewayProxyEventV2, "headers">,
  name: string,
) {
  const normalizedName = name.toLowerCase();
  const header = Object.entries(event.headers).find(
    ([key]) => key.toLowerCase() === normalizedName,
  )?.[1];

  return header?.trim() || undefined;
}

/** Cognito JWT authorizer가 검증한 불변 사용자 subject만 반환합니다. */
export function getUserSub(event: APIGatewayProxyEventV2WithJWTAuthorizer) {
  const sub = event.requestContext.authorizer.jwt.claims.sub;

  return typeof sub === "string" && sub.trim() ? sub : undefined;
}

/** Cognito JWT의 이메일 claim은 표시용 보조 정보로만 읽습니다. */
export function getUserEmail(event: APIGatewayProxyEventV2WithJWTAuthorizer) {
  const email = event.requestContext.authorizer.jwt.claims.email;

  return typeof email === "string" && email.trim() ? email.trim() : undefined;
}

/** unknown JSON 객체를 handler에서 키별 검증할 수 있게 좁힙니다. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 문자열 값의 공백·길이를 같이 검증해 storage key에 그대로 쓰지 않게 합니다. */
export function readBoundedString(
  value: unknown,
  maximumLength: number,
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalizedValue = value.trim();

  return normalizedValue && normalizedValue.length <= maximumLength
    ? normalizedValue
    : undefined;
}
