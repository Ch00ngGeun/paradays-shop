/**
 * 역할: 관리자 입고표 OCR 요청과 수정 검토본을 안전하게 보관합니다.
 * 기능: PaddleOCR secret·원본 이미지는 Lambda 경계 밖으로 노출하거나 저장하지 않고,
 *       짧은 TTL의 텍스트 검토 job만 DynamoDB에 기록합니다.
 */

import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { authorizeAdmin } from "./admin-auth.js";
import { getRequiredEnvironment } from "./dynamodb-client.js";
import { jsonResponse } from "./http-response.js";
import { createOcrJob, getOcrJob, updateOcrJob } from "./admin-ocr-jobs.js";
import { JOB_ID_PATTERN } from "./admin-ocr-values.js";

export const MAX_OCR_JOB_STORAGE_BYTES = 380 * 1024;

type OcrJobRoute =
  | Readonly<{ kind: "collection" }>
  | Readonly<{ kind: "item"; jobId: string }>;

/**
 * POST /admin/ocr/jobs는 admin만 생성할 수 있습니다.
 * 모든 읽기·수정은 현재 Cognito admin group을 요구합니다.
 */
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> {
  const route = resolveOcrRoute(event);

  if (!route) {
    return jsonResponse(404, { code: "ADMIN_OCR_ROUTE_NOT_FOUND" });
  }

  const method = event.requestContext.http.method;
  const writeAuthorization = method === "GET" ? undefined : await authorizeAdmin(event);

  // POST/PATCH는 provider/table 설정을 읽기 전에 먼저 admin group을 확인합니다.
  if (writeAuthorization && !writeAuthorization.ok) {
    return jsonResponse(writeAuthorization.statusCode, {
      code: writeAuthorization.code,
    });
  }

  let jobTableName: string;

  try {
    jobTableName = getRequiredEnvironment("OCR_JOB_TABLE_NAME");
  } catch {
    return jsonResponse(503, { code: "OCR_JOB_CONFIGURATION_UNAVAILABLE" });
  }

  if (route.kind === "collection") {
    if (method !== "POST") {
      return jsonResponse(405, { code: "METHOD_NOT_ALLOWED" });
    }

    if (!writeAuthorization || !writeAuthorization.ok) {
      return jsonResponse(403, { code: "ADMIN_ROLE_REQUIRED" });
    }

    return createOcrJob(jobTableName, event, writeAuthorization.userSub);
  }

  if (method === "GET") {
    const authorization = await authorizeAdmin(event);

    if (!authorization.ok) {
      return jsonResponse(authorization.statusCode, { code: authorization.code });
    }

    return getOcrJob(jobTableName, route.jobId);
  }

  if (method === "PATCH") {
    if (!writeAuthorization || !writeAuthorization.ok) {
      return jsonResponse(403, { code: "ADMIN_ROLE_REQUIRED" });
    }

    return updateOcrJob(jobTableName, route.jobId, event, writeAuthorization.userSub);
  }

  return jsonResponse(405, { code: "METHOD_NOT_ALLOWED" });
}

function resolveOcrRoute(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): OcrJobRoute | null {
  const rawPath = event.rawPath.replace(/\/+$/, "") || "/";
  const match = rawPath.match(/^\/admin\/ocr\/jobs(?:\/([^/]+))?$/);

  if (!match) {
    return null;
  }

  const encodedJobId = event.pathParameters?.jobId ?? match[1];

  if (!encodedJobId) {
    return { kind: "collection" };
  }

  try {
    const jobId = decodeURIComponent(encodedJobId);

    return JOB_ID_PATTERN.test(jobId) ? { kind: "item", jobId } : null;
  } catch {
    return null;
  }
}

/**
 * JSON 전송 크기나 정확한 과금이 아니라 DynamoDB item 크기를 보수적으로 추정함.
 * https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/CapacityUnitCalculations.html
 * UTF-8 이름/문자열, 원본 binary, map/list overhead(3 + 항목당 1),
 * 숫자당 21 byte(38자리 숫자 저장의 대략적 최대치보다 큼)를 셈.
 * 저장 byte 100과 최상위 map overhead를 보수적으로 더하며,
 * 380KiB 쓰기 상한은 DynamoDB item 한도 400KiB보다 20KiB 여유를 둠.
 * 보존한 metadata/감사 속성을 포함해 최종 item 전체를 순회함.
 * 지원하지 않거나 순환·과도하게 깊은 구조는 fail-closed로 처리하며, GET 형태 검사는 그대로 유지함.
 */
export function estimateOcrJobStorageBytes(item: unknown): number {
  let bytes = 100;
  let visited = 0;
  const ancestors = new WeakSet<object>();

  const walk = (value: unknown, depth: number): void => {
    if (bytes > MAX_OCR_JOB_STORAGE_BYTES) return;
    visited += 1;
    if (depth > 32 || visited > 100_000) {
      bytes = Infinity;
    } else if (value === undefined) {
      // DocumentClient는 removeUndefinedValues가 켜져 있음.
    } else if (typeof value === "string") {
      bytes += Buffer.byteLength(value, "utf8");
    } else if (typeof value === "number" || typeof value === "bigint") {
      bytes +=
        typeof value === "number" && !Number.isFinite(value)
          ? Infinity
          : Math.max(21, Buffer.byteLength(String(value), "utf8"));
    } else if (value === null || typeof value === "boolean") {
      bytes += 1;
    } else if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
      bytes += value.byteLength;
    } else if (typeof value === "object") {
      if (ancestors.has(value)) {
        bytes = Infinity;
        return;
      }
      ancestors.add(value);
      bytes += 3;
      if (Array.isArray(value) || value instanceof Set) {
        // Set은 overhead가 더 작으므로 list처럼 세면 보수적인 값이 됨.
        for (const element of value) {
          bytes += 1;
          walk(element, depth + 1);
          if (bytes > MAX_OCR_JOB_STORAGE_BYTES) break;
        }
      } else if (
        Object.getPrototypeOf(value) === Object.prototype ||
        Object.getPrototypeOf(value) === null
      ) {
        for (const [name, element] of Object.entries(value)) {
          if (element === undefined) continue;
          bytes += Buffer.byteLength(name, "utf8") + 1;
          walk(element, depth + 1);
          if (bytes > MAX_OCR_JOB_STORAGE_BYTES) break;
        }
      } else {
        bytes = Infinity;
      }
      ancestors.delete(value);
    } else {
      bytes = Infinity;
    }
  };

  try {
    walk(item, 0);
  } catch {
    return Infinity;
  }
  return bytes;
}
