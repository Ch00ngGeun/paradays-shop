/**
 * 역할: Cognito 자격증명과 분리된 쇼핑몰 회원 프로필을 조회·수정함.
 * 기능: JWT subject로 자기 프로필만 읽고, 허용된 표시명·연락처·마케팅 동의만 DynamoDB에 저장함.
 */

import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from "aws-lambda";

import { documentClient, getRequiredEnvironment } from "./dynamodb-client.js";
import { jsonResponse } from "./http-response.js";
import {
  getUserEmail,
  getUserSub,
  isRecord,
  parseJsonBody,
  readBoundedString,
} from "./request-helpers.js";

/** UI·API로 반환하는 주문 도메인 전용 회원 프로필입니다. 비밀번호·토큰은 Cognito 밖으로 나오지 않습니다. */
type MemberProfile = Readonly<{
  userSub: string;
  email?: string;
  displayName?: string;
  phoneNumber?: string;
  marketingConsent: boolean;
  createdAt?: string;
  updatedAt?: string;
}>;

/** PATCH body에서 실제로 변경 가능한 회원 도메인 필드입니다. */
type ProfileUpdate = {
  displayName?: string;
  phoneNumber?: string;
  marketingConsent?: boolean;
};

/** GET/PATCH /me: 인증된 자기 프로필만 조회·수정합니다. */
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> {
  const userSub = getUserSub(event);

  if (!userSub) {
    return jsonResponse(401, { code: "UNAUTHORIZED" });
  }

  let profileTableName: string;

  try {
    profileTableName = getRequiredEnvironment("PROFILE_TABLE_NAME");
  } catch {
    return jsonResponse(503, { code: "PROFILE_CONFIGURATION_UNAVAILABLE" });
  }

  if (event.requestContext.http.method === "GET") {
    const profile = await getProfile(profileTableName, userSub);

    if (profile === undefined) {
      return jsonResponse(503, { code: "PROFILE_STORAGE_UNAVAILABLE" });
    }

    return jsonResponse(200, toPublicProfile(profile, userSub, getUserEmail(event)));
  }

  if (event.requestContext.http.method !== "PATCH") {
    return jsonResponse(405, { code: "METHOD_NOT_ALLOWED" });
  }

  const body = parseJsonBody(event);
  const update = parseProfileUpdate(body);

  if (!update) {
    return jsonResponse(400, { code: "PROFILE_UPDATE_INVALID" });
  }

  const profile = await updateProfile({
    profileTableName,
    userSub,
    email: getUserEmail(event),
    update,
  });

  if (!profile) {
    return jsonResponse(503, { code: "PROFILE_STORAGE_UNAVAILABLE" });
  }

  return jsonResponse(200, toPublicProfile(profile, userSub, getUserEmail(event)));
}

/** 현재 회원의 profile table 행을 strong read로 읽습니다. undefined는 저장소 오류, null은 미생성 회원입니다. */
async function getProfile(profileTableName: string, userSub: string) {
  try {
    const response = await documentClient.send(
      new GetCommand({
        TableName: profileTableName,
        Key: { userSub },
        ConsistentRead: true,
      }),
    );

    return isMemberProfile(response.Item) ? response.Item : null;
  } catch {
    return undefined;
  }
}

/** 허용된 회원 필드만 받은 patch 요청을 구문·길이·전화번호 형식으로 검증합니다. */
function parseProfileUpdate(body: unknown) {
  if (!isRecord(body)) {
    return null;
  }

  const update: ProfileUpdate = {};

  if ("displayName" in body) {
    const displayName = readBoundedString(body.displayName, 80);

    if (!displayName) {
      return null;
    }

    update.displayName = displayName;
  }

  if ("phoneNumber" in body) {
    const phoneNumber = readBoundedString(body.phoneNumber, 32);

    if (!phoneNumber || !/^\+?[0-9()\-\s]{7,32}$/.test(phoneNumber)) {
      return null;
    }

    update.phoneNumber = phoneNumber;
  }

  if ("marketingConsent" in body) {
    if (typeof body.marketingConsent !== "boolean") {
      return null;
    }

    update.marketingConsent = body.marketingConsent;
  }

  return Object.keys(update).length > 0 ? update : null;
}

/** profile row가 없으면 생성하고, PATCH에 포함된 필드만 원자적으로 갱신합니다. */
async function updateProfile({
  profileTableName,
  userSub,
  email,
  update,
}: Readonly<{
  profileTableName: string;
  userSub: string;
  email?: string;
  update: ProfileUpdate;
}>): Promise<MemberProfile | null> {
  const timestamp = new Date().toISOString();
  const expressionAttributeNames: Record<string, string> = {};
  const expressionAttributeValues: Record<string, unknown> = {
    ":createdAt": timestamp,
    ":updatedAt": timestamp,
  };
  const setExpressions = [
    "createdAt = if_not_exists(createdAt, :createdAt)",
    "updatedAt = :updatedAt",
  ];

  if (email) {
    expressionAttributeValues[":email"] = email;
    setExpressions.push("email = if_not_exists(email, :email)");
  }

  for (const [field, value] of Object.entries(update)) {
    const nameToken = `#${field}`;
    const valueToken = `:${field}`;

    expressionAttributeNames[nameToken] = field;
    expressionAttributeValues[valueToken] = value;
    setExpressions.push(`${nameToken} = ${valueToken}`);
  }

  try {
    const response = await documentClient.send(
      new UpdateCommand({
        TableName: profileTableName,
        Key: { userSub },
        UpdateExpression: `SET ${setExpressions.join(", ")}`,
        ExpressionAttributeNames:
          Object.keys(expressionAttributeNames).length > 0
            ? expressionAttributeNames
            : undefined,
        ExpressionAttributeValues: expressionAttributeValues,
        ReturnValues: "ALL_NEW",
      }),
    );

    return isMemberProfile(response.Attributes) ? response.Attributes : null;
  } catch {
    return null;
  }
}

/** 테이블에 아직 행이 없을 때도 Cognito 이메일을 포함한 동일한 공개 profile shape를 만듭니다. */
function toPublicProfile(
  profile: MemberProfile | null,
  userSub: string,
  email?: string,
) {
  return {
    userSub,
    ...(email ? { email } : profile?.email ? { email: profile.email } : {}),
    ...(profile?.displayName ? { displayName: profile.displayName } : {}),
    ...(profile?.phoneNumber ? { phoneNumber: profile.phoneNumber } : {}),
    marketingConsent: profile?.marketingConsent ?? false,
    ...(profile?.createdAt ? { createdAt: profile.createdAt } : {}),
    ...(profile?.updatedAt ? { updatedAt: profile.updatedAt } : {}),
  } satisfies MemberProfile;
}

/** DynamoDB item이 프로필 테이블의 예상 형식인지 안전하게 좁힙니다. */
function isMemberProfile(value: unknown): value is MemberProfile {
  return (
    isRecord(value) &&
    typeof value.userSub === "string" &&
    (value.email === undefined || typeof value.email === "string") &&
    (value.displayName === undefined || typeof value.displayName === "string") &&
    (value.phoneNumber === undefined || typeof value.phoneNumber === "string") &&
    (value.marketingConsent === undefined ||
      typeof value.marketingConsent === "boolean") &&
    (value.createdAt === undefined || typeof value.createdAt === "string") &&
    (value.updatedAt === undefined || typeof value.updatedAt === "string")
  );
}
