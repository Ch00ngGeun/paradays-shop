// 역할: 정적 관리자 UI가 Cognito access token으로 AWS Commerce 관리자 API를 호출하게 합니다.
// 기능: 브라우저에는 공개 API URL과 access token만 두고, OCR·권한·provider secret은 Lambda 경계에 남깁니다.

import type {
  AdminBrandDraft,
  AdminCampaignDraft,
  AdminCatalogListItem,
  AdminCouponDraft,
  AdminMember,
  AdminOcrBoundingBox,
  AdminOcrRecognitionResult,
  AdminOcrReviewRow,
  AdminOcrReviewSaveInput,
  AdminOcrReviewSaveResult,
  AdminOverviewMetrics,
  AdminProductDraft,
} from "@/lib/admin-ui/types";
import {
  AdminOcrInputError,
  isOcrEditableText,
  isOcrQuantity,
  OCR_INPUT_LIMITS,
  validateOcrImageFile,
} from "@/lib/admin-ui/ocr-input-validation";
import {
  CheckoutAuthorizationRequiredError,
  CheckoutClientUnavailableError,
  getCheckoutApiConfig,
  readCheckoutPublicEnvironment,
  type CheckoutApiConfig,
  type CheckoutAuthorizationTokenProvider,
  type CheckoutPublicEnvironment,
} from "@/lib/commerce/checkout-api-client";

const MAX_PRODUCT_IMAGE_BYTES = 6 * 1024 * 1024;
const ALLOWED_PRODUCT_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

/** 관리자 API가 거절한 요청의 status만 UI에 전달해 error body·토큰을 노출하지 않습니다. */
export class AdminApiRequestError extends Error {
  readonly code = "ADMIN_API_REQUEST_FAILED";

  constructor(
    readonly status: number,
    readonly endpoint: string,
    readonly responseCode?: string,
  ) {
    super(
      responseCode
        ? `ADMIN_API_REQUEST_FAILED: ${endpoint} ${status} ${responseCode}`
        : `ADMIN_API_REQUEST_FAILED: ${endpoint} ${status}`,
    );
    this.name = "AdminApiRequestError";
  }
}

/** 관리자 API 응답이 기대한 public contract를 만족하지 않을 때 안전하게 중단합니다. */
export class AdminApiResponseError extends Error {
  readonly code = "ADMIN_API_RESPONSE_INVALID";

  constructor() {
    super("ADMIN_API_RESPONSE_INVALID");
    this.name = "AdminApiResponseError";
  }
}

export { AdminOcrInputError } from "@/lib/admin-ui/ocr-input-validation";

/** 상품 이미지 업로드 입력이 거절되었을 때 UI에 전달합니다. */
export class AdminProductImageInputError extends Error {
  readonly code = "ADMIN_PRODUCT_IMAGE_INPUT_INVALID";

  constructor(message = "ADMIN_PRODUCT_IMAGE_INPUT_INVALID") {
    super(message);
    this.name = "AdminProductImageInputError";
  }
}

export type AdminApiClientDependencies = Readonly<{
  config: CheckoutApiConfig;
  authorizationTokenProvider: CheckoutAuthorizationTokenProvider;
  fetchImplementation?: typeof fetch;
}>;

