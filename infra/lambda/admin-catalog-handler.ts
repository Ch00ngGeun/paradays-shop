/**
 * 역할: 관리자만 상품 초안·공개 상품을 저장하고 관리하게 함.
 * 기능: 허용된 카탈로그 필드만 DynamoDB에 기록하고, 버전 조건식으로 동시 편집 덮어쓰기를 막음.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  GetCommand,
  ScanCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from "aws-lambda";

import { authorizeAdmin } from "./admin-auth.js";
import {
  findCatalogDuplicateIds,
  parseCatalogIntakeRequest,
  type CatalogIntakeRequest,
} from "./catalog-intake.js";
import { documentClient, getRequiredEnvironment } from "./dynamodb-client.js";
import { jsonResponse } from "./http-response.js";
import { isRecord, parseJsonBody, readBoundedString } from "./request-helpers.js";

/** 상품 상태는 공개 여부를 가리키는 두 값으로 고정합니다. */
export type CatalogProductStatus = "DRAFT" | "PUBLISHED";

/** 로케일별 상품명 쌍 (등록 시 클라이언트 자동 번역으로 채움). */
export type CatalogNameI18n = Readonly<{ en: string; ko: string }>;

/** 로케일별 스펙 줄 쌍. */
export type CatalogDescriptionI18n = Readonly<{
  en: readonly string[];
  ko: readonly string[];
}>;

/** DynamoDB catalog table에 저장하는 정규화된 상품 행입니다. */
export type CatalogProductRecord = Readonly<{
  productId: string;
  slug: string;
  name: string;
  nameI18n?: CatalogNameI18n;
  sku?: string;
  brandId: string;
  brandName: string;
  category: CatalogCategory;
  price: number;
  compareAtPrice?: number;
  currency: "KRW";
  status: CatalogProductStatus;
  /** 공개 상품 GSI가 사용할 고정 partition 값. status와 같은 값만 저장합니다. */
  publicationStatus: CatalogProductStatus;
  inventoryQuantity: number;
  /** Server-owned holds; omitted legacy value means zero, never accepted from an admin body. */
  inventoryReserved?: number;
  /** Outstanding proven sales keep their catalog identity until physically restored. */
  inventoryCommitted?: number;
  featured: boolean;
  image?: string;
  images: readonly string[];
  description: readonly string[];
  descriptionI18n?: CatalogDescriptionI18n;
  sizes: readonly string[];
  version: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
}>;

/** 스토어프론트가 공개 상품에만 쓸 수 있는 민감하지 않은 공통 상품 shape입니다. */
export type PublicCatalogProduct = Readonly<{
  id: string;
  slug: string;
  name: string;
  nameI18n?: CatalogNameI18n;
  category: CatalogCategory;
  brand: string;
  price: number;
  compareAtPrice?: number;
  image: string;
  images?: string[];
  description: string[];
  descriptionI18n?: CatalogDescriptionI18n;
  sizes: string[];
  /** soldout 정렬·표시용. SKU·원가 등 민감 값은 포함하지 않음 */
  inventoryQuantity: number;
  /** 신상품 New 배지 */
  featured: boolean;
}>;

/** 관리자 UI에 반환하는 allowlist 기반 상품 shape입니다. audit subject 등 저장 원본은 제외합니다. */
export type AdminCatalogProduct = Readonly<{
  productId: string;
  slug: string;
  name: string;
  nameI18n?: CatalogNameI18n;
  sku?: string;
  brandId: string;
  brandName: string;
  category: CatalogCategory;
  price: number;
  compareAtPrice?: number;
  currency: "KRW";
  status: CatalogProductStatus;
  inventoryQuantity: number;
  featured: boolean;
  image?: string;
  images: readonly string[];
  description: readonly string[];
  descriptionI18n?: CatalogDescriptionI18n;
  sizes: readonly string[];
  version: number;
  createdAt: string;
  updatedAt: string;
}>;

/** 관리자 화면에서 선택할 수 있는 카테고리를 고정해 임의 분류 값의 누적을 막습니다. */
const CATALOG_CATEGORIES = [
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
] as const;

type CatalogCategory = (typeof CATALOG_CATEGORIES)[number];

const PRODUCT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,96}$/;
const MAX_PRICE = 100_000_000;
const MAX_INVENTORY = 1_000_000;
const CATALOG_REVISION_KEY = "~catalog_revision";
const CATALOG_RECEIPT_PREFIX = "~catalog_receipt_";
const INTERNAL_KEY_PATTERN = /^~catalog_(?:revision|(?:receipt|claim)_[a-f0-9]{64})$/;
const MAX_IDENTITY_SCAN_PAGES = 1_000;
const MAX_IDENTITY_SCAN_RAW_ITEMS = 1_000_000;
const MAX_IDENTITY_SCAN_PRODUCTS = 5_000;
const IDENTITY_SCAN_PAGE_LIMIT = 1_000;
const IDENTITY_SCAN_DEADLINE_MS = 5_000;

type ProductInput = Omit<
  CatalogProductRecord,
  "productId" | "version" | "createdAt" | "updatedAt" | "createdBy" | "updatedBy"
>;

type CatalogRoute =
  | Readonly<{ kind: "collection" }>
  | Readonly<{ kind: "item"; productId: string }>;

/** /admin/catalog/products CRUD를 route·method별로 처리합니다. API Gateway JWT 외에 admin group도 반드시 확인합니다. */
export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> {
  const authorization = await authorizeAdmin(event);

  if (!authorization.ok) {
    return jsonResponse(authorization.statusCode, { code: authorization.code });
  }

  const route = resolveCatalogRoute(event);

  if (!route) {
    return jsonResponse(404, { code: "ADMIN_CATALOG_ROUTE_NOT_FOUND" });
  }

  let catalogTableName: string;

  try {
    catalogTableName = getRequiredEnvironment("CATALOG_TABLE_NAME");
  } catch {
    return jsonResponse(503, { code: "CATALOG_CONFIGURATION_UNAVAILABLE" });
  }

  const method = event.requestContext.http.method;

  if (route.kind === "collection") {
    if (method === "GET") {
      return listProducts(catalogTableName, event);
    }

    if (method === "POST") {
      return createProduct(catalogTableName, event, authorization.userSub);
    }

    return jsonResponse(405, { code: "METHOD_NOT_ALLOWED" });
  }

  if (method === "GET") {
    return getProduct(catalogTableName, route.productId);
  }

  if (method === "PATCH") {
    return updateProduct(
      catalogTableName,
      route.productId,
      event,
      authorization.userSub,
    );
  }

  if (method === "DELETE") {
    return deleteProduct(catalogTableName, route.productId, event);
  }

  return jsonResponse(405, { code: "METHOD_NOT_ALLOWED" });
}

