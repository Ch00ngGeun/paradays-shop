// 역할: 정적 관리자 UI가 Cognito access token으로 AWS Commerce 관리자 API를 호출하게 합니다.
// 기능: 브라우저에는 공개 API URL과 access token만 두고, OCR·권한·provider secret은 Lambda 경계에 남깁니다.

import type { AdminCatalogListItem, AdminOcrIntakeInput } from "@/lib/admin-ui/types";
import { SIZE_CHART_KINDS, isSizeChartKind, isSizeChartValues } from "@/lib/size-chart";
import { isOcrMapping } from "../../infra/lambda/ocr-table-parser.js";
import {
  getCheckoutApiConfig,
  readCheckoutPublicEnvironment,
  type CheckoutPublicEnvironment,
} from "@/lib/commerce/checkout-api-client";
import type {
  AdminApiClient,
  AdminApiClientDependencies,
} from "./admin-api-client-types";
import {
  AdminApiResponseError,
  AdminProductImageInputError,
} from "./admin-api-client-errors";
import {
  readLocalOcrApiBaseUrl,
  readRemoteOcrDemoApiBaseUrl,
} from "./admin-api-client-environment";
import {
  isAdminApiRequestStatus,
  requestJson,
  resolveFetchImplementation,
} from "./admin-api-client-request";
import {
  copyDeckSpec,
  copySizeChartValues,
  isDeckSpec,
  isNewOptionName,
  isRecord,
  parseCatalogListItem,
  parseMember,
  parseOverviewMetrics,
  sameSizeChartValues,
} from "./admin-api-client-response";
import {
  isIntakeInteger,
  isOcrRawText,
  normalizeOcrJobId,
  parseOcrJob,
  serializeOcrImageFile,
  validateOcrIntakeInput,
} from "./admin-api-client-ocr";

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