/** 대시보드 connector가 사용하는 실제 관리자 API 함수의 집합입니다. */
export type AdminApiClient = Readonly<{
  uploadProductImage: (file: File) => Promise<string>;
  loadOverviewMetrics: () => Promise<AdminOverviewMetrics>;
  listCatalogProducts: () => Promise<readonly AdminCatalogListItem[]>;
  saveProductDraft: (draft: AdminProductDraft) => Promise<void>;
  updateProductStock: (
    input: Readonly<{ id: string; version: number; stock: number }>,
  ) => Promise<AdminCatalogListItem>;
  deleteCatalogProducts: (
    items: ReadonlyArray<Readonly<{ id: string; version: number }>>,
  ) => Promise<void>;
  saveBrandDraft: (draft: AdminBrandDraft) => Promise<void>;
  saveCouponDraft: (draft: AdminCouponDraft) => Promise<void>;
  saveCampaignDraft: (draft: AdminCampaignDraft) => Promise<void>;
  listMembers: () => Promise<readonly AdminMember[]>;
  updateMemberGroup: (
    input: Readonly<{
      username: string;
      group: "admin" | "support";
      add: boolean;
    }>,
  ) => Promise<void>;
  recognizeInventory: (
    input: Readonly<{ file: File }>,
  ) => Promise<AdminOcrRecognitionResult>;
  loadOcrReview: (jobId: string) => Promise<AdminOcrRecognitionResult>;
  saveOcrReview: (input: AdminOcrReviewSaveInput) => Promise<AdminOcrReviewSaveResult>;
}>;

