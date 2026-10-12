/**
 * 역할: 스토어프론트에 발행 상태 상품만 공개합니다.
 * 기능: 공개 API에서 draft·재고·SKU·감사 정보가 새지 않도록 catalog record를 allowlist shape으로 변환합니다.
 */

import { QueryCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";

import {
  isCatalogProductRecord,
  toPublicCatalogProduct,
  type PublicCatalogProduct,
} from "./admin-catalog-handler.js";
import { documentClient, getRequiredEnvironment } from "./dynamodb-client.js";
import { jsonResponse } from "./http-response.js";
import { readBoundedString } from "./request-helpers.js";

const MAX_LIST_LIMIT = 60;

/** GET /catalog/products와 GET /catalog/products?slug=...을 처리합니다. */
export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  if (event.requestContext.http.method !== "GET") {
    return jsonResponse(405, { code: "CATALOG_METHOD_NOT_ALLOWED" });
  }

  let catalogTableName: string;

  try {
    catalogTableName = getRequiredEnvironment("CATALOG_TABLE_NAME");
  } catch {
    return jsonResponse(503, { code: "CATALOG_CONFIGURATION_UNAVAILABLE" });
  }

  const slug = readBoundedString(event.queryStringParameters?.slug, 180);

  if (event.queryStringParameters?.slug && !slug) {
    return jsonResponse(400, { code: "CATALOG_SLUG_INVALID" });
  }

  return slug
    ? getPublishedProductBySlug(catalogTableName, slug)
    : listPublishedProducts(catalogTableName, event);
}

/** GSI에서 publicationStatus=PUBLISHED만 최신 갱신 순으로 읽습니다. */
async function listPublishedProducts(
  catalogTableName: string,
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> {
  const limit = readListLimit(event.queryStringParameters?.limit);

  if (!limit) {
    return jsonResponse(400, { code: "CATALOG_LIMIT_INVALID" });
  }

  try {
    const response = await documentClient.send(
      new QueryCommand({
        TableName: catalogTableName,
        IndexName: "publicationStatus-updatedAt-index",
        KeyConditionExpression: "#publicationStatus = :published",
        ExpressionAttributeNames: { "#publicationStatus": "publicationStatus" },
        ExpressionAttributeValues: { ":published": "PUBLISHED" },
        Limit: limit,
        ScanIndexForward: false,
      }),
    );
    const products = (response.Items ?? [])
      .filter(isCatalogProductRecord)
      .map(toPublicCatalogProduct)
      .filter((product): product is PublicCatalogProduct => product !== null);

    return jsonResponse(200, { products });
  } catch {
    return jsonResponse(503, { code: "CATALOG_STORAGE_UNAVAILABLE" });
  }
}

/** slug GSI로 읽은 뒤에도 PUBLISHED인지 마지막으로 확인해 삭제·draft 전환을 숨깁니다. */
async function getPublishedProductBySlug(
  catalogTableName: string,
  slug: string,
): Promise<APIGatewayProxyResultV2> {
  try {
    const response = await documentClient.send(
      new QueryCommand({
        TableName: catalogTableName,
        IndexName: "slug-updatedAt-index",
        KeyConditionExpression: "#slug = :slug",
        ExpressionAttributeNames: { "#slug": "slug" },
        ExpressionAttributeValues: { ":slug": slug },
        Limit: 5,
        ScanIndexForward: false,
      }),
    );
    const product = (response.Items ?? [])
      .filter(isCatalogProductRecord)
      .map(toPublicCatalogProduct)
      .find((item): item is PublicCatalogProduct => item !== null);

    return product
      ? jsonResponse(200, { product })
      : jsonResponse(404, { code: "CATALOG_PRODUCT_NOT_FOUND" });
  } catch {
    return jsonResponse(503, { code: "CATALOG_STORAGE_UNAVAILABLE" });
  }
}

function readListLimit(value: string | undefined) {
  if (!value) {
    return 60;
  }

  const parsed = Number(value);

  return Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_LIST_LIMIT
    ? parsed
    : undefined;
}
