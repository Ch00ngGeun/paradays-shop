/**
 * 역할: Cognito 회원 목록과 운영 그룹을 관리자 전용 API로 제한합니다.
 * 기능: admin group을 서버에서 확인한 뒤 필요한 최소 회원 속성·admin/support 그룹만 관리합니다.
 */

import {
  AdminAddUserToGroupCommand,
  AdminGetUserCommand,
  AdminListGroupsForUserCommand,
  AdminRemoveUserFromGroupCommand,
  CognitoIdentityProviderClient,
  ListUsersCommand,
  type AttributeType,
} from "@aws-sdk/client-cognito-identity-provider";
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from "aws-lambda";

import { authorizeAdmin } from "./admin-auth.js";
import { getRequiredEnvironment } from "./dynamodb-client.js";
import { jsonResponse } from "./http-response.js";
import { isRecord, parseJsonBody, readBoundedString } from "./request-helpers.js";

/** 한 요청이 Cognito에 부과하는 그룹 조회 호출 수를 제한합니다. */
const MAX_PAGE_SIZE = 50;
const MANAGEABLE_GROUPS = new Set(["admin", "support"]);
const cognitoClient = new CognitoIdentityProviderClient({});

type MemberSummary = Readonly<{
  username: string;
  userSub?: string;
  email?: string;
  displayName?: string;
  enabled: boolean;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
  groups: readonly string[];
}>;

/** GET /admin/members, POST|DELETE /admin/members/{username}/groups. */
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> {
  const authorization = await authorizeAdmin(event);

  if (!authorization.ok) {
    return jsonResponse(authorization.statusCode, { code: authorization.code });
  }

  let userPoolId: string;

  try {
    userPoolId = getRequiredEnvironment("USER_POOL_ID");
  } catch {
    return jsonResponse(503, { code: "MEMBER_CONFIGURATION_UNAVAILABLE" });
  }

  const method = event.requestContext.http.method;

  if (method === "GET" && !event.pathParameters?.username) {
    return listMembers(event, userPoolId);
  }

  const username = readBoundedString(event.pathParameters?.username, 128);

  if (!username) {
    return jsonResponse(400, { code: "MEMBER_USERNAME_INVALID" });
  }

  if (method === "POST") {
    return addMemberToGroup(event, userPoolId, username);
  }

  if (method === "DELETE") {
    return removeMemberFromGroup(event, userPoolId, username, authorization.userSub);
  }

  return jsonResponse(405, { code: "MEMBER_METHOD_NOT_ALLOWED" });
}

/** Cognito 목록과 각 회원의 관리 가능한 그룹만 병렬로 읽습니다. */
async function listMembers(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
  userPoolId: string,
): Promise<APIGatewayProxyResultV2> {
  const limit = readPageLimit(event.queryStringParameters?.limit);
  const paginationToken = readPaginationToken(
    event.queryStringParameters?.nextPageToken,
  );

  if (paginationToken === null) {
    return jsonResponse(400, { code: "MEMBER_PAGE_TOKEN_INVALID" });
  }

  try {
    const response = await cognitoClient.send(
      new ListUsersCommand({
        UserPoolId: userPoolId,
        Limit: limit,
        ...(paginationToken ? { PaginationToken: paginationToken } : {}),
      }),
    );
    const members = await Promise.all(
      (response.Users ?? []).map(async (user): Promise<MemberSummary | null> => {
        if (!user.Username) {
          return null;
        }

        const groups = await getManageableGroups(userPoolId, user.Username);

        return toMemberSummary(user.Username, user.Attributes ?? [], {
          enabled: user.Enabled ?? false,
          status: user.UserStatus,
          createdAt: user.UserCreateDate?.toISOString(),
          updatedAt: user.UserLastModifiedDate?.toISOString(),
          groups,
        });
      }),
    );

    return jsonResponse(200, {
      members: members.filter((member): member is MemberSummary => member !== null),
      ...(response.PaginationToken ? { nextPageToken: response.PaginationToken } : {}),
    });
  } catch {
    return jsonResponse(502, { code: "MEMBER_PROVIDER_REQUEST_FAILED" });
  }
}

/** 운영자가 요청한 admin/support 그룹만 부여합니다. */
async function addMemberToGroup(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
  userPoolId: string,
  username: string,
): Promise<APIGatewayProxyResultV2> {
  const group = readGroupFromBody(event);

  if (!group) {
    return jsonResponse(400, { code: "MEMBER_GROUP_INVALID" });
  }

  try {
    await cognitoClient.send(
      new AdminAddUserToGroupCommand({
        UserPoolId: userPoolId,
        Username: username,
        GroupName: group,
      }),
    );

    return jsonResponse(200, { username, group, action: "ADDED" });
  } catch {
    return jsonResponse(502, { code: "MEMBER_GROUP_UPDATE_FAILED" });
  }
}