/** 공개 API URL·in-memory token provider를 주입해 admin API client를 생성합니다. */
export function createAdminApiClient(
  dependencies: AdminApiClientDependencies,
): AdminApiClient {
  const fetchImplementation = resolveFetchImplementation(
    dependencies.fetchImplementation,
  );
  const { apiBaseUrl } = dependencies.config;
  const ocrApiBaseUrl = readLocalOcrApiBaseUrl() ?? apiBaseUrl;
  const loadOcrReview = async (jobId: string) => {
    const normalizedJobId = normalizeOcrJobId(jobId);
    const body = await requestJson({
      apiBaseUrl: ocrApiBaseUrl,
      authorizationTokenProvider: dependencies.authorizationTokenProvider,
      fetchImplementation,
      endpoint: `admin/ocr/jobs/${encodeURIComponent(normalizedJobId)}`,
      method: "GET",
    });

    return parseOcrJob(body);
  };

  return {
    async uploadProductImage(file) {
      if (
        !ALLOWED_PRODUCT_IMAGE_TYPES.has(file.type) ||
        file.size <= 0 ||
        file.size > MAX_PRODUCT_IMAGE_BYTES
      ) {
        throw new AdminProductImageInputError();
      }

      const uploadSession = await requestJson({
        apiBaseUrl,
        authorizationTokenProvider: dependencies.authorizationTokenProvider,
        fetchImplementation,
        endpoint: "admin/catalog/uploads",
        method: "POST",
        body: {
          contentType: file.type,
          contentLength: file.size,
        },
      });

      if (
        !isRecord(uploadSession) ||
        typeof uploadSession.uploadUrl !== "string" ||
        !uploadSession.uploadUrl.startsWith("https://") ||
        typeof uploadSession.publicUrl !== "string" ||
        !uploadSession.publicUrl.startsWith("https://")
      ) {
        throw new AdminApiResponseError();
      }

      const putResponse = await fetchImplementation(uploadSession.uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Type": file.type,
          "Content-Length": String(file.size),
        },
        body: file,
      });

      if (!putResponse.ok) {
        throw new AdminApiRequestError(putResponse.status, "s3-product-image-put");
      }

      return uploadSession.publicUrl;
    },
    async loadOverviewMetrics() {
      const body = await requestJson({
        apiBaseUrl,
        authorizationTokenProvider: dependencies.authorizationTokenProvider,
        fetchImplementation,
        endpoint: "admin/overview",
        method: "GET",
      });

      return parseOverviewMetrics(body);
    },
    async listCatalogProducts() {
      const products: AdminCatalogListItem[] = [];
      let cursor: string | undefined;

      do {
        const query = new URLSearchParams({ limit: "100" });

        if (cursor) {
          query.set("cursor", cursor);
        }

        const body = await requestJson({
          apiBaseUrl,
          authorizationTokenProvider: dependencies.authorizationTokenProvider,
          fetchImplementation,
          endpoint: `admin/catalog/products?${query.toString()}`,
          method: "GET",
        });

        if (!isRecord(body) || !Array.isArray(body.products)) {
          throw new AdminApiResponseError();
        }

        products.push(...body.products.map(parseCatalogListItem));
        cursor =
          typeof body.nextCursor === "string" && body.nextCursor.trim()
            ? body.nextCursor.trim()
            : undefined;
      } while (cursor);

      return products;
    },
    async saveProductDraft(draft) {
      if (draft.imageUrl.startsWith("blob:")) {
        // object URL은 현재 브라우저에만 존재하므로 서버 상품 이미지로 저장하면 깨진 공개 상품이 됩니다.
        throw new AdminProductImageInputError();
      }

      const payload = {
        name: draft.name,
        brand: draft.brand,
        category: draft.category,
        sku: draft.sku || undefined,
        price: draft.price,
        compareAtPrice: draft.compareAtPrice || undefined,
        stock: draft.stock || "0",
        imageUrl: draft.imageUrl,
        sizes: draft.sizes,
        description: draft.description,
        isVisible: draft.isVisible,
        isFeatured: draft.isFeatured,
        ...(draft.nameI18n ? { nameI18n: draft.nameI18n } : {}),
        ...(draft.descriptionI18n
          ? {
              descriptionI18n: {
                en: [...draft.descriptionI18n.en],
                ko: [...draft.descriptionI18n.ko],
              },
            }
          : {}),
        ...(draft.sourceLocale ? { sourceLocale: draft.sourceLocale } : {}),
      };

      if (draft.productId && typeof draft.version === "number") {
        await requestJson({
          apiBaseUrl,
          authorizationTokenProvider: dependencies.authorizationTokenProvider,
          fetchImplementation,
          endpoint: `admin/catalog/products/${encodeURIComponent(draft.productId)}`,
          method: "PATCH",
          body: { ...payload, version: draft.version },
        });
        return;
      }

      await requestJson({
        apiBaseUrl,
        authorizationTokenProvider: dependencies.authorizationTokenProvider,
        fetchImplementation,
        endpoint: "admin/catalog/products",
        method: "POST",
        body: payload,
      });
    },
    async updateProductStock(input) {
      const productId = input.id.trim();
      const stock = input.stock;

      if (!productId || productId.length > 96) {
        throw new AdminApiResponseError();
      }

      if (
        !Number.isSafeInteger(input.version) ||
        input.version < 1 ||
        input.version > 1_000_000
      ) {
        throw new AdminApiResponseError();
      }

      if (!Number.isSafeInteger(stock) || stock < 0 || stock > 1_000_000) {
        throw new AdminApiResponseError();
      }

      const body = await requestJson({
        apiBaseUrl,
        authorizationTokenProvider: dependencies.authorizationTokenProvider,
        fetchImplementation,
        endpoint: `admin/catalog/products/${encodeURIComponent(productId)}`,
        method: "PATCH",
        body: { version: input.version, stock },
      });

      if (!isRecord(body) || !("product" in body)) {
        throw new AdminApiResponseError();
      }

      return parseCatalogListItem(body.product);
    },
    async deleteCatalogProducts(items) {
      for (const item of items) {
        const productId = item.id.trim();

        if (!productId || productId.length > 96) {
          throw new AdminApiResponseError();
        }

        if (
          !Number.isSafeInteger(item.version) ||
          item.version < 1 ||
          item.version > 1_000_000
        ) {
          throw new AdminApiResponseError();
        }

        await requestJson({
          apiBaseUrl,
          authorizationTokenProvider: dependencies.authorizationTokenProvider,
          fetchImplementation,
          endpoint: `admin/catalog/products/${encodeURIComponent(productId)}`,
          method: "DELETE",
          body: { version: item.version },
        });
      }
    },
    async saveBrandDraft(draft) {
      await requestJson({
        apiBaseUrl,
        authorizationTokenProvider: dependencies.authorizationTokenProvider,
        fetchImplementation,
        endpoint: "admin/brands",
        method: "POST",
        body: draft,
      });
    },
    async saveCouponDraft(draft) {
      await requestJson({
        apiBaseUrl,
        authorizationTokenProvider: dependencies.authorizationTokenProvider,
        fetchImplementation,
        endpoint: "admin/coupons",
        method: "POST",
        body: draft,
      });
    },
    async saveCampaignDraft(draft) {
      await requestJson({
        apiBaseUrl,
        authorizationTokenProvider: dependencies.authorizationTokenProvider,
        fetchImplementation,
        endpoint: "admin/campaigns",
        method: "POST",
        body: draft,
      });
    },
    async listMembers() {
      const body = await requestJson({
        apiBaseUrl,
        authorizationTokenProvider: dependencies.authorizationTokenProvider,
        fetchImplementation,
        endpoint: "admin/members",
        method: "GET",
      });

      if (!isRecord(body) || !Array.isArray(body.members)) {
        throw new AdminApiResponseError();
      }

      return body.members.map(parseMember);
    },
    async updateMemberGroup(input) {
      const username = input.username.trim();

      if (!username || username.length > 128) {
        throw new AdminApiResponseError();
      }

      await requestJson({
        apiBaseUrl,
        authorizationTokenProvider: dependencies.authorizationTokenProvider,
        fetchImplementation,
        endpoint: `admin/members/${encodeURIComponent(username)}/groups`,
        method: input.add ? "POST" : "DELETE",
        body: { group: input.group },
      });
    },
    async recognizeInventory({ file }) {
      const image = await serializeOcrImageFile(file);
      const body = await requestJson({
        apiBaseUrl: ocrApiBaseUrl,
        authorizationTokenProvider: dependencies.authorizationTokenProvider,
        fetchImplementation,
        endpoint: "admin/ocr/jobs",
        method: "POST",
        body: image,
      });

      return parseOcrJob(body);
    },
    loadOcrReview,
    async saveOcrReview({ jobId, version, rows, rawText }) {
      const normalizedJobId = normalizeOcrJobId(jobId);

      if (!Number.isSafeInteger(version) || version < 1) {
        throw new AdminApiResponseError();
      }

      if (rawText !== undefined && !isOcrRawText(rawText)) {
        throw new AdminApiResponseError();
      }

      try {
        const body = await requestJson({
          apiBaseUrl: ocrApiBaseUrl,
          authorizationTokenProvider: dependencies.authorizationTokenProvider,
          fetchImplementation,
          endpoint: `admin/ocr/jobs/${encodeURIComponent(normalizedJobId)}`,
          method: "PATCH",
          body: {
            version,
            ...(rawText !== undefined ? { rawText } : {}),
            // confidence·bbox는 provider metadata라 browser가 수정·재전송하지 않습니다.
            rows: rows.map((row) => ({
              id: row.id,
              sourceText: row.sourceText,
              productName: row.productName,
              brand: row.brand,
              option: row.option,
              quantity: row.quantity,
            })),
          },
        });

        return { kind: "saved", job: parseOcrJob(body) };
      } catch (error) {
        if (!isAdminApiRequestStatus(error, 409)) {
          throw error;
        }

        // PATCH 409 body는 신뢰하지 않고, 인증된 GET으로 현재 canonical job을 다시 읽습니다.
        return { kind: "conflict", job: await loadOcrReview(normalizedJobId) };
      }
    },
  };
}

