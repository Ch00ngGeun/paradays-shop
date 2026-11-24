import { createHash, randomUUID } from "node:crypto";
import {
  GetCommand,
  ScanCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyResultV2 } from "aws-lambda";
import {
  findCatalogDuplicateIds,
  type CatalogIntakeRequest,
} from "./catalog-intake.js";
import { documentClient } from "./dynamodb-client.js";
import { jsonResponse } from "./http-response.js";
import { isRecord } from "./request-helpers.js";
import {
  type CatalogProductRecord,
  type AdminCatalogProduct,
  isCatalogProductRecord,
  toAdminCatalogProduct,
} from "./admin-catalog-handler.js";
import { readProduct } from "./admin-catalog-products.js";
import {
  readProductId,
  isInventoryQuantity,
  readVersion,
  isConditionalWriteError,
} from "./admin-catalog-values.js";
import { parseProductInput } from "./admin-catalog-input.js";

const CATALOG_REVISION_KEY = "~catalog_revision";

const CATALOG_RECEIPT_PREFIX = "~catalog_receipt_";

const INTERNAL_KEY_PATTERN = /^~catalog_(?:revision|(?:receipt|claim)_[a-f0-9]{64})$/;

const MAX_IDENTITY_SCAN_PAGES = 1_000;

const MAX_IDENTITY_SCAN_RAW_ITEMS = 1_000_000;

const MAX_IDENTITY_SCAN_PRODUCTS = 5_000;

const IDENTITY_SCAN_PAGE_LIMIT = 1_000;

const IDENTITY_SCAN_DEADLINE_MS = 5_000;

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
export async function commitCatalogIntake(
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
    // Callers `return await` so a failed recheck still reaches the 503 handler below.
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
        return await failUnlessReplayed(
          jsonResponse(404, { code: "CATALOG_PRODUCT_NOT_FOUND" }),
        );
      if (existing.version !== input.existing.version)
        return await failUnlessReplayed(
          jsonResponse(409, {
            code: "CATALOG_PRODUCT_VERSION_CONFLICT",
            product: toAdminCatalogProduct(existing),
          }),
        );
      beforeStock = existing.inventoryQuantity;
      const afterStock = beforeStock + input.quantity;
      if (!isInventoryQuantity(afterStock))
        return await failUnlessReplayed(
          jsonResponse(400, { code: "OCR_INTAKE_INVALID" }),
        );
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
        return await failUnlessReplayed(
          jsonResponse(400, { code: "OCR_INTAKE_INVALID" }),
        );
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
        return await failUnlessReplayed(
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
export async function readCatalogRevision(catalogTableName: string): Promise<number> {
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

export function revisionWrite(
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
export async function readCatalogDuplicates(
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

export function isCatalogStorageKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Boolean(readProductId(value) || INTERNAL_KEY_PATTERN.test(value))
  );
}