/** GET collection: 매번 제한된 수만 scan하고, 생성한 cursor만 다음 페이지 시작 키로 복원합니다. */
async function listProducts(
  catalogTableName: string,
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
) {
  const status = readStatusFilter(event.queryStringParameters?.status);

  if (event.queryStringParameters?.status && !status) {
    return jsonResponse(400, { code: "CATALOG_STATUS_INVALID" });
  }

  const limit = readListLimit(event.queryStringParameters?.limit);

  if (!limit) {
    return jsonResponse(400, { code: "CATALOG_LIMIT_INVALID" });
  }

  const exclusiveStartKey = decodeCursor(event.queryStringParameters?.cursor);

  if (event.queryStringParameters?.cursor && !exclusiveStartKey) {
    return jsonResponse(400, { code: "CATALOG_CURSOR_INVALID" });
  }

  try {
    const response = await documentClient.send(
      new ScanCommand({
        TableName: catalogTableName,
        Limit: limit,
        ExclusiveStartKey: exclusiveStartKey,
        ...(status
          ? {
              FilterExpression: "#status = :status",
              ExpressionAttributeNames: { "#status": "status" },
              ExpressionAttributeValues: { ":status": status },
            }
          : {}),
      }),
    );

    const nextCursor = encodeCursor(response.LastEvaluatedKey);

    return jsonResponse(200, {
      products: (response.Items ?? [])
        .filter(isCatalogProductRecord)
        .map(toAdminCatalogProduct),
      ...(nextCursor ? { nextCursor } : {}),
    });
  } catch {
    return jsonResponse(503, { code: "CATALOG_STORAGE_UNAVAILABLE" });
  }
}

/** POST collection: 새 상품은 항상 version 1로 만들고 productId 중복 저장을 조건식으로 막습니다. */
async function createProduct(
  catalogTableName: string,
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
  userSub: string,
) {
  const body = parseJsonBody(event);
  if (
    isRecord(body) &&
    (hasOwn(body, "inventoryReserved") || hasOwn(body, "inventoryCommitted"))
  )
    return jsonResponse(400, { code: "CATALOG_RESERVED_SERVER_OWNED" });
  if (isRecord(body) && hasOwn(body, "action")) {
    const intake = parseCatalogIntakeRequest(body);
    return intake
      ? commitCatalogIntake(catalogTableName, intake, userSub)
      : jsonResponse(400, { code: "OCR_INTAKE_INVALID" });
  }
  const input = parseProductInput(body);

  if (!input) {
    return jsonResponse(400, { code: "CATALOG_PRODUCT_INVALID" });
  }

  const requestedProductId =
    isRecord(body) && "productId" in body ? readProductId(body.productId) : undefined;

  if (isRecord(body) && "productId" in body && !requestedProductId) {
    return jsonResponse(400, { code: "CATALOG_PRODUCT_ID_INVALID" });
  }

  const timestamp = new Date().toISOString();
  const product: CatalogProductRecord = {
    productId: requestedProductId ?? `prd_${randomUUID()}`,
    ...input,
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    createdBy: userSub,
    updatedBy: userSub,
  };

  try {
    const revision = await readCatalogRevision(catalogTableName);
    if (requestedProductId) {
      const existing = await readProduct(catalogTableName, requestedProductId);
      if (existing === undefined) throw new Error("CATALOG_READ_UNAVAILABLE");
      if (existing) return jsonResponse(409, { code: "CATALOG_PRODUCT_ID_CONFLICT" });
    }
    const duplicates = await readCatalogDuplicates(catalogTableName, product);
    if (duplicates.length) {
      return jsonResponse(409, {
        code: "CATALOG_PRODUCT_DUPLICATE",
        productIds: duplicates,
      });
    }
    await documentClient.send(
      new TransactWriteCommand({
        TransactItems: [
          revisionWrite(catalogTableName, revision),
          {
            Put: {
              TableName: catalogTableName,
              Item: product,
              ConditionExpression: "attribute_not_exists(productId)",
            },
          },
        ],
      }),
    );
  } catch (error) {
    if (isConditionalWriteError(error)) {
      return jsonResponse(409, { code: "CATALOG_IDENTITY_CONFLICT" });
    }

    return jsonResponse(503, { code: "CATALOG_STORAGE_UNAVAILABLE" });
  }

  return jsonResponse(201, { product: toAdminCatalogProduct(product) });
}

type IntakeReceipt = Readonly<{
  operationId: string;
  kind: "existing" | "new";
  quantity: number;
  beforeStock: number;
  afterStock: number;
  replayed: boolean;
}>;
type IntakeOutcome = Readonly<{ product: AdminCatalogProduct; receipt: IntakeReceipt }>;