/** Local OCR is an explicit development transport; Cognito authentication still applies. */
export function isLocalOcrDevelopmentMode(): boolean {
  return readLocalOcrApiBaseUrl() !== undefined;
}

function readLocalOcrApiBaseUrl(): string | undefined {
  if (
    process.env.NODE_ENV !== "development" ||
    process.env.NEXT_PUBLIC_LOCAL_OCR_ENABLED !== "true" ||
    typeof window === "undefined" ||
    window.location.protocol !== "http:" ||
    !["localhost", "127.0.0.1"].includes(window.location.hostname)
  )
    return undefined;
  try {
    const url = new URL(process.env.NEXT_PUBLIC_LOCAL_OCR_API_URL ?? "");
    return url.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(url.hostname) &&
      url.port === "8011" &&
      url.pathname === "/" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
      ? url.origin
      : undefined;
  } catch {
    return undefined;
  }
}

/** 공개 환경변수 기반 client factory. UI connector는 configuration error를 안전한 연결 대기 화면으로 다룹니다. */
export function createAdminApiClientFromEnvironment(
  dependencies: Omit<AdminApiClientDependencies, "config">,
  environment: CheckoutPublicEnvironment = readCheckoutPublicEnvironment(),
) {
  return createAdminApiClient({
    ...dependencies,
    config: getCheckoutApiConfig(environment),
  });
}

