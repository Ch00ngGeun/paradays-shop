/**
 * 역할: API Gateway HTTP API용 Lambda placeholder의 공통 JSON 응답을 만듦.
 * 기능: 민감한 내부 오류·PG payload를 노출하지 않는 일관된 응답 형식을 제공함.
 */

import type { APIGatewayProxyResultV2 } from "aws-lambda";

/** 공개 가능한 오류 코드와 메시지만 반환하도록 JSON 응답을 생성함. */
export function jsonResponse(
  statusCode: number,
  body: Record<string, unknown>,
): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  };
}
