/**
 * 역할: 관리자 전용 브랜드·쿠폰·마케팅 캠페인 운영 데이터를 관리함.
 * 기능: 각 도메인의 고정 enum·입력 제한·낙관적 버전을 적용하고 원본 Dynamo 속성은 응답에서 제외함.
 */

import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { authorizeAdmin } from "./admin-auth.js";
import { getRequiredEnvironment } from "./dynamodb-client.js";
import { jsonResponse } from "./http-response.js";
import { getTableEnvironmentName, isRecordId } from "./admin-operations-values.js";
import {
  listRecords,
  createRecord,
  getRecord,
  updateRecord,
  deleteRecord,
} from "./admin-operations-records.js";
import {
  type OperationResource,
  type StoredResource,
  type OperationRoute,
} from "./admin-operations-types.js";

/** /admin/{brands,coupons,campaigns,members} route를 admin group 검증 뒤 처리합니다. */
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> {
  const authorization = await authorizeAdmin(event);

  if (!authorization.ok) {
    return jsonResponse(authorization.statusCode, { code: authorization.code });
  }

  const route = resolveOperationRoute(event);

  if (!route) {
    return jsonResponse(404, { code: "ADMIN_OPERATION_ROUTE_NOT_FOUND" });
  }

  if (route.resource === "members") {
    return memberDirectoryUnavailable(event.requestContext.http.method);
  }

  let tableName: string;

  try {
    tableName = getRequiredEnvironment(getTableEnvironmentName(route.resource));
  } catch {
    return jsonResponse(503, {
      code: `${route.resource.slice(0, -1).toUpperCase()}_CONFIGURATION_UNAVAILABLE`,
    });
  }

  const method = event.requestContext.http.method;

  if (!route.resourceId) {
    if (method === "GET") {
      return listRecords(tableName, route.resource, event);
    }

    if (method === "POST") {
      return createRecord(tableName, route.resource, event, authorization.userSub);
    }

    return jsonResponse(405, { code: "METHOD_NOT_ALLOWED" });
  }

  if (method === "GET") {
    return getRecord(tableName, route.resource, route.resourceId);
  }

  if (method === "PATCH") {
    return updateRecord(
      tableName,
      route.resource,
      route.resourceId,
      event,
      authorization.userSub,
    );
  }

  if (method === "DELETE") {
    return deleteRecord(tableName, route.resource, route.resourceId, event);
  }

  return jsonResponse(405, { code: "METHOD_NOT_ALLOWED" });
}

/** 이 handler의 members 경로는 GET·PATCH에 구성 미완료 응답을 반환하며 회원 데이터는 반환하지 않음. */
function memberDirectoryUnavailable(method: string) {
  if (method !== "GET" && method !== "PATCH") {
    return jsonResponse(405, { code: "METHOD_NOT_ALLOWED" });
  }

  return jsonResponse(503, {
    code: "MEMBER_DIRECTORY_CONFIGURATION_UNAVAILABLE",
    message: "Cognito member-directory integration is not configured.",
  });
}

function resolveOperationRoute(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): OperationRoute | null {
  const rawPath = event.rawPath.replace(/\/+$/, "") || "/";
  const match = rawPath.match(
    /^\/admin\/(?:operations\/)?(brands|coupons|campaigns|members)(?:\/([^/]+))?$/,
  );

  if (!match) {
    return null;
  }

  const resource = match[1] as OperationResource;
  const pathParameterNames: Record<StoredResource, string> = {
    brands: "brandId",
    coupons: "couponId",
    campaigns: "campaignId",
  };
  const encodedId =
    resource === "members"
      ? (event.pathParameters?.userSub ?? match[2])
      : (event.pathParameters?.[pathParameterNames[resource]] ?? match[2]);

  if (!encodedId) {
    return { resource };
  }

  let resourceId: string;

  try {
    resourceId = decodeURIComponent(encodedId);
  } catch {
    return null;
  }

  if (resource === "members") {
    return { resource, resourceId };
  }

  return isRecordId(resourceId) ? { resource, resourceId } : null;
}
