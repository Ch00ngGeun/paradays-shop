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
  AdminOcrRemapInput,
  AdminOcrRemapResult,
  OcrTableAnalysis,
  AdminOcrReviewRow,
  AdminOcrReviewSaveInput,
  AdminOcrReviewSaveResult,
  AdminOcrIntakeInput,
  AdminOcrIntakeResult,
  AdminOverviewMetrics,
  AdminProductDraft,
} from "@/lib/admin-ui/types";
import type { DeckSpec, Locale } from "@/types/store";
import {
  isOcrMapping,
  isOcrColumnMapping,
} from "../../infra/lambda/ocr-table-parser.js";
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
    readonly mappingReason?: string,
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

/** 임시 PC OCR 연결 오류에는 주소·토큰·서버 응답 내용을 포함하지 않습니다. */
export class AdminOcrDemoConnectionError extends Error {
  readonly code = "OCR_DEMO_CONNECTION_FAILED";

  constructor(readonly timedOut = false) {
    super("OCR_DEMO_CONNECTION_FAILED");
    this.name = "AdminOcrDemoConnectionError";
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
  updateProductDeckSpec: (
    input: Readonly<{
      id: string;
      version: number;
      deckSpec: DeckSpec | null;
      /** 있으면 그 사이즈 옵션의 상세사이즈만, 없으면 기본값을 저장합니다. */
      size?: string;
      /** size 옵션의 새 이름. 다르면 이름 변경과 상세사이즈를 한 번에 저장합니다. */
      sizeName?: string;
    }>,
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
  remapOcrReview: (input: AdminOcrRemapInput) => Promise<AdminOcrRemapResult>;
  applyOcrIntake: (input: AdminOcrIntakeInput) => Promise<AdminOcrIntakeResult>;
}>;

/** 공개 API URL·in-memory token provider를 주입해 admin API client를 생성합니다. */
export function createAdminApiClient(
  dependencies: AdminApiClientDependencies,
): AdminApiClient {
  const fetchImplementation = resolveFetchImplementation(
    dependencies.fetchImplementation,
  );
  const { apiBaseUrl } = dependencies.config;
  const remoteDemoApiBaseUrl = readRemoteOcrDemoApiBaseUrl();
  const ocrApiBaseUrl = remoteDemoApiBaseUrl ?? readLocalOcrApiBaseUrl() ?? apiBaseUrl;
  const remoteOcrDemo = remoteDemoApiBaseUrl !== undefined;
  const loadOcrReview = async (jobId: string) => {
    const normalizedJobId = normalizeOcrJobId(jobId);
    const body = await requestJson({
      apiBaseUrl: ocrApiBaseUrl,
      authorizationTokenProvider: dependencies.authorizationTokenProvider,
      fetchImplementation,
      endpoint: `admin/ocr/jobs/${encodeURIComponent(normalizedJobId)}`,
      method: "GET",
      remoteOcrDemo,
    });

    return parseOcrJob(body);
  };

  return {
    async applyOcrIntake(value) {
      validateOcrIntakeInput(value);
      const input: AdminOcrIntakeInput =
        value.kind === "existing"
          ? {
              operationId: value.operationId,
              quantity: value.quantity,
              source: {
                jobId: value.source.jobId,
                rowIds: [...value.source.rowIds].sort(),
              },
              kind: value.kind,
              existing: {
                productId: value.existing.productId,
                version: value.existing.version,
              },
            }
          : {
              operationId: value.operationId,
              quantity: value.quantity,
              source: {
                jobId: value.source.jobId,
                rowIds: [...value.source.rowIds].sort(),
              },
              kind: value.kind,
              product: {
                name: value.product.name.normalize("NFC").trim(),
                brandName: value.product.brandName.normalize("NFC").trim(),
                option: value.product.option.normalize("NFC").trim(),
                ...(value.product.sku === undefined
                  ? {}
                  : { sku: value.product.sku.normalize("NFC").trim() }),
                price: value.product.price,
                category: value.product.category,
              },
            };
      // 실제 상품 쓰기는 임시 OCR 서버가 아니라 기존 Cognito 관리자 API로만 보냅니다.
      const body = await requestJson({
        apiBaseUrl,
        authorizationTokenProvider: dependencies.authorizationTokenProvider,
        fetchImplementation,
        endpoint: "admin/catalog/products",
        method: "POST",
        body: { action: "ocr-intake", ...input },
      });
      if (!isRecord(body) || !isRecord(body.receipt)) throw new AdminApiResponseError();
      const product = parseCatalogListItem(body.product);
      const receipt = body.receipt;
      if (
        receipt.operationId !== input.operationId ||
        receipt.kind !== input.kind ||
        receipt.quantity !== input.quantity ||
        !isIntakeInteger(receipt.beforeStock, 0, 1_000_000) ||
        !isIntakeInteger(receipt.afterStock, 0, 1_000_000) ||
        receipt.afterStock !== receipt.beforeStock + input.quantity ||
        product.stock !== receipt.afterStock ||
        typeof receipt.replayed !== "boolean" ||
        (input.kind === "existing" &&
          (product.id !== input.existing.productId ||
            product.version !== input.existing.version + 1)) ||
        (input.kind === "new" &&
          (receipt.beforeStock !== 0 ||
            product.version !== 1 ||
            product.isVisible ||
            product.isFeatured ||
            product.name !== input.product.name.trim() ||
            product.brand !== input.product.brandName.trim() ||
            product.price !== input.product.price ||
            product.category !== input.product.category ||
            product.sizes !== input.product.option.trim() ||
            product.sku !== input.product.sku?.trim()))
      )
        throw new AdminApiResponseError();
      return {
        product,
        receipt: {
          operationId: input.operationId,
          kind: input.kind,
          quantity: input.quantity,
          beforeStock: receipt.beforeStock,
          afterStock: receipt.afterStock,
          replayed: receipt.replayed,
        },
      };
    },
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
        // PATCH의 빈 문자열은 기존 비교가를 지우려는 명시적 요청이며, 생략하면 서버가 기존 값을 유지합니다.
        compareAtPrice:
          draft.compareAtPrice ||
          (draft.productId && typeof draft.version === "number" ? "" : undefined),
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

      const product = parseCatalogListItem(body.product);
      if (
        product.id !== productId ||
        product.version !== input.version + 1 ||
        product.stock !== stock
      ) {
        throw new AdminApiResponseError();
      }
      return product;
    },
    async updateProductDeckSpec(input) {
      const productId = input.id.trim();

      if (
        !productId ||
        productId.length > 96 ||
        !Number.isSafeInteger(input.version) ||
        input.version < 1 ||
        input.version > 1_000_000 ||
        (input.deckSpec !== null && !isDeckSpec(input.deckSpec)) ||
        (input.size !== undefined &&
          (typeof input.size !== "string" ||
            !input.size.trim() ||
            input.size.length > 50)) ||
        (input.sizeName !== undefined &&
          (input.size === undefined ||
            (input.sizeName !== input.size && !isNewOptionName(input.sizeName))))
      ) {
        throw new AdminApiResponseError();
      }

      const deckSpec = input.deckSpec && copyDeckSpec(input.deckSpec);
      const { size } = input;
      // Only an actual rename sends sizeName, so a same-name save stays the H-035 body.
      const sizeName =
        input.sizeName !== undefined && input.sizeName !== size
          ? input.sizeName
          : undefined;
      const savedKey = sizeName ?? size;
      const body = await requestJson({
        apiBaseUrl,
        authorizationTokenProvider: dependencies.authorizationTokenProvider,
        fetchImplementation,
        endpoint: `admin/catalog/products/${encodeURIComponent(productId)}`,
        method: "PATCH",
        // An option save uses its own field, so a server without it cannot overwrite the default.
        body:
          size === undefined
            ? { version: input.version, deckSpec }
            : {
                version: input.version,
                size,
                ...(sizeName === undefined ? {} : { sizeName }),
                sizeDeckSpec: deckSpec,
              },
      });

      if (!isRecord(body) || !("product" in body)) {
        throw new AdminApiResponseError();
      }

      const product = parseCatalogListItem(body.product);
      // Compare the raw response: the list parser drops a malformed spec, which would look like a delete.
      const raw = isRecord(body.product) ? body.product : {};
      // shortcut: an older server never returns the option map, so an ignored option delete looks like success; add a handled marker to the server response to tell them apart.
      const savedDeckSpec =
        savedKey === undefined
          ? raw.deckSpec
          : isRecord(raw.deckSpecsBySize) &&
              Object.hasOwn(raw.deckSpecsBySize, savedKey)
            ? raw.deckSpecsBySize[savedKey]
            : undefined;
      // A server that ignored sizeName still lists the old name, so the rename is not taken as saved.
      const renamed =
        sizeName === undefined ||
        (Array.isArray(raw.sizes) &&
          raw.sizes.includes(sizeName) &&
          !raw.sizes.includes(size));
      if (
        !renamed ||
        product.id !== productId ||
        product.version !== input.version + 1 ||
        JSON.stringify(savedDeckSpec ?? null) !== JSON.stringify(deckSpec)
      ) {
        throw new AdminApiResponseError();
      }
      return product;
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
        remoteOcrDemo,
      });

      return parseOcrJob(body);
    },
    loadOcrReview,
    async remapOcrReview({ jobId, version, mapping, preview }) {
      const normalizedJobId = normalizeOcrJobId(jobId);
      if (
        !Number.isSafeInteger(version) ||
        version < 1 ||
        !isOcrMapping(mapping) ||
        typeof preview !== "boolean"
      )
        throw new AdminApiResponseError();
      try {
        const body = await requestJson({
          apiBaseUrl: ocrApiBaseUrl,
          authorizationTokenProvider: dependencies.authorizationTokenProvider,
          fetchImplementation,
          endpoint: `admin/ocr/jobs/${encodeURIComponent(normalizedJobId)}`,
          method: "PATCH",
          body: { version, mapping, ...(preview ? { preview: true } : {}) },
          remoteOcrDemo,
        });
        if (!preview) {
          const applied = parseOcrJob(body);
          if (applied.jobId !== normalizedJobId || applied.version !== version + 1)
            throw new AdminApiResponseError();
          return { kind: "saved", job: applied };
        }
        if (!isRecord(body) || !isRecord(body.preview))
          throw new AdminApiResponseError();
        const parsed = parseOcrJob({ job: { ...body.preview, rawText: "" } });
        if (
          parsed.jobId !== normalizedJobId ||
          parsed.version !== version ||
          parsed.analysis?.mode !== "table"
        )
          throw new AdminApiResponseError();
        return {
          kind: "preview",
          preview: {
            jobId: parsed.jobId,
            version: parsed.version,
            rows: parsed.rows,
            analysis: parsed.analysis,
          },
        };
      } catch (error) {
        if (!isAdminApiRequestStatus(error, 409)) throw error;
        return { kind: "conflict", job: await loadOcrReview(normalizedJobId) };
      }
    },
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
          remoteOcrDemo,
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

const OCR_INTAKE_CATEGORIES = new Set([
  "Deck",
  "Complete",
  "Top",
  "Bottom",
  "Outerwear",
  "Shoes",
  "Accessories",
  "Wheels",
  "Trucks",
  "Bearings",
  "Hardware",
  "Protection",
  "Other",
]);

function isIntakeInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function validateOcrIntakeInput(input: AdminOcrIntakeInput) {
  const plain = (value: unknown): value is Record<string, unknown> => {
    if (
      !isRecord(value) ||
      Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    )
      return false;
    return Reflect.ownKeys(value).every(
      (key) =>
        typeof key === "string" &&
        Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value"),
    );
  };
  const safeText = (value: unknown, maximum: number, empty = false): value is string =>
    typeof value === "string" &&
    value.length <= maximum &&
    (empty || value.trim().length > 0) &&
    !/[\u0000-\u001f\u007f]/u.test(value);
  if (
    !plain(input) ||
    !safeText(input.operationId, 128) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(input.operationId) ||
    !isIntakeInteger(input.quantity, 1, 1_000_000) ||
    !plain(input.source) ||
    Object.keys(input.source).some((key) => !["jobId", "rowIds"].includes(key)) ||
    typeof input.source.jobId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(input.source.jobId) ||
    !Array.isArray(input.source.rowIds) ||
    input.source.rowIds.length < 1 ||
    input.source.rowIds.length > 96 ||
    Object.keys(input.source.rowIds).length !== input.source.rowIds.length ||
    !input.source.rowIds.every(
      (id) => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id),
    ) ||
    new Set(input.source.rowIds).size !== input.source.rowIds.length
  )
    throw new AdminApiResponseError();
  if (input.kind === "existing") {
    if (
      Object.keys(input).some(
        (key) =>
          !["operationId", "quantity", "source", "kind", "existing"].includes(key),
      ) ||
      !plain(input.existing) ||
      Object.keys(input.existing).some(
        (key) => !["productId", "version"].includes(key),
      ) ||
      !safeText(input.existing.productId, 96) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{2,95}$/.test(input.existing.productId) ||
      !isIntakeInteger(input.existing.version, 1, Number.MAX_SAFE_INTEGER - 1)
    )
      throw new AdminApiResponseError();
  } else if (input.kind === "new") {
    const product = input.product;
    if (
      Object.keys(input).some(
        (key) =>
          !["operationId", "quantity", "source", "kind", "product"].includes(key),
      ) ||
      !plain(product) ||
      Object.keys(product).some(
        (key) =>
          !["name", "brandName", "option", "sku", "price", "category"].includes(key),
      ) ||
      !safeText(product.name, 160) ||
      !safeText(product.brandName, 100) ||
      !safeText(product.option, 50, true) ||
      (product.sku !== undefined && !safeText(product.sku, 80)) ||
      !isIntakeInteger(product.price, 0, 100_000_000) ||
      !OCR_INTAKE_CATEGORIES.has(product.category)
    )
      throw new AdminApiResponseError();
  } else throw new AdminApiResponseError();
}

