import { randomUUID } from "node:crypto";
import { GetCommand, ScanCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import { parseCatalogIntakeRequest } from "./catalog-intake.js";
import { documentClient } from "./dynamodb-client.js";
import { jsonResponse } from "./http-response.js";
import { isRecord, parseJsonBody } from "./request-helpers.js";
import {
  allowedSizeChartKind,
  isCatalogSizeChart,
  sizeChartFor,
} from "./size-chart-rules.js";
import {
  readProductId,
  readCatalogCategory,
  readVersion,
  readStatusFilter,
  readListLimit,
  encodeCursor,
  decodeCursor,
  hasOwn,
  isConditionalWriteError,
} from "./admin-catalog-values.js";
import {
  type CatalogProductRecord,
  isCatalogProductRecord,
  toAdminCatalogProduct,
} from "./admin-catalog-handler.js";
import {
  commitCatalogIntake,
  readCatalogRevision,
  revisionWrite,
  readCatalogDuplicates,
} from "./admin-catalog-intake.js";
import { parseProductInput, mergeProductPatch } from "./admin-catalog-input.js";
import {
  patchSizeOption,
  currentSizeChartKind,
  sizeChartsBySizeFor,
} from "./admin-catalog-size-options.js";

/** GET collection: 매번 제한된 수만 scan하고, 생성한 cursor만 다음 페이지 시작 키로 복원합니다. */
export async function listProducts(
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
export async function createProduct(
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
  // Option size charts are saved only through the dedicated sizeDeckSpec PATCH, and
  // the clothing/wheel size chart only through a PATCH on a saved product.
  const input = parseProductInput(
    isRecord(body)
      ? {
          ...body,
          deckSpecsBySize: undefined,
          sizeChart: undefined,
          sizeChartKind: undefined,
          sizeChartsBySize: undefined,
        }
      : body,
  );

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

/** GET item: 저장 원본이 아닌 allowlist 기반 관리자 shape만 반환합니다. */
export async function getProduct(catalogTableName: string, productId: string) {
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
export async function updateProduct(
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

  const merged = mergeProductPatch(existingProduct, body);
  // A size chart sent for a kind the (new) category cannot use is refused, not silently dropped.
  // The category is checked first: the patch value may be any JSON, not only a string.
  const patchedCategory = readCatalogCategory(merged.category);
  if (
    hasOwn(body, "sizeChart") &&
    body.sizeChart !== null &&
    (!patchedCategory || !sizeChartFor(patchedCategory, body.sizeChart))
  )
    return jsonResponse(400, { code: "CATALOG_PRODUCT_INVALID" });
  const currentKind = currentSizeChartKind(existingProduct);
  // Changing the drawing with a default value would orphan the option values; that is the kind PATCH's job.
  if (
    isCatalogSizeChart(body.sizeChart) &&
    body.sizeChart.kind !== currentKind &&
    sizeChartsBySizeFor(existingProduct, currentKind)
  )
    return jsonResponse(400, { code: "CATALOG_PRODUCT_INVALID" });
  // PATCH { version, sizeChartKind }: a different drawing clears the default and every option value.
  if (hasOwn(body, "sizeChartKind")) {
    const kind = Object.keys(body).every((field) =>
      ["version", "sizeChartKind"].includes(field),
    )
      ? allowedSizeChartKind(existingProduct.category, body.sizeChartKind)
      : undefined;
    if (!kind) return jsonResponse(400, { code: "CATALOG_PRODUCT_INVALID" });
    if (kind !== currentKind) {
      delete merged.sizeChart;
      delete merged.sizeChartsBySize;
    }
    merged.sizeChartKind = kind;
  }
  if (
    hasOwn(body, "sizeDeckSpec") ||
    hasOwn(body, "sizeChartValues") ||
    hasOwn(body, "size") ||
    hasOwn(body, "sizeName")
  ) {
    const option = patchSizeOption(existingProduct, body);
    if (!option) return jsonResponse(400, { code: "CATALOG_PRODUCT_INVALID" });
    merged.sizes = option.sizes;
    merged.deckSpecsBySize = option.deckSpecsBySize;
    merged.sizeChartsBySize = option.sizeChartsBySize;
    if (option.sizeChartKind) merged.sizeChartKind = option.sizeChartKind;
  }
  const input = parseProductInput(merged);

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

  // Optional fields named in the patch come only from the parsed input, so null clears them.
  const existingBase = { ...existingProduct };
  if (hasOwn(body, "compareAtPrice")) delete existingBase.compareAtPrice;
  if (hasOwn(body, "deckSpec")) delete existingBase.deckSpec;
  // The parsed input already drops entries for options no longer in sizes,
  // and a size chart whose kind the category no longer offers.
  delete existingBase.deckSpecsBySize;
  delete existingBase.sizeChart;
  delete existingBase.sizeChartKind;
  delete existingBase.sizeChartsBySize;
  const updatedProduct: CatalogProductRecord = {
    ...existingBase,
    ...input,
    version: existingProduct.version + 1,
    updatedAt: new Date().toISOString(),
    updatedBy: userSub,
  };

  try {
    const revision = await readCatalogRevision(catalogTableName);
    // A same-name option save does not change identity, so it skips the catalog scan.
    const identityChanged =
      ["name", "brandName", "brand", "sku", "sizes"].some((field) =>
        hasOwn(body, field),
      ) ||
      (hasOwn(body, "sizeName") && body.sizeName !== body.size);
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
export async function deleteProduct(
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
export async function readProduct(catalogTableName: string, productId: string) {
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