async function requestJson({
  apiBaseUrl,
  authorizationTokenProvider,
  body,
  endpoint,
  fetchImplementation,
  method,
}: Readonly<{
  apiBaseUrl: string;
  authorizationTokenProvider: CheckoutAuthorizationTokenProvider;
  body?: Record<string, unknown>;
  endpoint: string;
  fetchImplementation: typeof fetch;
  method: "GET" | "POST" | "PATCH" | "DELETE";
}>): Promise<unknown> {
  const accessToken = await getAccessToken(authorizationTokenProvider);
  const response = await fetchImplementation(buildApiUrl(apiBaseUrl, endpoint), {
    method,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(removeUndefinedFields(body)) } : {}),
  });

  if (!response.ok) {
    const responseCode = await readAllowlistedAdminErrorCode(response, endpoint);

    if (
      endpoint === "admin/ocr/jobs" &&
      response.status === 413 &&
      responseCode === "OCR_IMAGE_TOO_LARGE"
    ) {
      throw new AdminOcrInputError("INLINE_PAYLOAD_TOO_LARGE");
    }

    throw new AdminApiRequestError(response.status, endpoint, responseCode);
  }

  try {
    return await response.json();
  } catch {
    throw new AdminApiResponseError();
  }
}

/** OCR·관리자 allowlist 오류 code만 읽어 안전한 운영 안내로 매핑합니다. */
async function readAllowlistedAdminErrorCode(
  response: Response,
  endpoint: string,
): Promise<string | undefined> {
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
      "ADMIN_ROLE_REQUIRED",
      "ADMIN_AUTH_REQUIRED",
      "LOCAL_OCR_ORIGIN_REQUIRED",
      "LOCAL_OCR_LIMIT_REACHED",
      "OCR_PROVIDER_BUSY",
    ]);

    return allowed.has(body.code) ? body.code : undefined;
  } catch {
    return undefined;
  }
}