/** A durable receipt and the product mutation commit together. A replay never recomputes or adds stock. */
async function commitCatalogIntake(
  catalogTableName: string,
  input: CatalogIntakeRequest,
  userSub: string,
): Promise<APIGatewayProxyResultV2> {
  const receiptKey = `${CATALOG_RECEIPT_PREFIX}${sha256(input.operationId)}`;
  const ownerHash = sha256(userSub);
  const claimKeys = input.source.rowIds.map(
    (rowId) => `~catalog_claim_${sha256(JSON.stringify([input.source.jobId, rowId]))}`,
  );
  const payload: Record<string, unknown> = { ...input };
  delete payload.action;
  const payloadHash = sha256(JSON.stringify(payload));
  const replay = async () => {
    const response = await documentClient.send(
      new GetCommand({
        TableName: catalogTableName,
        Key: { productId: receiptKey },
        ConsistentRead: true,
      }),
    );
    if (!response.Item) return null;
    const item = response.Item;
    if (
      item.recordType !== "CATALOG_INTAKE_RECEIPT" ||
      item.ownerHash !== ownerHash ||
      item.payloadHash !== payloadHash
    ) {
      return jsonResponse(409, { code: "OCR_INTAKE_OPERATION_CONFLICT" });
    }
    if (!isStoredIntakeOutcome(item.outcome, input))
      throw new Error("CATALOG_RECEIPT_INVALID");
    return jsonResponse(200, {
      product: toAdminCatalogProduct({
        ...item.outcome.product,
        publicationStatus: item.outcome.product.status,
        createdBy: "",
        updatedBy: "",
      }),
      receipt: {
        operationId: item.outcome.receipt.operationId,
        kind: item.outcome.receipt.kind,
        quantity: item.outcome.receipt.quantity,
        beforeStock: item.outcome.receipt.beforeStock,
        afterStock: item.outcome.receipt.afterStock,
        replayed: true,
      },
    });
  };

  try {
    const previous = await replay();
    if (previous) return previous;
    // The same operation may commit after the receipt read above; recheck before any early failure.
    const failUnlessReplayed = async (response: APIGatewayProxyResultV2) =>
      (await replay()) ?? response;
    // Read the revision before identity scans. Every handler mutation changes it in its transaction.
    const revision = await readCatalogRevision(catalogTableName);
    const timestamp = new Date().toISOString();
    let product: CatalogProductRecord;
    let beforeStock: number;
    let productWrite: NonNullable<TransactWriteCommandInput["TransactItems"]>[number];
    if (input.kind === "existing") {
      const existing = await readProduct(catalogTableName, input.existing.productId);
      if (existing === undefined) throw new Error("CATALOG_READ_UNAVAILABLE");
      if (!existing)
        return failUnlessReplayed(
          jsonResponse(404, { code: "CATALOG_PRODUCT_NOT_FOUND" }),
        );
      if (existing.version !== input.existing.version)
        return failUnlessReplayed(
          jsonResponse(409, {
            code: "CATALOG_PRODUCT_VERSION_CONFLICT",
            product: toAdminCatalogProduct(existing),
          }),
        );
      beforeStock = existing.inventoryQuantity;
      const afterStock = beforeStock + input.quantity;
      if (!isInventoryQuantity(afterStock))
        return failUnlessReplayed(jsonResponse(400, { code: "OCR_INTAKE_INVALID" }));
      product = {
        ...existing,
        inventoryQuantity: afterStock,
        version: existing.version + 1,
        updatedAt: timestamp,
        updatedBy: userSub,
      };
      productWrite = {
        Put: {
          TableName: catalogTableName,
          Item: product,
          ConditionExpression: "#version = :expectedVersion",
          ExpressionAttributeNames: { "#version": "version" },
          ExpressionAttributeValues: { ":expectedVersion": input.existing.version },
        },
      };
    } else {
      const productId = `prd_${randomUUID()}`;
      const normalized = parseProductInput({
        slug: productId,
        name: input.product.name,
        brandName: input.product.brandName,
        ...(input.product.sku ? { sku: input.product.sku } : {}),
        price: input.product.price,
        category: input.product.category,
        sizes: input.product.option ? [input.product.option] : [],
        stock: input.quantity,
        status: "DRAFT",
        featured: false,
      });
      if (!normalized)
        return failUnlessReplayed(jsonResponse(400, { code: "OCR_INTAKE_INVALID" }));
      product = {
        ...normalized,
        productId,
        version: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        createdBy: userSub,
        updatedBy: userSub,
      };
      beforeStock = 0;
      const duplicates = await readCatalogDuplicates(catalogTableName, product);
      if (duplicates.length)
        return failUnlessReplayed(
          jsonResponse(409, {
            code: "CATALOG_PRODUCT_DUPLICATE",
            productIds: duplicates,
          }),
        );
      productWrite = {
        Put: {
          TableName: catalogTableName,
          Item: product,
          ConditionExpression: "attribute_not_exists(productId)",
        },
      };
    }
    const outcome: IntakeOutcome = {
      product: toAdminCatalogProduct(product),
      receipt: {
        operationId: input.operationId,
        kind: input.kind,
        quantity: input.quantity,
        beforeStock,
        afterStock: product.inventoryQuantity,
        replayed: false,
      },
    };
    await documentClient.send(
      new TransactWriteCommand({
        TransactItems: [
          revisionWrite(catalogTableName, revision),
          productWrite,
          {
            Put: {
              TableName: catalogTableName,
              Item: {
                productId: receiptKey,
                recordType: "CATALOG_INTAKE_RECEIPT",
                ownerHash,
                payloadHash,
                outcome,
                createdAt: timestamp,
              },
              ConditionExpression: "attribute_not_exists(productId)",
            },
          },
          ...claimKeys.map((productId) => ({
            Put: {
              TableName: catalogTableName,
              Item: {
                productId,
                recordType: "CATALOG_INTAKE_ROW_CLAIM",
                operationHash: sha256(input.operationId),
                ownerHash,
              },
              ConditionExpression: "attribute_not_exists(productId)",
            },
          })),
        ],
      }),
    );
    return jsonResponse(input.kind === "new" ? 201 : 200, outcome);
  } catch (error) {
    if (isConditionalWriteError(error)) {
      try {
        const previous = await replay();
        if (previous) return previous;
        // A row remains claimed even if the original group is split, merged, or retargeted.
        for (const productId of claimKeys) {
          const claim = await documentClient.send(
            new GetCommand({
              TableName: catalogTableName,
              Key: { productId },
              ConsistentRead: true,
            }),
          );
          if (claim.Item) return jsonResponse(409, { code: "OCR_INTAKE_ROW_CONFLICT" });
        }
      } catch {
        return jsonResponse(503, { code: "CATALOG_STORAGE_UNAVAILABLE" });
      }
      return jsonResponse(409, {
        code:
          input.kind === "existing"
            ? "CATALOG_PRODUCT_VERSION_CONFLICT"
            : "CATALOG_IDENTITY_CONFLICT",
      });
    }
    return jsonResponse(503, { code: "CATALOG_STORAGE_UNAVAILABLE" });
  }
}

