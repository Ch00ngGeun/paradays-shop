// 역할: 관리자 API 공통 JSON 요청(인증 token·원격 OCR 데모 120초 제한·오류 코드 해석)과 fetch 구현 선택을 담당합니다.
import { AdminApiRequestError } from "./admin-api-client";
import {
  AdminApiResponseError,
  AdminOcrDemoConnectionError,
} from "./admin-api-client-errors";
import { OCR_REGION_FAILURE_MESSAGES } from "./admin-api-client-ocr-errors";
import { isRecord } from "./admin-api-client-response";
import { AdminOcrInputError } from "@/lib/admin-ui/ocr-input-validation";
import {
  CheckoutAuthorizationRequiredError,
  CheckoutClientUnavailableError,
  type CheckoutAuthorizationTokenProvider,
} from "@/lib/commerce/checkout-api-client";

export async function requestJson({
  apiBaseUrl,
  authorizationTokenProvider,
  body,
  endpoint,
  fetchImplementation,
  method,
  remoteOcrDemo = false,
}: Readonly<{
  apiBaseUrl: string;
  authorizationTokenProvider: CheckoutAuthorizationTokenProvider;
  body?: Record<string, unknown>;
  endpoint: string;
  fetchImplementation: typeof fetch;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  remoteOcrDemo?: boolean;
}>): Promise<unknown> {
  const accessToken = await getAccessToken(authorizationTokenProvider);
  const performRequest = async (signal?: AbortSignal) => {
    let response: Response;
    try {
      response = await fetchImplementation(buildApiUrl(apiBaseUrl, endpoint), {
        method,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${accessToken}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(removeUndefinedFields(body)) } : {}),
        ...(remoteOcrDemo
          ? { signal, redirect: "error", credentials: "omit", cache: "no-store" }
          : {}),
      });
    } catch (error) {
      if (remoteOcrDemo) throw new AdminOcrDemoConnectionError();
      throw error;
    }

    if (!response.ok) {
      const safeError = await readAllowlistedAdminErrorCode(response, endpoint);
      const responseCode = safeError?.code;

      if (
        endpoint === "admin/ocr/jobs" &&
        response.status === 413 &&
        responseCode === "OCR_IMAGE_TOO_LARGE"
      ) {
        throw new AdminOcrInputError("INLINE_PAYLOAD_TOO_LARGE");
      }

      throw new AdminApiRequestError(
        response.status,
        endpoint,
        responseCode,
        safeError?.reason,
      );
    }

    try {
      return await response.json();
    } catch {
      throw new AdminApiResponseError();
    }
  };

  if (!remoteOcrDemo) return performRequest();

  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout>;
  // 데모 중계의 115초 제한보다 길게 기다리되, 브라우저도 120초에 중단함.
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new AdminOcrDemoConnectionError(true));
      controller.abort();
    }, 120000);
  });
  try {
    return await Promise.race([performRequest(controller.signal), deadline]);
  } finally {
    clearTimeout(timeout!);
  }
}

