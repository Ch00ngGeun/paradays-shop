/**
 * 역할: API Gateway HTTP API용 상거래 Lambda handler가 함께 쓰는 공통 JSON 응답을 만듦.
 * 기능: 호출자가 넘긴 상태 코드·body에 JSON Content-Type과 직렬화를 적용함.
 */

import type { APIGatewayProxyResultV2 } from "aws-lambda";

/** 전달받은 body를 JSON 문자열로 직렬화해 지정한 상태 코드로 반환함. */
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