/** Internal rows have no publication/slug/stock at the top level, and no TTL is assumed. */
async function readCatalogRevision(catalogTableName: string): Promise<number> {
  const response = await documentClient.send(
    new GetCommand({
      TableName: catalogTableName,
      Key: { productId: CATALOG_REVISION_KEY },
      ConsistentRead: true,
    }),
  );
  if (!response.Item) return 0;
  if (
    response.Item.recordType !== "CATALOG_IDENTITY_REVISION" ||
    !Number.isSafeInteger(response.Item.version) ||
    response.Item.version < 1 ||
    response.Item.version >= Number.MAX_SAFE_INTEGER
  )
    throw new Error("CATALOG_REVISION_INVALID");
  return response.Item.version as number;
}

function revisionWrite(
  catalogTableName: string,
  revision: number,
): NonNullable<TransactWriteCommandInput["TransactItems"]>[number] {
  return {
    Put: {
      TableName: catalogTableName,
      Item: {
        productId: CATALOG_REVISION_KEY,
        recordType: "CATALOG_IDENTITY_REVISION",
        version: revision + 1,
      },
      ...(revision === 0
        ? { ConditionExpression: "attribute_not_exists(productId)" }
        : {
            ConditionExpression: "#version = :expectedVersion",
            ExpressionAttributeNames: { "#version": "version" },
            ExpressionAttributeValues: { ":expectedVersion": revision },
          }),
    },
  };
}

/** Strong reads plus a transaction revision check cover legacy rows without adding a table/index. */
async function readCatalogDuplicates(
  catalogTableName: string,
  incoming: CatalogProductRecord,
  excludedProductId?: string,
): Promise<readonly string[]> {
  let cursor: Record<string, unknown> | undefined;
  let scanned = 0;
  const products: CatalogProductRecord[] = [];
  const abort = new AbortController();
  const deadline = Date.now() + IDENTITY_SCAN_DEADLINE_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abort.abort();
      reject(new Error("CATALOG_IDENTITY_SCAN_TIMEOUT"));
    }, IDENTITY_SCAN_DEADLINE_MS);
    timer.unref?.();
  });
  try {
    for (let page = 0; page < MAX_IDENTITY_SCAN_PAGES; page += 1) {
      if (Date.now() >= deadline) throw new Error("CATALOG_IDENTITY_SCAN_TIMEOUT");
      const response = await Promise.race([
        documentClient.send(
          new ScanCommand({
            TableName: catalogTableName,
            ConsistentRead: true,
            Limit: IDENTITY_SCAN_PAGE_LIMIT,
            ExclusiveStartKey: cursor,
          }),
          { abortSignal: abort.signal },
        ),
        timeout,
      ]);
      if (Date.now() >= deadline) throw new Error("CATALOG_IDENTITY_SCAN_TIMEOUT");
      scanned += Math.max(response.ScannedCount ?? 0, response.Items?.length ?? 0);
      if (scanned > MAX_IDENTITY_SCAN_RAW_ITEMS)
        throw new Error("CATALOG_IDENTITY_SCAN_LIMIT");
      for (const item of response.Items ?? []) {
        if (
          typeof item.productId === "string" &&
          INTERNAL_KEY_PATTERN.test(item.productId)
        )
          continue;
        if (!isCatalogProductRecord(item))
          throw new Error("CATALOG_IDENTITY_RECORD_INVALID");
        products.push(item);
        if (products.length > MAX_IDENTITY_SCAN_PRODUCTS)
          throw new Error("CATALOG_IDENTITY_SCAN_LIMIT");
      }
      if (Date.now() >= deadline) throw new Error("CATALOG_IDENTITY_SCAN_TIMEOUT");
      cursor = response.LastEvaluatedKey as Record<string, unknown> | undefined;
      if (!cursor) {
        const duplicates = findCatalogDuplicateIds(
          incoming,
          products,
          excludedProductId,
        );
        if (Date.now() >= deadline) throw new Error("CATALOG_IDENTITY_SCAN_TIMEOUT");
        return duplicates;
      }
    }
    throw new Error("CATALOG_IDENTITY_SCAN_LIMIT");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    abort.abort();
  }
}