/** OCR·관리자 allowlist 오류 code만 읽어 안전한 운영 안내로 매핑합니다. */
async function readAllowlistedAdminErrorCode(
  response: Response,
  endpoint: string,
): Promise<{ code: string; reason?: string } | undefined> {
  if (endpoint === "admin/catalog/products") {
    try {
      const body: unknown = await response.json();
      return isRecord(body) &&
        typeof body.code === "string" &&
        [
          "OCR_INTAKE_INVALID",
          "OCR_INTAKE_OPERATION_CONFLICT",
          "OCR_INTAKE_ROW_CONFLICT",
          "CATALOG_PRODUCT_DUPLICATE",
          "CATALOG_IDENTITY_CONFLICT",
          "CATALOG_PRODUCT_VERSION_CONFLICT",
          "ADMIN_ROLE_REQUIRED",
          "ADMIN_AUTH_REQUIRED",
        ].includes(body.code)
        ? { code: body.code }
        : undefined;
    } catch {
      return undefined;
    }
  }
  // 단일 상품 PATCH 응답에서는 예약·중복 이름 변경 거절을 버전 충돌과 구분합니다.
  if (/^admin\/catalog\/products\/[^/]+$/.test(endpoint)) {
    try {
      const body: unknown = await response.json();
      return isRecord(body) &&
        typeof body.code === "string" &&
        [
          "CATALOG_PRODUCT_RESERVED",
          "CATALOG_PRODUCT_DUPLICATE",
          "CATALOG_PRODUCT_VERSION_CONFLICT",
        ].includes(body.code)
        ? { code: body.code }
        : undefined;
    } catch {
      return undefined;
    }
  }
  if (!endpoint.startsWith("admin/ocr/")) {
    return undefined;
  }

  try {
    const body: unknown = await response.json();

    if (!isRecord(body) || typeof body.code !== "string") {
      return undefined;
    }

    const allowed = new Set([
      "OCR_IMAGE_INVALID",
      "OCR_IMAGE_TOO_LARGE",
      "OCR_PROVIDER_CONFIGURATION_UNAVAILABLE",
      "OCR_PROVIDER_REQUEST_FAILED",
      "OCR_PROVIDER_RESPONSE_INVALID",
      "OCR_JOB_CONFIGURATION_UNAVAILABLE",
      "OCR_JOB_STORAGE_UNAVAILABLE",
      "OCR_JOB_RAW_TEXT_INVALID",
      "OCR_JOB_TOO_LARGE",
      "OCR_JOB_MAPPING_INVALID",
      "OCR_JOB_MAPPING_UNUSABLE",
      "OCR_JOB_SOURCE_ROWS_UNAVAILABLE",
      "ADMIN_ROLE_REQUIRED",
      "ADMIN_AUTH_REQUIRED",
      "LOCAL_OCR_ORIGIN_REQUIRED",
      "LOCAL_OCR_LIMIT_REACHED",
      "LOCAL_OCR_BODY_TIMEOUT",
      "OCR_PROVIDER_BUSY",
    ]);

    if (!allowed.has(body.code)) return undefined;
    const reason =
      isRecord(body.analysis) &&
      typeof body.analysis.reason === "string" &&
      Object.hasOwn(OCR_REGION_FAILURE_MESSAGES, body.analysis.reason)
        ? body.analysis.reason
        : undefined;
    return {
      code: body.code,
      ...(body.code === "OCR_JOB_MAPPING_UNUSABLE" && reason ? { reason } : {}),
    };
  } catch {
    return undefined;
  }
}

export function isAdminApiRequestStatus(error: unknown, status: number): boolean {
  return error instanceof AdminApiRequestError && error.status === status;
}

function removeUndefinedFields(body: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(body).filter(([, value]) => value !== undefined),
  );
}

function buildApiUrl(apiBaseUrl: string, endpoint: string) {
  try {
    return new URL(endpoint, `${apiBaseUrl.replace(/\/+$/, "")}/`).toString();
  } catch {
    throw new CheckoutClientUnavailableError("Commerce API base URL must be valid.");
  }
}

export function resolveFetchImplementation(
  fetchImplementation?: typeof fetch,
): typeof fetch {
  if (fetchImplementation) {
    return fetchImplementation;
  }

  if (typeof globalThis.fetch === "function") {
    return globalThis.fetch;
  }

  throw new CheckoutClientUnavailableError(
    "A browser fetch implementation is required.",
  );
}

async function getAccessToken(
  authorizationTokenProvider: CheckoutAuthorizationTokenProvider,
): Promise<string> {
  try {
    const token = await authorizationTokenProvider.getAccessToken();
    const normalizedToken = token?.trim();

    if (!normalizedToken) {
      throw new CheckoutAuthorizationRequiredError();
    }

    return normalizedToken;
  } catch (error) {
    if (error instanceof CheckoutAuthorizationRequiredError) {
      throw error;
    }

    throw new CheckoutAuthorizationRequiredError();
  }
}