export { AdminOcrInputError } from "@/lib/admin-ui/ocr-input-validation";

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
  /** 상세사이즈 PATCH 대상의 id·version을 요청 전에 확인합니다. */
  const sizeChartTarget = (input: Readonly<{ id: string; version: number }>) => {
    const productId = input.id.trim();
    if (
      !productId ||
      productId.length > 96 ||
      !Number.isSafeInteger(input.version) ||
      input.version < 1 ||
      input.version > 1_000_000
    )
      throw new AdminApiResponseError();
    return productId;
  };
  /** 상품 하나에 PATCH하고, 저장값을 직접 비교할 수 있게 응답의 raw product를 돌려줍니다. */
  const patchProduct = async (productId: string, body: Record<string, unknown>) => {
    const response = await requestJson({
      apiBaseUrl,
      authorizationTokenProvider: dependencies.authorizationTokenProvider,
      fetchImplementation,
      endpoint: `admin/catalog/products/${encodeURIComponent(productId)}`,
      method: "PATCH",
      body,
    });
    if (!isRecord(response) || !isRecord(response.product))
      throw new AdminApiResponseError();
    return response.product;
  };
  const checkedProduct = (raw: unknown, productId: string, version: number) => {
    const product = parseCatalogListItem(raw);
    if (product.id !== productId || product.version !== version + 1)
      throw new AdminApiResponseError();
    return product;
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
      // 실제로 이름을 바꿀 때만 sizeName을 보내므로 같은 이름 저장은 H-035 요청 본문 그대로 유지됩니다.
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
        // 옵션 저장은 별도 필드를 쓰므로 그 필드를 모르는 서버가 기본값을 덮어쓰지 못합니다.
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
      // 목록 파서는 형식이 틀린 사양을 버려 삭제처럼 보이므로 원본 응답으로 비교합니다.
      const raw = isRecord(body.product) ? body.product : {};
      // shortcut: 구형 서버는 옵션별 map을 돌려주지 않아 무시된 옵션 삭제도 성공처럼 보임. 구분하려면 서버 응답에 처리 표시를 추가해야 함.
      const savedDeckSpec =
        savedKey === undefined
          ? raw.deckSpec
          : isRecord(raw.deckSpecsBySize) &&
              Object.hasOwn(raw.deckSpecsBySize, savedKey)
            ? raw.deckSpecsBySize[savedKey]
            : undefined;
      // sizeName을 무시한 서버는 옛 이름을 그대로 나열하므로 이름 변경이 저장된 것으로 보지 않습니다.
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
    async updateProductSizeChart(input) {
      const productId = sizeChartTarget(input);
      const chart = input.sizeChart;
      if (
        chart !== null &&
        (!isSizeChartKind(chart.kind) || !isSizeChartValues(chart.kind, chart.values))
      )
        throw new AdminApiResponseError();
      const sizeChart = chart && {
        kind: chart.kind,
        values: copySizeChartValues(chart.kind, chart.values),
      };
      const raw = await patchProduct(productId, { version: input.version, sizeChart });
      // 구형 서버는 모르는 필드를 버리므로 저장 뒤 사이즈표가 없으면 실패로 봅니다.
      // shortcut: 같은 구형 서버는 삭제 요청에도 사이즈표 없이 응답해 무시된 삭제도 성공처럼 보임. 구분하려면 서버 응답에 처리 표시를 추가해야 함.
      const saved = raw.sizeChart;
      if (
        sizeChart === null
          ? saved !== undefined
          : !isRecord(saved) ||
            saved.kind !== sizeChart.kind ||
            !sameSizeChartValues(saved.values, sizeChart.values)
      )
        throw new AdminApiResponseError();
      return checkedProduct(raw, productId, input.version);
    },
    async updateProductOptionSizeChart(input) {
      const productId = sizeChartTarget(input);
      const values = input.sizeChartValues;
      const { size } = input;
      if (
        typeof size !== "string" ||
        !size.trim() ||
        size.length > 50 ||
        (input.sizeName !== undefined &&
          input.sizeName !== size &&
          !isNewOptionName(input.sizeName)) ||
        // 도면 종류는 서버가 정하므로 값은 적어도 한 도면 종류의 형식에는 맞아야 합니다.
        (values !== null &&
          !SIZE_CHART_KINDS.some((kind) => isSizeChartValues(kind, values)))
      )
        throw new AdminApiResponseError();
      // 데크 옵션 저장과 같이 실제로 이름을 바꿀 때만 sizeName을 보냅니다.
      const sizeName =
        input.sizeName !== undefined && input.sizeName !== size
          ? input.sizeName
          : undefined;
      const savedKey = sizeName ?? size;
      const raw = await patchProduct(productId, {
        version: input.version,
        size,
        ...(sizeName === undefined ? {} : { sizeName }),
        sizeChartValues: values && { ...values },
      });
      // shortcut: 구형 서버는 옵션별 map을 돌려주지 않아 무시된 옵션 삭제도 성공처럼 보임. 구분하려면 서버 응답에 처리 표시를 추가해야 함.
      const saved =
        isRecord(raw.sizeChartsBySize) && Object.hasOwn(raw.sizeChartsBySize, savedKey)
          ? raw.sizeChartsBySize[savedKey]
          : undefined;
      const renamed =
        sizeName === undefined ||
        (Array.isArray(raw.sizes) &&
          raw.sizes.includes(sizeName) &&
          !raw.sizes.includes(size));
      if (
        !renamed ||
        (values === null
          ? saved !== undefined
          : !isSizeChartKind(raw.sizeChartKind) ||
            !isSizeChartValues(raw.sizeChartKind, saved) ||
            !sameSizeChartValues(saved, values))
      )
        throw new AdminApiResponseError();
      return checkedProduct(raw, productId, input.version);
    },
    async updateProductSizeChartKind(input) {
      const productId = sizeChartTarget(input);
      if (!isSizeChartKind(input.sizeChartKind)) throw new AdminApiResponseError();
      const raw = await patchProduct(productId, {
        version: input.version,
        sizeChartKind: input.sizeChartKind,
      });
      // 구형 서버는 이 필드를 무시해 도면 종류를 돌려주지 않으므로 여기서 실패합니다.
      if (raw.sizeChartKind !== input.sizeChartKind) throw new AdminApiResponseError();
      return checkedProduct(raw, productId, input.version);
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