/** OCR API 실패를 운영자가 조치할 수 있는 문구로 바꿉니다. */
export function getOcrRequestErrorMessage(error: unknown): string | undefined {
  if (
    !(error instanceof AdminApiRequestError) ||
    !error.endpoint.startsWith("admin/ocr/")
  ) {
    return undefined;
  }

  if (error.status === 401 || error.responseCode === "ADMIN_AUTH_REQUIRED") {
    return "관리자 로그인이 만료되었습니다. 다시 로그인한 뒤 OCR을 실행해 주세요.";
  }

  if (error.responseCode === "LOCAL_OCR_ORIGIN_REQUIRED")
    return "로컬 OCR은 전용 개발 화면 http://localhost:3138/admin에서 실행해 주세요.";

  if (error.status === 403 || error.responseCode === "ADMIN_ROLE_REQUIRED") {
    if (readLocalOcrApiBaseUrl()) {
      return "로컬 OCR도 서명된 Cognito access token의 admin 그룹 권한이 필요합니다. 다시 로그인해 주세요.";
    }
    return "OCR은 admin 그룹 권한이 필요합니다. Cognito admin 그룹을 확인해 주세요.";
  }

  if (
    error.responseCode === "LOCAL_OCR_LIMIT_REACHED" ||
    error.responseCode === "OCR_PROVIDER_BUSY"
  )
    return "로컬 OCR이 처리 중이거나 임시 사용 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.";
  if (readLocalOcrApiBaseUrl() && error.status >= 500)
    return "로컬 PaddleOCR 처리에 실패했습니다. 로컬 서버의 실행 상태와 이미지 크기를 확인해 주세요.";

  if (error.responseCode === "OCR_IMAGE_INVALID") {
    return "서버가 이미지 형식을 거절했습니다. PNG·JPEG·WEBP이고 파일 내용이 확장자와 일치하는지 확인해 주세요.";
  }

  if (error.responseCode === "OCR_IMAGE_TOO_LARGE") {
    return "현재 직접 OCR은 4MiB 이하만 지원합니다. 더 작은 파일로 다시 선택해 주세요.";
  }

  if (
    error.responseCode === "OCR_PROVIDER_CONFIGURATION_UNAVAILABLE" ||
    error.responseCode === "OCR_JOB_CONFIGURATION_UNAVAILABLE"
  ) {
    return "PaddleOCR 서비스 설정이 비어 있습니다. AWS Secrets Manager paradays-dev/paddle-ocr에 baseUrl·sharedSecret을 넣은 뒤 다시 시도해 주세요.";
  }

  if (error.responseCode === "OCR_PROVIDER_REQUEST_FAILED") {
    return "관리자 API는 연결됐지만 PaddleOCR 서비스 호출에 실패했습니다. baseUrl·네트워크·공유 비밀값을 확인해 주세요.";
  }

  if (error.responseCode === "OCR_PROVIDER_RESPONSE_INVALID") {
    return "PaddleOCR 응답 형식이 올바르지 않습니다. /ocr 응답의 rec_texts 필드를 확인해 주세요.";
  }

  if (error.responseCode === "OCR_JOB_STORAGE_UNAVAILABLE") {
    return "OCR 검토 저장소(DynamoDB)에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.";
  }

  if (error.responseCode === "OCR_JOB_RAW_TEXT_INVALID") {
    return "원문은 100,000자 이하로 입력하고 잘못된 제어 문자를 제거해 주세요.";
  }

  if (error.responseCode === "OCR_JOB_TOO_LARGE") {
    return "OCR 검토본이 저장 가능한 크기를 초과했습니다. 원문이나 검토 행을 줄인 뒤 다시 저장해 주세요.";
  }

  if (error.status >= 500) {
    return "OCR 서버 처리에 실패했습니다. PaddleOCR secret 설정과 관리자 API 로그를 확인해 주세요.";
  }

  return "OCR 요청에 실패했습니다. 이미지 형식과 관리자 API·PaddleOCR 연결을 확인해 주세요.";
}

function isAdminApiRequestStatus(error: unknown, status: number): boolean {
  return error instanceof AdminApiRequestError && error.status === status;
}

function parseMember(value: unknown): AdminMember {
  if (
    !isRecord(value) ||
    !isSafeText(value.username, 128) ||
    typeof value.enabled !== "boolean" ||
    !Array.isArray(value.groups) ||
    !value.groups.every((group) => group === "admin" || group === "support") ||
    !isOptionalText(value.userSub, 128) ||
    !isOptionalText(value.email, 320) ||
    !isOptionalText(value.displayName, 160)
  ) {
    throw new AdminApiResponseError();
  }

  return {
    username: value.username,
    ...(typeof value.userSub === "string" ? { userSub: value.userSub } : {}),
    ...(typeof value.email === "string" ? { email: value.email } : {}),
    ...(typeof value.displayName === "string"
      ? { displayName: value.displayName }
      : {}),
    enabled: value.enabled,
    groups: value.groups,
  };
}