function isStoredIntakeOutcome(
  value: unknown,
  input: CatalogIntakeRequest,
): value is IntakeOutcome {
  if (!isRecord(value) || !isRecord(value.product) || !isRecord(value.receipt))
    return false;
  const receipt = value.receipt;
  return Boolean(
    readProductId(value.product.productId) &&
      readVersion(value.product.version) &&
      parseProductInput(value.product) &&
      typeof value.product.createdAt === "string" &&
      typeof value.product.updatedAt === "string" &&
      receipt.operationId === input.operationId &&
      receipt.kind === input.kind &&
      receipt.quantity === input.quantity &&
      isInventoryQuantity(receipt.beforeStock) &&
      isInventoryQuantity(receipt.afterStock) &&
      receipt.afterStock === receipt.beforeStock + receipt.quantity &&
      value.product.inventoryQuantity === receipt.afterStock &&
      receipt.replayed === false,
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** GET item: 저장 원본이 아닌 allowlist 기반 관리자 shape만 반환합니다. */
async function getProduct(catalogTableName: string, productId: string) {
  const product = await readProduct(catalogTableName, productId);

  if (product === undefined) {
    return jsonResponse(503, { code: "CATALOG_STORAGE_UNAVAILABLE" });
  }

  if (!product) {
    return jsonResponse(404, { code: "CATALOG_PRODUCT_NOT_FOUND" });
  }

  return jsonResponse(200, { product: toAdminCatalogProduct(product) });
}

/** PATCH item: caller version과 저장 version이 같을 때만 전체 allowlist record를 조건부 교체합니다. */
async function updateProduct(
  catalogTableName: string,
  productId: string,
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
  userSub: string,
) {
  const body = parseJsonBody(event);

  if (!isRecord(body)) {
    return jsonResponse(400, { code: "CATALOG_PRODUCT_INVALID" });
  }

  const expectedVersion = readVersion(body.version);
  if (hasOwn(body, "inventoryReserved") || hasOwn(body, "inventoryCommitted"))
    return jsonResponse(400, { code: "CATALOG_RESERVED_SERVER_OWNED" });

  if (!expectedVersion) {
    return jsonResponse(400, { code: "CATALOG_PRODUCT_VERSION_REQUIRED" });
  }

  const existingProduct = await readProduct(catalogTableName, productId);

  if (existingProduct === undefined) {
    return jsonResponse(503, { code: "CATALOG_STORAGE_UNAVAILABLE" });
  }

  if (!existingProduct) {
    return jsonResponse(404, { code: "CATALOG_PRODUCT_NOT_FOUND" });
  }

  if (existingProduct.version !== expectedVersion) {
    return jsonResponse(409, {
      code: "CATALOG_PRODUCT_VERSION_CONFLICT",
      product: toAdminCatalogProduct(existingProduct),
    });
  }

  const input = parseProductInput(mergeProductPatch(existingProduct, body));

  if (!input) {
    return jsonResponse(400, { code: "CATALOG_PRODUCT_INVALID" });
  }

  const reserved = existingProduct.inventoryReserved ?? 0;
  // The admin form always resends these fields, so only an actual value change is blocked.
  const reservedIdentityChanged = (
    ["sizes", "price", "name", "brandName", "sku"] as const
  ).some(
    (field) => JSON.stringify(input[field]) !== JSON.stringify(existingProduct[field]),
  );
  if (input.inventoryQuantity < reserved || (reserved > 0 && reservedIdentityChanged))
    return jsonResponse(409, { code: "CATALOG_PRODUCT_RESERVED" });

  const existingWithoutCompareAtPrice = { ...existingProduct };
  delete existingWithoutCompareAtPrice.compareAtPrice;
  const updatedProduct: CatalogProductRecord = {
    ...(hasOwn(body, "compareAtPrice")
      ? existingWithoutCompareAtPrice
      : existingProduct),
    ...input,
    version: existingProduct.version + 1,
    updatedAt: new Date().toISOString(),
    updatedBy: userSub,
  };

  try {
    const revision = await readCatalogRevision(catalogTableName);
    const identityChanged = ["name", "brandName", "brand", "sku", "sizes"].some(
      (field) => hasOwn(body, field),
    );
    if (identityChanged) {
      const duplicates = await readCatalogDuplicates(
        catalogTableName,
        updatedProduct,
        productId,
      );
      if (duplicates.length)
        return jsonResponse(409, {
          code: "CATALOG_PRODUCT_DUPLICATE",
          productIds: duplicates,
        });
    }
    await documentClient.send(
      new TransactWriteCommand({
        TransactItems: [
          revisionWrite(catalogTableName, revision),
          {
            Put: {
              TableName: catalogTableName,
              Item: updatedProduct,
              ConditionExpression: "#version = :expectedVersion",
              ExpressionAttributeNames: { "#version": "version" },
              ExpressionAttributeValues: { ":expectedVersion": expectedVersion },
            },
          },
        ],
      }),
    );
  } catch (error) {
    if (isConditionalWriteError(error)) {
      return jsonResponse(409, { code: "CATALOG_PRODUCT_VERSION_CONFLICT" });
    }

    return jsonResponse(503, { code: "CATALOG_STORAGE_UNAVAILABLE" });
  }

  return jsonResponse(200, { product: toAdminCatalogProduct(updatedProduct) });
}

/** DELETE item: 오래된 화면의 삭제 요청도 version 조건으로 다른 관리자의 수정 내용을 보존합니다. */
async function deleteProduct(
  catalogTableName: string,
  productId: string,
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
) {
  const body = parseJsonBody(event);
  const versionFromBody = isRecord(body) ? readVersion(body.version) : undefined;
  const versionFromQuery = readVersion(event.queryStringParameters?.version);
  const expectedVersion = versionFromBody ?? versionFromQuery;

  if (!expectedVersion) {
    return jsonResponse(400, { code: "CATALOG_PRODUCT_VERSION_REQUIRED" });
  }

  try {
    const revision = await readCatalogRevision(catalogTableName);
    await documentClient.send(
      new TransactWriteCommand({
        TransactItems: [
          revisionWrite(catalogTableName, revision),
          {
            Delete: {
              TableName: catalogTableName,
              Key: { productId },
              ConditionExpression:
                "#version = :expectedVersion AND (attribute_not_exists(inventoryReserved) OR inventoryReserved = :zero) AND (attribute_not_exists(inventoryCommitted) OR inventoryCommitted = :zero)",
              ExpressionAttributeNames: { "#version": "version" },
              ExpressionAttributeValues: {
                ":expectedVersion": expectedVersion,
                ":zero": 0,
              },
            },
          },
        ],
      }),
    );
  } catch (error) {
    if (isConditionalWriteError(error)) {
      return jsonResponse(409, { code: "CATALOG_PRODUCT_VERSION_CONFLICT" });
    }

    return jsonResponse(503, { code: "CATALOG_STORAGE_UNAVAILABLE" });
  }

  return jsonResponse(200, { deletedProductId: productId });
}

/** primary key로 strong read해 갱신 전에 최신 version을 확인합니다. */
async function readProduct(catalogTableName: string, productId: string) {
  try {
    const response = await documentClient.send(
      new GetCommand({
        TableName: catalogTableName,
        Key: { productId },
        ConsistentRead: true,
      }),
    );

    return isCatalogProductRecord(response.Item) ? response.Item : null;
  } catch {
    return undefined;
  }
}

/** DynamoDB storage item이 현재 catalog schema의 필수 타입을 갖는지 엄격하게 좁힙니다. */
export function isCatalogProductRecord(value: unknown): value is CatalogProductRecord {
  return (
    isRecord(value) &&
    typeof value.productId === "string" &&
    typeof value.slug === "string" &&
    typeof value.name === "string" &&
    (value.nameI18n === undefined || isCatalogNameI18n(value.nameI18n)) &&
    (value.sku === undefined || typeof value.sku === "string") &&
    typeof value.brandId === "string" &&
    typeof value.brandName === "string" &&
    isCatalogCategory(value.category) &&
    isKrwAmount(value.price) &&
    (value.compareAtPrice === undefined || isKrwAmount(value.compareAtPrice)) &&
    value.currency === "KRW" &&
    isCatalogProductStatus(value.status) &&
    value.publicationStatus === value.status &&
    isInventoryQuantity(value.inventoryQuantity) &&
    (value.inventoryReserved === undefined ||
      (isInventoryQuantity(value.inventoryReserved) &&
        value.inventoryReserved <= value.inventoryQuantity)) &&
    (value.inventoryCommitted === undefined ||
      (typeof value.inventoryCommitted === "number" &&
        Number.isSafeInteger(value.inventoryCommitted) &&
        value.inventoryCommitted >= 0)) &&
    typeof value.featured === "boolean" &&
    (value.image === undefined || typeof value.image === "string") &&
    isStringArray(value.images) &&
    isStringArray(value.description) &&
    (value.descriptionI18n === undefined ||
      isCatalogDescriptionI18n(value.descriptionI18n)) &&
    isStringArray(value.sizes) &&
    typeof value.version === "number" &&
    Number.isSafeInteger(value.version) &&
    value.version > 0 &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    typeof value.createdBy === "string" &&
    typeof value.updatedBy === "string"
  );
}

/** 공개된 상품만 storefront contract로 변환합니다. 초안은 null로 숨겨 caller 실수를 줄입니다. */
export function toPublicCatalogProduct(
  product: CatalogProductRecord,
): PublicCatalogProduct | null {
  if (product.status !== "PUBLISHED" || !product.image) {
    return null;
  }

  return {
    id: product.productId,
    slug: product.slug,
    name: product.name,
    ...(product.nameI18n ? { nameI18n: { ...product.nameI18n } } : {}),
    category: product.category,
    brand: product.brandName,
    price: product.price,
    ...(product.compareAtPrice ? { compareAtPrice: product.compareAtPrice } : {}),
    image: product.image,
    ...(product.images.length > 1 ? { images: [...product.images] } : {}),
    description: [...product.description],
    ...(product.descriptionI18n
      ? {
          descriptionI18n: {
            en: [...product.descriptionI18n.en],
            ko: [...product.descriptionI18n.ko],
          },
        }
      : {}),
    sizes: [...product.sizes],
    inventoryQuantity: product.inventoryQuantity - (product.inventoryReserved ?? 0),
    featured: product.featured,
  };
}

/** 관리자 응답은 변경에 필요한 필드만 선택하며 audit subject 등 raw Dynamo 속성은 노출하지 않습니다. */
export function toAdminCatalogProduct(
  product: CatalogProductRecord,
): AdminCatalogProduct {
  return {
    productId: product.productId,
    slug: product.slug,
    name: product.name,
    ...(product.nameI18n ? { nameI18n: { ...product.nameI18n } } : {}),
    ...(product.sku ? { sku: product.sku } : {}),
    brandId: product.brandId,
    brandName: product.brandName,
    category: product.category,
    price: product.price,
    ...(product.compareAtPrice ? { compareAtPrice: product.compareAtPrice } : {}),
    currency: product.currency,
    status: product.status,
    inventoryQuantity: product.inventoryQuantity,
    featured: product.featured,
    ...(product.image ? { image: product.image } : {}),
    images: product.images,
    description: product.description,
    ...(product.descriptionI18n
      ? {
          descriptionI18n: {
            en: [...product.descriptionI18n.en],
            ko: [...product.descriptionI18n.ko],
          },
        }
      : {}),
    sizes: product.sizes,
    version: product.version,
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
  };
}

/** POST와 patch merge 이후 같은 형식으로 상품 입력값을 검증·정규화합니다. */
function parseProductInput(body: unknown): ProductInput | null {
  if (!isRecord(body)) {
    return null;
  }

  const name = readBoundedString(body.name, 160);
  const brandName = readBoundedString(
    "brandName" in body ? body.brandName : body.brand,
    100,
  );
  const category = readCatalogCategory(body.category);
  const price = readKrwAmount(body.price);

  if (!name || !brandName || !category || price === undefined) {
    return null;
  }

  const brandId =
    readReferenceId(body.brandId, 100) ?? createBrandReferenceId(brandName);
  const suppliedSlug = "slug" in body ? readBoundedString(body.slug, 180) : undefined;
  const slug = normalizeSlug(suppliedSlug ?? name);

  if (!slug) {
    return null;
  }

  const sku = readOptionalText(body, "sku", 80);

  if (sku === null) {
    return null;
  }

  const compareAtPrice = readOptionalAmount(body, "compareAtPrice");

  if (
    compareAtPrice === null ||
    (compareAtPrice !== undefined && compareAtPrice <= price)
  ) {
    return null;
  }

  const inventoryQuantity = readInventoryQuantity(
    "inventoryQuantity" in body ? body.inventoryQuantity : body.stock,
  );

  if (inventoryQuantity === undefined) {
    return null;
  }

  const status = readProductStatus(body);

  if (!status) {
    return null;
  }

  const featured = readBooleanAlias(body, ["featured", "isFeatured"], false);

  if (featured === undefined) {
    return null;
  }

  const image = readOptionalImage(body, ["image", "imageUrl"]);

  if (image === null) {
    return null;
  }

  const images = readImageList(body.images, image);
  const description = readTextList(body.description, 20, 300, "newline");
  const sizes = readTextList(body.sizes, 20, 50, "comma");
  const nameI18n = readNameI18n(body.nameI18n);
  const descriptionI18n = readDescriptionI18n(body.descriptionI18n);

  if (
    !images ||
    !description ||
    !sizes ||
    nameI18n === null ||
    descriptionI18n === null
  ) {
    return null;
  }

  if (status === "PUBLISHED" && (!image || sizes.length === 0)) {
    return null;
  }

  return {
    slug,
    name,
    ...(nameI18n ? { nameI18n } : {}),
    ...(sku ? { sku } : {}),
    brandId,
    brandName,
    category,
    price,
    ...(compareAtPrice ? { compareAtPrice } : {}),
    currency: "KRW",
    status,
    publicationStatus: status,
    inventoryQuantity,
    featured,
    ...(image ? { image } : {}),
    images,
    description,
    ...(descriptionI18n ? { descriptionI18n } : {}),
    sizes,
  };
}

/** patch에 포함된 allowlist 필드만 현재 product 위에 덮어써 원본 audit 속성을 신뢰하지 않습니다. */
function mergeProductPatch(
  product: CatalogProductRecord,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {
    name: product.name,
    ...(product.nameI18n ? { nameI18n: { ...product.nameI18n } } : {}),
    slug: product.slug,
    sku: product.sku ?? null,
    brandId: product.brandId,
    brandName: product.brandName,
    category: product.category,
    price: product.price,
    compareAtPrice: product.compareAtPrice ?? null,
    inventoryQuantity: product.inventoryQuantity,
    status: product.status,
    featured: product.featured,
    image: product.image ?? null,
    images: [...product.images],
    description: [...product.description],
    ...(product.descriptionI18n
      ? {
          descriptionI18n: {
            en: [...product.descriptionI18n.en],
            ko: [...product.descriptionI18n.ko],
          },
        }
      : {}),
    sizes: [...product.sizes],
  };

  const directFields = [
    "name",
    "nameI18n",
    "slug",
    "sku",
    "brandId",
    "brandName",
    "category",
    "price",
    "compareAtPrice",
    "inventoryQuantity",
    "status",
    "featured",
    "image",
    "images",
    "description",
    "descriptionI18n",
    "sizes",
  ];

  for (const field of directFields) {
    if (hasOwn(patch, field)) {
      merged[field] = patch[field];
    }
  }

  if (hasOwn(patch, "brand") && !hasOwn(patch, "brandName")) {
    merged.brandName = patch.brand;
  }

  if (hasOwn(patch, "stock") && !hasOwn(patch, "inventoryQuantity")) {
    merged.inventoryQuantity = patch.stock;
  }

  if (hasOwn(patch, "imageUrl") && !hasOwn(patch, "image")) {
    merged.image = patch.imageUrl;
  }

  if (hasOwn(patch, "isVisible") && !hasOwn(patch, "status")) {
    merged.isVisible = patch.isVisible;
  }

  if (hasOwn(patch, "isFeatured") && !hasOwn(patch, "featured")) {
    merged.isFeatured = patch.isFeatured;
  }

  return merged;
}

/** rawPath를 우선으로 사용해 잘못 연결된 Lambda route가 다른 데이터를 조작하지 않게 합니다. */
function resolveCatalogRoute(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): CatalogRoute | null {
  const rawPath = event.rawPath.replace(/\/+$/, "") || "/";
  const match = rawPath.match(/^\/admin\/(?:catalog\/)?products(?:\/([^/]+))?$/);

  if (!match) {
    return null;
  }

  const encodedProductId = event.pathParameters?.productId ?? match[1];

  if (!encodedProductId) {
    return { kind: "collection" };
  }

  let productId: string;

  try {
    productId = decodeURIComponent(encodedProductId);
  } catch {
    return null;
  }

  return readProductId(productId) ? { kind: "item", productId } : null;
}

function readProductId(value: unknown) {
  return typeof value === "string" && PRODUCT_ID_PATTERN.test(value)
    ? value
    : undefined;
}

function readReferenceId(value: unknown, maximumLength: number) {
  const normalized = readBoundedString(value, maximumLength);

  return normalized && /^[A-Za-z0-9][A-Za-z0-9._-]{1,99}$/.test(normalized)
    ? normalized
    : undefined;
}

function createBrandReferenceId(brandName: string) {
  return `brand_${Buffer.from(brandName).toString("base64url").slice(0, 80)}`;
}

function normalizeSlug(value: string) {
  const normalized = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 180);

  return normalized && /^[a-z0-9가-힣][a-z0-9가-힣-]*$/.test(normalized)
    ? normalized
    : undefined;
}

function readCatalogCategory(value: unknown): CatalogCategory | undefined {
  return isCatalogCategory(value) ? value : undefined;
}

function isCatalogCategory(value: unknown): value is CatalogCategory {
  return (
    typeof value === "string" &&
    (CATALOG_CATEGORIES as readonly string[]).includes(value)
  );
}

function readProductStatus(
  body: Record<string, unknown>,
): CatalogProductStatus | undefined {
  if (hasOwn(body, "status")) {
    return isCatalogProductStatus(body.status) ? body.status : undefined;
  }

  if (hasOwn(body, "isVisible")) {
    return typeof body.isVisible === "boolean"
      ? body.isVisible
        ? "PUBLISHED"
        : "DRAFT"
      : undefined;
  }

  return "DRAFT";
}

function isCatalogProductStatus(value: unknown): value is CatalogProductStatus {
  return value === "DRAFT" || value === "PUBLISHED";
}

function readKrwAmount(value: unknown): number | undefined {
  if (typeof value === "number") {
    return isKrwAmount(value) ? value : undefined;
  }

  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());

    return isKrwAmount(parsed) ? parsed : undefined;
  }

  return undefined;
}

