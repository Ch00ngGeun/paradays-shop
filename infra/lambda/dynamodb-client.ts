/**
 * 역할: Lambda가 DynamoDB Document API를 공유해서 사용하도록 연결함.
 * 기능: 숫자·객체를 자연스러운 JavaScript 값으로 읽고 undefined 값 저장을 차단함.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

/** Lambda 컨테이너 재사용 시 DynamoDB 클라이언트도 재사용합니다. */
const dynamoDbClient = new DynamoDBClient({});

/** DynamoDB의 undefined marshalling을 막아 조건식·부분 업데이트 오작동을 예방합니다. */
export const documentClient = DynamoDBDocumentClient.from(dynamoDbClient, {
  marshallOptions: { removeUndefinedValues: true },
});

/** 환경변수 누락을 초기화 단계의 공개 가능한 운영 오류로 바꿉니다. */
export function getRequiredEnvironment(name: string) {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`MISSING_REQUIRED_ENVIRONMENT:${name}`);
  }

  return value;
}