/** Local OCR is an explicit development transport; Cognito authentication still applies. */
export function isLocalOcrDevelopmentMode(): boolean {
  return readLocalOcrApiBaseUrl() !== undefined;
}

/** 별도 공개 설정과 정확한 Firebase origin에서만 임시 HTTPS OCR을 사용합니다. */
export function isRemoteOcrDemoMode(): boolean {
  return readRemoteOcrDemoApiBaseUrl() !== undefined;
}

function readRemoteOcrDemoApiBaseUrl(): string | undefined {
  if (
    process.env.NEXT_PUBLIC_OCR_DEMO_ENABLED !== "true" ||
    typeof window === "undefined" ||
    window.location.origin !== "https://paradays.web.app"
  )
    return undefined;
  try {
    // 발행 시 확인한 단일 HTTPS origin만 pin함. 사용자 입력·저장소는 읽지 않음.
    const allowedOrigin = process.env.NEXT_PUBLIC_OCR_DEMO_ALLOWED_API_ORIGIN;
    const url = new URL(process.env.NEXT_PUBLIC_OCR_DEMO_API_URL ?? "");
    return url.protocol === "https:" &&
      url.origin === allowedOrigin &&
      url.pathname === "/" &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.hostname.includes(".") &&
      !url.hostname.endsWith(".") &&
      !/^(?:[0-9.]+|\[.*\])$/.test(url.hostname) &&
      !["localhost", "paradays.web.app"].includes(url.hostname) &&
      !url.hostname.endsWith(".localhost") &&
      !url.hostname.endsWith(".local")
      ? url.origin
      : undefined;
  } catch {
    return undefined;
  }
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
  // A single product PATCH tells a reserved or duplicate rename apart from a version conflict.
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

const OCR_REGION_FAILURE_MESSAGES: Record<string, Readonly<Record<Locale, string>>> = {
  "region-image-mismatch": {
    ko: "이미지 크기와 원본 OCR 좌표가 맞지 않습니다. 같은 이미지로 다시 인식해 주세요.",
    en: "The image size does not match the original OCR coordinates. Run recognition again with the same image.",
  },
  "missing-geometry": {
    ko: "원본 OCR의 위치 정보가 부족합니다. 더 선명한 이미지로 다시 인식하거나 직접 입력해 주세요.",
    en: "The original OCR is missing position data. Run recognition again with a sharper image or enter it manually.",
  },
  "region-quantity-invalid": {
    ko: "수량 영역에 정수 이외의 글자 또는 여러 값이 있습니다. 가격·상태 문구를 제외하고 실제 수량을 다시 지정해 주세요.",
    en: "The quantity area has non-integer text or several values. Leave out price and status text and set the actual quantity area again.",
  },
  "region-row-spacing-uncertain": {
    ko: "상품 간격을 확정하지 못했습니다. 두 번째 상품 위치와 표 끝을 다시 확인해 주세요.",
    en: "Could not determine the spacing between products. Check the second product position and the table end again.",
  },
  "region-boundary-uncertain": {
    ko: "글자가 영역 경계에 걸려 있습니다. 겹치지 않도록 글자 전체를 포함해 다시 지정해 주세요.",
    en: "Text crosses the area boundary. Set the area again so it includes the whole text without overlap.",
  },
  "region-second-row-required": {
    ko: "수량 영역이 없으면 두 번째 상품 위치로 반복 간격을 지정해 주세요.",
    en: "Without a quantity area, set the repeat spacing with the second product position.",
  },
  "region-footer-uncertain": {
    ko: "표에 합계나 안내 문구가 포함될 수 있습니다. 마지막 상품 바로 아래로 표 끝을 다시 지정해 주세요.",
    en: "The table may include totals or notes. Set the table end right below the last product.",
  },
  "quantity-column-conflict": {
    ko: "금액·번호·상태 영역은 수량으로 사용할 수 없습니다. 실제 수량 영역을 선택해 주세요.",
    en: "Price, number or status areas cannot be used as quantity. Select the actual quantity area.",
  },
};

/** OCR API 실패를 운영자가 조치할 수 있는 문구로 바꿉니다. */
export function getOcrRequestErrorMessage(
  error: unknown,
  locale: Locale = "ko",
): string | undefined {
  const t = (ko: string, en: string) => (locale === "ko" ? ko : en);
  if (error instanceof AdminOcrDemoConnectionError)
    return error.timedOut
      ? t(
          "PC OCR 임시 연결의 2분 대기 시간이 지났습니다. PC와 HTTPS 중계 상태를 확인한 뒤 다시 시도해 주세요. 현재 검토본은 유지됩니다.",
          "The temporary PC OCR connection passed its 2-minute wait. Check the PC and the HTTPS relay, then try again. The current review is kept.",
        )
      : t(
          "PC OCR 임시 연결에 접속하지 못했습니다. 담당 PC나 HTTPS 중계가 꺼져 있거나 주소가 만료되었을 수 있습니다. 연결 상태를 확인한 뒤 다시 시도해 주세요. 현재 검토본은 유지됩니다.",
          "Could not reach the temporary PC OCR connection. The PC or HTTPS relay may be off, or the address may have expired. Check the connection, then try again. The current review is kept.",
        );

  if (
    !(error instanceof AdminApiRequestError) ||
    !error.endpoint.startsWith("admin/ocr/")
  ) {
    return undefined;
  }

  if (error.status === 401 || error.responseCode === "ADMIN_AUTH_REQUIRED") {
    return t(
      "관리자 로그인이 만료되었습니다. 다시 로그인한 뒤 OCR을 실행해 주세요.",
      "Your admin sign-in has expired. Sign in again, then run OCR.",
    );
  }

  if (error.responseCode === "LOCAL_OCR_ORIGIN_REQUIRED")
    return isRemoteOcrDemoMode()
      ? t(
          "PC OCR 임시 연결이 이 화면을 허용하지 않습니다. 담당자가 Firebase 접속 허용 설정을 확인해야 합니다.",
          "The temporary PC OCR connection does not allow this screen. The operator needs to check the Firebase allowed-origin setting.",
        )
      : t(
          "로컬 OCR은 전용 개발 화면 http://localhost:3138/admin에서 실행해 주세요.",
          "Run local OCR from the dedicated development screen at http://localhost:3138/admin.",
        );

  if (error.status === 403 || error.responseCode === "ADMIN_ROLE_REQUIRED") {
    if (readLocalOcrApiBaseUrl() || isRemoteOcrDemoMode()) {
      return t(
        "PC OCR도 서명된 Cognito access token의 admin 그룹 권한이 필요합니다. 그룹 권한이 없으면 사용할 수 없습니다. 다시 로그인해 주세요.",
        "PC OCR also needs the admin group in a signed Cognito access token. It cannot be used without that group. Sign in again.",
      );
    }
    return t(
      "OCR은 admin 그룹 권한이 필요합니다. Cognito admin 그룹을 확인해 주세요.",
      "OCR needs the admin group. Check the Cognito admin group.",
    );
  }

  if (
    error.responseCode === "LOCAL_OCR_LIMIT_REACHED" ||
    error.responseCode === "OCR_PROVIDER_BUSY"
  )
    return isRemoteOcrDemoMode()
      ? t(
          "PC OCR이 처리 중이거나 임시 사용 한도에 도달했습니다. 잠시 후 다시 시도해 주세요. 현재 검토본은 유지됩니다.",
          "PC OCR is busy or has reached its temporary usage limit. Try again shortly. The current review is kept.",
        )
      : t(
          "로컬 OCR이 처리 중이거나 임시 사용 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.",
          "Local OCR is busy or has reached its temporary usage limit. Try again shortly.",
        );
  if (error.responseCode === "LOCAL_OCR_BODY_TIMEOUT")
    return t(
      "PC OCR 이미지 전송 시간이 초과되었습니다. 네트워크 상태를 확인하거나 더 작은 이미지로 다시 시도해 주세요. 현재 검토본은 유지됩니다.",
      "Sending the image to PC OCR timed out. Check the network or try again with a smaller image. The current review is kept.",
    );
  if (isRemoteOcrDemoMode() && error.status >= 500)
    return t(
      "PC OCR 임시 처리에 실패했거나 대기 시간이 지났습니다. 담당 PC와 HTTPS 중계 상태를 확인한 뒤 다시 시도해 주세요. 현재 검토본은 유지됩니다.",
      "Temporary PC OCR processing failed or timed out. Check the PC and the HTTPS relay, then try again. The current review is kept.",
    );
  if (readLocalOcrApiBaseUrl() && error.status >= 500)
    return t(
      "로컬 PaddleOCR 처리에 실패했습니다. 로컬 서버의 실행 상태와 이미지 크기를 확인해 주세요.",
      "Local PaddleOCR processing failed. Check that the local server is running and the image size.",
    );

  if (error.responseCode === "OCR_IMAGE_INVALID") {
    return t(
      "서버가 이미지 형식을 거절했습니다. PNG·JPEG·WEBP이고 파일 내용이 확장자와 일치하는지 확인해 주세요.",
      "The server rejected the image format. Check that it is PNG, JPEG or WEBP and that the content matches the extension.",
    );
  }

  if (error.responseCode === "OCR_IMAGE_TOO_LARGE") {
    return t(
      "현재 직접 OCR은 4MiB 이하만 지원합니다. 더 작은 파일로 다시 선택해 주세요.",
      "Direct OCR currently supports files up to 4MiB. Choose a smaller file.",
    );
  }

  if (
    error.responseCode === "OCR_PROVIDER_CONFIGURATION_UNAVAILABLE" ||
    error.responseCode === "OCR_JOB_CONFIGURATION_UNAVAILABLE"
  ) {
    return t(
      "PaddleOCR 서비스 설정이 비어 있습니다. AWS Secrets Manager paradays-dev/paddle-ocr에 baseUrl·sharedSecret을 넣은 뒤 다시 시도해 주세요.",
      "The PaddleOCR service settings are empty. Add baseUrl and sharedSecret to AWS Secrets Manager paradays-dev/paddle-ocr, then try again.",
    );
  }

  if (error.responseCode === "OCR_PROVIDER_REQUEST_FAILED") {
    return t(
      "관리자 API는 연결됐지만 PaddleOCR 서비스 호출에 실패했습니다. baseUrl·네트워크·공유 비밀값을 확인해 주세요.",
      "The admin API is connected, but calling the PaddleOCR service failed. Check baseUrl, the network and the shared secret.",
    );
  }

  if (error.responseCode === "OCR_PROVIDER_RESPONSE_INVALID") {
    return t(
      "PaddleOCR 응답 형식이 올바르지 않습니다. /ocr 응답의 rec_texts 필드를 확인해 주세요.",
      "The PaddleOCR response format is invalid. Check the rec_texts field of the /ocr response.",
    );
  }

  if (error.responseCode === "OCR_JOB_STORAGE_UNAVAILABLE") {
    return t(
      "OCR 검토 저장소(DynamoDB)에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.",
      "Could not reach the OCR review store (DynamoDB). Try again shortly.",
    );
  }

  if (error.responseCode === "OCR_JOB_RAW_TEXT_INVALID") {
    return t(
      "원문은 100,000자 이하로 입력하고 잘못된 제어 문자를 제거해 주세요.",
      "Keep the source text to 100,000 characters and remove invalid control characters.",
    );
  }

  if (error.responseCode === "OCR_JOB_TOO_LARGE") {
    return t(
      "OCR 검토본이 저장 가능한 크기를 초과했습니다. 원문이나 검토 행을 줄인 뒤 다시 저장해 주세요.",
      "The OCR review is larger than can be saved. Shorten the source text or review rows, then save again.",
    );
  }

  if (
    ["OCR_JOB_MAPPING_INVALID", "OCR_JOB_MAPPING_UNUSABLE"].includes(
      error.responseCode ?? "",
    )
  )
    return error.mappingReason &&
      Object.hasOwn(OCR_REGION_FAILURE_MESSAGES, error.mappingReason)
      ? OCR_REGION_FAILURE_MESSAGES[error.mappingReason][locale] +
          t(" 현재 검토본은 유지됩니다.", " The current review is kept.")
      : t(
          "열 또는 영역 지정으로 상품 행을 확정하지 못했습니다. 선택 영역과 수량·반복 간격을 다시 확인해 주세요. 현재 검토본은 유지됩니다.",
          "Could not determine product rows from the columns or areas. Check the selected areas, quantity and repeat spacing again. The current review is kept.",
        );
  if (error.responseCode === "OCR_JOB_SOURCE_ROWS_UNAVAILABLE")
    return t(
      "이전 검토본에 재분류할 원본 좌표가 없습니다. 이미지를 다시 인식한 뒤 열을 지정해 주세요.",
      "The earlier review has no original coordinates to reclassify. Run recognition on the image again, then set the columns.",
    );

  if (error.status >= 500) {
    return t(
      "OCR 서버 처리에 실패했습니다. PaddleOCR secret 설정과 관리자 API 로그를 확인해 주세요.",
      "OCR server processing failed. Check the PaddleOCR secret settings and the admin API logs.",
    );
  }

  return t(
    "OCR 요청에 실패했습니다. 이미지 형식과 관리자 API·PaddleOCR 연결을 확인해 주세요.",
    "The OCR request failed. Check the image format and the admin API and PaddleOCR connections.",
  );
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
    ...(isDeckSpec(value.deckSpec) ? { deckSpec: copyDeckSpec(value.deckSpec) } : {}),
    ...parseDeckSpecsBySize(value.deckSpecsBySize),
  };
}