function readOptionalAmount(
  body: Record<string, unknown>,
  field: string,
): number | undefined | null {
  if (!hasOwn(body, field) || body[field] === null || body[field] === "") {
    return undefined;
  }

  return readKrwAmount(body[field]) ?? null;
}

function isKrwAmount(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_PRICE
  );
}

function readInventoryQuantity(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return 0;
  }

  if (typeof value === "number") {
    return isInventoryQuantity(value) ? value : undefined;
  }

  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());

    return isInventoryQuantity(parsed) ? parsed : undefined;
  }

  return undefined;
}

function isInventoryQuantity(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_INVENTORY
  );
}

function readBooleanAlias(
  body: Record<string, unknown>,
  fields: readonly string[],
  fallback: boolean,
): boolean | undefined {
  for (const field of fields) {
    if (hasOwn(body, field)) {
      return typeof body[field] === "boolean" ? body[field] : undefined;
    }
  }

  return fallback;
}

function readOptionalText(
  body: Record<string, unknown>,
  field: string,
  maximumLength: number,
): string | undefined | null {
  if (!hasOwn(body, field) || body[field] === null || body[field] === "") {
    return undefined;
  }

  return readBoundedString(body[field], maximumLength) ?? null;
}

function readOptionalImage(
  body: Record<string, unknown>,
  fields: readonly string[],
): string | undefined | null {
  for (const field of fields) {
    if (!hasOwn(body, field)) {
      continue;
    }

    if (body[field] === null || body[field] === "") {
      return undefined;
    }

    const image = readBoundedString(body[field], 2_048);

    return image && isSafeImageUrl(image) ? image : null;
  }

  return undefined;
}