/**
 * 현재 요청을 보낸 admin 본인의 admin 그룹 제거를 막습니다.
 * Cognito의 Username은 sub와 다를 수 있으므로, 대상 사용자의 immutable sub를 조회해 비교합니다.
 */
async function removeMemberFromGroup(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
  userPoolId: string,
  username: string,
  requestingUserSub: string,
): Promise<APIGatewayProxyResultV2> {
  const group = readGroupFromBody(event);

  if (!group) {
    return jsonResponse(400, { code: "MEMBER_GROUP_INVALID" });
  }

  if (group === "admin") {
    let targetUserSub: string | undefined;

    try {
      targetUserSub = await getUserSub(userPoolId, username);
    } catch {
      // admin 권한 제거는 대상 식별을 검증할 수 없을 때 fail closed로 처리합니다.
      return jsonResponse(502, { code: "MEMBER_TARGET_VERIFICATION_FAILED" });
    }

    if (!targetUserSub) {
      return jsonResponse(502, { code: "MEMBER_TARGET_VERIFICATION_FAILED" });
    }

    if (targetUserSub === requestingUserSub) {
      return jsonResponse(409, { code: "MEMBER_SELF_ADMIN_REMOVAL_DENIED" });
    }
  }

  try {
    await cognitoClient.send(
      new AdminRemoveUserFromGroupCommand({
        UserPoolId: userPoolId,
        Username: username,
        GroupName: group,
      }),
    );

    return jsonResponse(200, { username, group, action: "REMOVED" });
  } catch {
    return jsonResponse(502, { code: "MEMBER_GROUP_UPDATE_FAILED" });
  }
}

/** Cognito가 해석한 대상 사용자의 immutable sub만 가져옵니다. */
async function getUserSub(userPoolId: string, username: string) {
  const response = await cognitoClient.send(
    new AdminGetUserCommand({ UserPoolId: userPoolId, Username: username }),
  );

  return response.UserAttributes?.find((attribute) => attribute.Name === "sub")?.Value;
}

/** Cognito group을 가져온 뒤 관리 화면에 필요한 두 그룹만 보존합니다. */
async function getManageableGroups(userPoolId: string, username: string) {
  const response = await cognitoClient.send(
    new AdminListGroupsForUserCommand({ UserPoolId: userPoolId, Username: username }),
  );

  return (response.Groups ?? [])
    .map((group) => group.GroupName)
    .filter((group): group is string => Boolean(group && MANAGEABLE_GROUPS.has(group)));
}

/** Cognito attribute 배열을 정해진 공개 필드로만 줄여 반환합니다. */
function toMemberSummary(
  username: string,
  attributes: readonly AttributeType[],
  metadata: Readonly<{
    enabled: boolean;
    status?: string;
    createdAt?: string;
    updatedAt?: string;
    groups: readonly string[];
  }>,
): MemberSummary {
  const attributesByName = new Map(
    attributes.flatMap((attribute) =>
      attribute.Name && attribute.Value ? [[attribute.Name, attribute.Value]] : [],
    ),
  );
  const userSub = attributesByName.get("sub");
  const email = attributesByName.get("email");
  const displayName = attributesByName.get("name");

  return {
    username,
    ...(userSub ? { userSub } : {}),
    ...(email ? { email } : {}),
    ...(displayName ? { displayName } : {}),
    enabled: metadata.enabled,
    ...(metadata.status ? { status: metadata.status } : {}),
    ...(metadata.createdAt ? { createdAt: metadata.createdAt } : {}),
    ...(metadata.updatedAt ? { updatedAt: metadata.updatedAt } : {}),
    groups: metadata.groups,
  };
}

/** 무제한 Cognito 호출을 막는 page size를 1~50 범위로 좁힙니다. */
function readPageLimit(value: string | undefined) {
  if (!value) {
    return 25;
  }

  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_PAGE_SIZE
    ? parsed
    : 25;
}

/** opaque Cognito pagination token은 길이만 검사해 그대로 전달합니다. */
function readPaginationToken(value: string | undefined): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalizedValue = value.trim();

  return normalizedValue && normalizedValue.length <= 4096 ? normalizedValue : null;
}

/** API body에서 미리 허용한 운영 그룹만 읽습니다. */
function readGroupFromBody(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): "admin" | "support" | undefined {
  const body = parseJsonBody(event);

  if (!isRecord(body)) {
    return undefined;
  }

  const group = readBoundedString(body.group, 32);

  return group && MANAGEABLE_GROUPS.has(group)
    ? (group as "admin" | "support")
    : undefined;
}