/** 서버의 새 옵션 이름 규칙과 같습니다. 다른 옵션과의 중복은 서버가 저장된 목록으로 확인합니다. */
function isNewOptionName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= 50 &&
    name === name.trim() &&
    !/[,\r\n]/.test(name) &&
    !["__proto__", "constructor", "prototype"].includes(name)
  );
}

function copyDeckSpec(spec: DeckSpec): DeckSpec {
  return {
    nose: spec.nose,
    tail: spec.tail,
    width: spec.width,
    length: spec.length,
    wheelbase: spec.wheelbase,
  };
}

/** 옵션별 상세사이즈는 올바른 항목만 남기고, 남은 항목이 없으면 필드를 생략합니다. */
function parseDeckSpecsBySize(value: unknown) {
  if (!isRecord(value)) {
    return {};
  }

  const entries = Object.entries(value).flatMap(([size, spec]) =>
    isDeckSpec(spec) ? [[size, copyDeckSpec(spec)] as const] : [],
  );
  return entries.length ? { deckSpecsBySize: Object.fromEntries(entries) } : {};
}

/** 서버 검증과 같은 범위(0 초과 100인치 이하)만 상세사이즈로 인정합니다. */
function isDeckSpec(value: unknown): value is DeckSpec {
  return (
    isRecord(value) &&
    (["nose", "tail", "width", "length", "wheelbase"] as const).every((field) => {
      const inches = value[field];
      return (
        typeof inches === "number" &&
        Number.isFinite(inches) &&
        inches > 0 &&
        inches <= 100
      );
    })
  );
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

  const todayPaidRevenue = parseOptionalSafeCount(value, "todayPaidRevenue");
  const todaySoldItemCount = parseOptionalSafeCount(value, "todaySoldItemCount");
  const todayNewMemberCount = parseOptionalSafeCount(value, "todayNewMemberCount");

  return {
    asOf: value.asOf,
    timezone: value.timezone,
    todayOrderCount: value.todayOrderCount,
    ...(todayPaidRevenue === undefined ? {} : { todayPaidRevenue }),
    ...(todaySoldItemCount === undefined ? {} : { todaySoldItemCount }),
    ...(todayNewMemberCount === undefined ? {} : { todayNewMemberCount }),
    lowStockCount: value.lowStockCount,
    lowStockThreshold: value.lowStockThreshold,
    activeCouponCount: value.activeCouponCount,
    marketingConsentCount: value.marketingConsentCount,
  };
}

function isSafeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** 새 집계가 없는 구형 응답은 허용하되, 제공한 숫자는 엄격히 검증함. */
function parseOptionalSafeCount(
  value: Record<string, unknown>,
  field: string,
): number | undefined {
  if (!Object.prototype.hasOwnProperty.call(value, field)) {
    return undefined;
  }

  const candidate = value[field];

  if (!isSafeCount(candidate)) {
    throw new AdminApiResponseError();
  }

  return candidate;
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
        ? ""
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

  if (new Set(rows.map((row) => row.id)).size !== rows.length)
    throw new AdminApiResponseError();
  const analysis =
    job.analysis === undefined ? undefined : parseOcrAnalysis(job.analysis);
  return {
    jobId: job.jobId,
    version: job.version,
    rawText: job.rawText,
    rows,
    ...(analysis ? { analysis } : {}),
  };
}

function parseOcrAnalysis(value: unknown): OcrTableAnalysis {
  if (
    !isRecord(value) ||
    !["table", "empty", "unclassified"].includes(String(value.mode)) ||
    (value.reason !== undefined && !isSafeText(value.reason, 100)) ||
    (value.mapping !== undefined && !isOcrMapping(value.mapping))
  )
    throw new AdminApiResponseError();
  let table: OcrTableAnalysis["table"];
  if (value.table !== undefined) {
    const descriptor = value.table;
    if (
      !isRecord(descriptor) ||
      !Number.isInteger(descriptor.headerRow) ||
      (descriptor.headerRow as number) < 0 ||
      (descriptor.headerRow as number) > 499 ||
      !Array.isArray(descriptor.columns) ||
      descriptor.columns.length < 2 ||
      descriptor.columns.length > 20
    )
      throw new AdminApiResponseError();
    table = {
      headerRow: descriptor.headerRow as number,
      columns: descriptor.columns.map((column, index) => {
        if (
          !isRecord(column) ||
          column.index !== index ||
          !isSafeText(column.label, 1000) ||
          ![
            "productName",
            "productInfo",
            "brand",
            "option",
            "quantity",
            "price",
            "ignore",
            "unknown",
          ].includes(String(column.role))
        )
          throw new AdminApiResponseError();
        return { index, label: column.label, role: column.role as string };
      }),
    };
  }
  if (
    value.mapping &&
    isOcrColumnMapping(value.mapping) &&
    table &&
    (value.mapping.headerRow !== table.headerRow ||
      Object.values(value.mapping.columns).some(
        (column) => column !== null && column >= table.columns.length,
      ))
  )
    throw new AdminApiResponseError();
  let region: OcrTableAnalysis["region"];
  if (value.region !== undefined) {
    const report = value.region;
    if (
      !isRecord(report) ||
      ![
        report.sourceTokenCount,
        report.includedTokenCount,
        report.excludedTokenCount,
      ].every(
        (n) => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 500,
      ) ||
      Number(report.includedTokenCount) + Number(report.excludedTokenCount) !==
        report.sourceTokenCount ||
      !Array.isArray(report.warnings) ||
      report.warnings.length > 20 ||
      !report.warnings.every(
        (code) => typeof code === "string" && /^[a-z][a-z0-9-]{0,79}$/u.test(code),
      )
    )
      throw new AdminApiResponseError();
    region = {
      sourceTokenCount: Number(report.sourceTokenCount),
      includedTokenCount: Number(report.includedTokenCount),
      excludedTokenCount: Number(report.excludedTokenCount),
      warnings: report.warnings as string[],
    };
  }
  if (
    value.mode === "table" &&
    (!value.mapping || (value.mapping.schemaVersion === 1 ? !table : !region))
  )
    throw new AdminApiResponseError();
  return {
    mode: value.mode as OcrTableAnalysis["mode"],
    ...(value.reason ? { reason: value.reason as string } : {}),
    ...(table ? { table } : {}),
    ...(value.mapping ? { mapping: value.mapping } : {}),
    ...(region ? { region } : {}),
  };
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