function readImageList(value: unknown, image?: string): readonly string[] | null {
  if (value === undefined || value === null || value === "") {
    return image ? [image] : [];
  }

  if (!Array.isArray(value) || value.length > 12) {
    return null;
  }

  const urls: string[] = [];

  for (const item of value) {
    const url = readBoundedString(item, 2_048);

    if (!url || !isSafeImageUrl(url)) {
      return null;
    }

    if (!urls.includes(url)) {
      urls.push(url);
    }
  }

  if (image && !urls.includes(image)) {
    urls.unshift(image);
  }

  return urls;
}

function isSafeImageUrl(value: string) {
  if (value.startsWith("/")) {
    return (
      !value.startsWith("//") && !value.includes("\\") && !value.includes("\u0000")
    );
  }

  try {
    const url = new URL(value);

    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function readTextList(
  value: unknown,
  maximumItems: number,
  maximumItemLength: number,
  separator: "newline" | "comma",
): readonly string[] | null {
  if (value === undefined || value === null || value === "") {
    return [];
  }

  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(separator === "newline" ? /\r?\n/ : ",")
      : null;

  if (!values) {
    return null;
  }

  const normalized: string[] = [];

  for (const item of values) {
    if (typeof item !== "string") {
      return null;
    }

    const trimmed = item.trim();

    if (!trimmed) {
      continue;
    }

    if (trimmed.length > maximumItemLength || normalized.length >= maximumItems) {
      return null;
    }

    normalized.push(trimmed);
  }

  return normalized;
}

/** 없으면 undefined, 형식이 틀리면 null. */
function readNameI18n(value: unknown): CatalogNameI18n | undefined | null {
  if (value === undefined) {
    return undefined;
  }

  return isCatalogNameI18n(value) ? value : null;
}

/** 없으면 undefined, 형식이 틀리면 null. */
function readDescriptionI18n(
  value: unknown,
): CatalogDescriptionI18n | undefined | null {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    return null;
  }

  const en = readTextList(value.en, 20, 300, "newline");
  const ko = readTextList(value.ko, 20, 300, "newline");

  if (!en || !ko) {
    return null;
  }

  return { en, ko };
}

function isCatalogNameI18n(value: unknown): value is CatalogNameI18n {
  return (
    isRecord(value) &&
    typeof value.en === "string" &&
    value.en.trim().length > 0 &&
    value.en.length <= 160 &&
    typeof value.ko === "string" &&
    value.ko.trim().length > 0 &&
    value.ko.length <= 160
  );
}

function isCatalogDescriptionI18n(value: unknown): value is CatalogDescriptionI18n {
  return (
    isRecord(value) &&
    isStringArray(value.en) &&
    value.en.length <= 20 &&
    value.en.every((line) => line.length > 0 && line.length <= 300) &&
    isStringArray(value.ko) &&
    value.ko.length <= 20 &&
    value.ko.every((line) => line.length > 0 && line.length <= 300)
  );
}

function readVersion(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  }

  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());

    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
  }

  return undefined;
}