function parseCatalogListItem(value: unknown): AdminCatalogListItem {
  if (
    !isRecord(value) ||
    !isSafeText(value.productId, 96) ||
    !isSafeText(value.name, 160) ||
    !isSafeText(value.brandName, 100) ||
    !isSafeText(value.category, 80) ||
    typeof value.price !== "number" ||
    !Number.isSafeInteger(value.price) ||
    value.price < 0 ||
    value.price > 100_000_000 ||
    typeof value.inventoryQuantity !== "number" ||
    !Number.isSafeInteger(value.inventoryQuantity) ||
    value.inventoryQuantity < 0 ||
    value.inventoryQuantity > 1_000_000 ||
    (value.status !== "DRAFT" && value.status !== "PUBLISHED") ||
    typeof value.featured !== "boolean" ||
    typeof value.version !== "number" ||
    !Number.isSafeInteger(value.version) ||
    value.version < 1 ||
    !Array.isArray(value.description) ||
    !value.description.every(
      (line) => typeof line === "string" && line.length <= 500,
    ) ||
    !Array.isArray(value.sizes) ||
    !value.sizes.every((size) => typeof size === "string" && size.length <= 80) ||
    (value.sku !== undefined && !isSafeText(value.sku, 80)) ||
    (value.image !== undefined && typeof value.image !== "string") ||
    (value.compareAtPrice !== undefined &&
      (typeof value.compareAtPrice !== "number" ||
        !Number.isSafeInteger(value.compareAtPrice)))
  ) {
    throw new AdminApiResponseError();
  }

  const nameI18n =
    isRecord(value.nameI18n) &&
    typeof value.nameI18n.en === "string" &&
    typeof value.nameI18n.ko === "string"
      ? { en: value.nameI18n.en, ko: value.nameI18n.ko }
      : undefined;
  const descriptionI18n =
    isRecord(value.descriptionI18n) &&
    Array.isArray(value.descriptionI18n.en) &&
    Array.isArray(value.descriptionI18n.ko)
      ? {
          en: value.descriptionI18n.en.filter(
            (line): line is string => typeof line === "string",
          ),
          ko: value.descriptionI18n.ko.filter(
            (line): line is string => typeof line === "string",
          ),
        }
      : undefined;

  return {
    id: value.productId,
    name: value.name,
    brand: value.brandName,
    category: value.category,
    price: value.price,
    stock: value.inventoryQuantity,
    isVisible: value.status === "PUBLISHED",
    version: value.version,
    ...(typeof value.sku === "string" ? { sku: value.sku } : {}),
    ...(typeof value.image === "string" ? { imageUrl: value.image } : {}),
    ...(typeof value.compareAtPrice === "number"
      ? { compareAtPrice: value.compareAtPrice }
      : {}),
    sizes: value.sizes.join(", "),
    description: value.description.join("\n"),
    isFeatured: value.featured,
    ...(nameI18n ? { nameI18n } : {}),
    ...(descriptionI18n ? { descriptionI18n } : {}),
  };
}

function parseOverviewMetrics(value: unknown): AdminOverviewMetrics {
  if (
    !isRecord(value) ||
    typeof value.asOf !== "string" ||
    typeof value.timezone !== "string" ||
    !isSafeCount(value.todayOrderCount) ||
    !isSafeCount(value.lowStockCount) ||
    !isSafeCount(value.lowStockThreshold) ||
    !isSafeCount(value.activeCouponCount) ||
    !isSafeCount(value.marketingConsentCount)
  ) {
    throw new AdminApiResponseError();
  }

  return {
    asOf: value.asOf,
    timezone: value.timezone,
    todayOrderCount: value.todayOrderCount,
    lowStockCount: value.lowStockCount,
    lowStockThreshold: value.lowStockThreshold,
    activeCouponCount: value.activeCouponCount,
    marketingConsentCount: value.marketingConsentCount,
  };
}

function isSafeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseOcrJob(value: unknown): AdminOcrRecognitionResult {
  const job = isRecord(value) && isRecord(value.job) ? value.job : null;

  if (
    !job ||
    !isValidOcrJobId(job.jobId) ||
    typeof job.version !== "number" ||
    !Number.isSafeInteger(job.version) ||
    job.version < 1 ||
    !isOcrRawText(job.rawText) ||
    !Array.isArray(job.rows) ||
    job.rows.length > OCR_INPUT_LIMITS.maxReviewRows
  ) {
    throw new AdminApiResponseError();
  }

  const rows = job.rows.map((row, index): AdminOcrReviewRow => {
    if (!isRecord(row) || !isSafeText(row.id, 128)) {
      throw new AdminApiResponseError();
    }

    const sourceText = readOcrResponseText(
      row.sourceText,
      OCR_INPUT_LIMITS.maxSourceTextLength,
    );
    const productName =
      row.productName === undefined
        ? sourceText
        : readOcrResponseText(row.productName, OCR_INPUT_LIMITS.maxProductNameLength);
    const brand =
      row.brand === undefined
        ? ""
        : readOcrResponseText(row.brand, OCR_INPUT_LIMITS.maxBrandLength);
    const option =
      row.option === undefined
        ? ""
        : readOcrResponseText(row.option, OCR_INPUT_LIMITS.maxOptionLength);
    const quantity = row.quantity === undefined ? "" : row.quantity;
    const confidence =
      row.confidence === undefined ? undefined : parseOcrConfidence(row.confidence);
    const box = row.box === undefined ? undefined : parseOcrBoundingBox(row.box);

    if (
      sourceText === undefined ||
      productName === undefined ||
      brand === undefined ||
      option === undefined ||
      !isOcrQuantity(quantity) ||
      (row.confidence !== undefined && confidence === undefined) ||
      (row.box !== undefined && box === undefined)
    ) {
      throw new AdminApiResponseError();
    }

    return {
      id: row.id || `${job.jobId}-${index}`,
      sourceText,
      ...(confidence !== undefined ? { confidence } : {}),
      ...(box ? { box } : {}),
      productName,
      brand,
      option,
      quantity,
    };
  });

  return { jobId: job.jobId, version: job.version, rawText: job.rawText, rows };
}

function readOcrResponseText(
  value: unknown,
  maximumLength: number,
): string | undefined {
  return isOcrEditableText(value, maximumLength) ? value : undefined;
}

/** Raw text is preserved without trimming, unlike editable row fields. */
function isOcrRawText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= OCR_INPUT_LIMITS.maxRawTextLength &&
    !value.includes("\u0000")
  );
}

function parseOcrConfidence(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : undefined;
}

function parseOcrBoundingBox(value: unknown): AdminOcrBoundingBox | undefined {
  if (!Array.isArray(value) || value.length < 2 || value.length > 8) {
    return undefined;
  }

  const points: [number, number][] = [];

  for (const point of value) {
    if (
      !Array.isArray(point) ||
      point.length < 2 ||
      typeof point[0] !== "number" ||
      typeof point[1] !== "number" ||
      !Number.isFinite(point[0]) ||
      !Number.isFinite(point[1]) ||
      Math.abs(point[0]) > 1_000_000 ||
      Math.abs(point[1]) > 1_000_000
    ) {
      return undefined;
    }

    points.push([point[0], point[1]]);
  }

  return points;
}

/** inline JSON은 Lambda sync event에 안전한 4MiB 원본만 base64화합니다. */
async function serializeOcrImageFile(file: File) {
  const image = await validateOcrImageFile(file);

  return {
    fileName: image.fileName,
    mimeType: image.mimeType,
    imageBase64: bytesToBase64(image.bytes),
  };
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunkSize = 0x8000;

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }

  return globalThis.btoa(binary);
}

function normalizeOcrJobId(jobId: string): string {
  const normalizedJobId = jobId.trim();

  if (!isValidOcrJobId(normalizedJobId)) {
    throw new AdminApiResponseError();
  }

  return normalizedJobId;
}

function isValidOcrJobId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(value);
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

function resolveFetchImplementation(fetchImplementation?: typeof fetch): typeof fetch {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSafeText(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" && Boolean(value.trim()) && value.length <= maximumLength
  );
}

function isOptionalText(value: unknown, maximumLength: number) {
  return value === undefined || isSafeText(value, maximumLength);
}