function readStatusFilter(value: unknown): CatalogProductStatus | undefined {
  return isCatalogProductStatus(value) ? value : undefined;
}

function readListLimit(value: unknown) {
  if (value === undefined) {
    return 50;
  }

  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;

  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 100
    ? parsed
    : undefined;
}

function encodeCursor(value: unknown) {
  if (!isRecord(value) || !isCatalogStorageKey(value.productId)) {
    return undefined;
  }

  return Buffer.from(JSON.stringify({ productId: value.productId })).toString(
    "base64url",
  );
}

function decodeCursor(value: unknown) {
  if (typeof value !== "string" || value.length > 512) {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    );

    return isRecord(parsed) && isCatalogStorageKey(parsed.productId)
      ? { productId: parsed.productId }
      : undefined;
  } catch {
    return undefined;
  }
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function hasOwn(value: Record<string, unknown>, field: string) {
  return Object.prototype.hasOwnProperty.call(value, field);
}

function isConditionalWriteError(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error.name === "ConditionalCheckFailedException" ||
      (error.name === "TransactionCanceledException" &&
        "CancellationReasons" in error &&
        Array.isArray(error.CancellationReasons) &&
        error.CancellationReasons.some(
          (reason: unknown) =>
            isRecord(reason) && reason.Code === "ConditionalCheckFailed",
        )))
  );
}

function isCatalogStorageKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Boolean(readProductId(value) || INTERNAL_KEY_PATTERN.test(value))
  );
}
