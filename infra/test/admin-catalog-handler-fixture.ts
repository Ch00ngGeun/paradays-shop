/** 역할: 관리자 카탈로그 handler 테스트용 상품·event 생성기와 원자적·조건부 메모리 SDK 전송 fixture를 제공함. 자격증명·네트워크는 쓰지 않음. */
import assert from "node:assert/strict";
import { type TestContext } from "node:test";
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { GetCommand, ScanCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import { type CatalogProductRecord } from "../lambda/admin-catalog-handler.js";
import { documentClient } from "../lambda/dynamodb-client.js";

export const REVISION = "~catalog_revision";
export function product(
  patch: Partial<CatalogProductRecord> = {},
): CatalogProductRecord {
  return {
    productId: "prd_deck",
    slug: "deck",
    name: "Deck",
    brandId: "brand_example",
    brandName: "Example",
    sku: "DECK-825",
    category: "Deck",
    price: 80_000,
    currency: "KRW",
    status: "DRAFT",
    publicationStatus: "DRAFT",
    inventoryQuantity: 10,
    featured: false,
    images: [],
    description: [],
    sizes: ["8.25"],
    version: 3,
    createdAt: "2026-10-14T00:00:00.000Z",
    updatedAt: "2026-10-14T00:00:00.000Z",
    createdBy: "old-admin",
    updatedBy: "old-admin",
    ...patch,
  };
}
export function existing(patch: Record<string, unknown> = {}) {
  return {
    action: "ocr-intake",
    operationId: "ocr_stable_operation",
    kind: "existing",
    quantity: 2,
    source: { jobId: "ocr_saved", rowIds: ["row_A"] },
    existing: { productId: "prd_deck", version: 3 },
    ...patch,
  };
}
export function fresh(patch: Record<string, unknown> = {}) {
  return {
    action: "ocr-intake",
    operationId: "ocr_new_operation",
    kind: "new",
    quantity: 4,
    source: { jobId: "ocr_saved", rowIds: ["row_new"] },
    product: {
      name: "New wheel",
      brandName: "Example",
      option: "56mm",
      price: 0,
      category: "Wheels",
    },
    ...patch,
  };
}
export function event(
  method: string,
  body?: unknown,
  id?: string,
  sub = "admin-A",
  admin = true,
) {
  return {
    rawPath: `/admin/catalog/products${id ? `/${id}` : ""}`,
    headers: {},
    isBase64Encoded: false,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    requestContext: {
      http: { method },
      authorizer: {
        jwt: {
          claims: {
            ...(sub ? { sub } : {}),
            ...(admin ? { "cognito:groups": "admin" } : {}),
          },
        },
      },
    },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
}
export function unpack(response: APIGatewayProxyResultV2) {
  assert.ok(
    typeof response === "object" &&
      response !== null &&
      "body" in response &&
      typeof response.body === "string",
  );
  return { status: response.statusCode, body: JSON.parse(response.body) };
}
export function conditionalFailure() {
  return Object.assign(new Error("private storage details"), {
    name: "TransactionCanceledException",
    CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
  });
}
export function fixture(
  t: TestContext,
  initial: readonly CatalogProductRecord[] = [product()],
) {
  const oldTable = process.env.CATALOG_TABLE_NAME;
  const oldPool = process.env.USER_POOL_ID;
  process.env.CATALOG_TABLE_NAME = "test-catalog";
  delete process.env.USER_POOL_ID;
  const records = new Map<string, Record<string, unknown>>(
    initial.map((item) => [item.productId, structuredClone(item)]),
  );
  const transactions: TransactWriteCommand["input"][] = [];
  const reads: GetCommand["input"][] = [];
  const scans: ScanCommand["input"][] = [];
  let failWrite = false;
  let failRead = false;
  let failScan = false;
  let endlessScan = false;
  let beforeTransaction: (() => void) | undefined;
  let scanPages: readonly (readonly Record<string, unknown>[])[] | undefined;
  let loseCommitResponse = false;
  let reportedScanCount: number | undefined;
  let stalledScan = false;
  let beforeScan: (() => void) | undefined;
  let beforeRead: ((readCount: number) => void) | undefined;
  let scanSignal: AbortSignal | undefined;
  t.mock.method(
    documentClient,
    "send",
    async (command: unknown, options?: { abortSignal?: AbortSignal }) => {
      if (command instanceof GetCommand) {
        if (failRead) throw new Error("private read details");
        reads.push(command.input);
        beforeRead?.(reads.length);
        assert.equal(command.input.ConsistentRead, true);
        return {
          Item: structuredClone(records.get(command.input.Key!.productId as string)),
        };
      }
      if (command instanceof ScanCommand) {
        if (failScan) throw new Error("private scan details");
        scans.push(command.input);
        scanSignal = options?.abortSignal;
        beforeScan?.();
        if (stalledScan) return new Promise(() => {});
        if (scanPages) {
          const page = scanPages[scans.length - 1] ?? [];
          return {
            Items: structuredClone(page),
            ScannedCount: page.length,
            ...(scans.length < scanPages.length
              ? { LastEvaluatedKey: { productId: "prd_page_cursor" } }
              : {}),
          };
        }
        const items = [...records.values()].map((item) => structuredClone(item));
        return {
          Items: items,
          ScannedCount: reportedScanCount ?? items.length,
          ...(endlessScan ? { LastEvaluatedKey: { productId: "prd_deck" } } : {}),
        };
      }
      if (command instanceof TransactWriteCommand) {
        beforeTransaction?.();
        beforeTransaction = undefined;
        if (failWrite) throw new Error("private write details");
        const operations = command.input.TransactItems!;
        assert.ok(operations.length >= 2 && operations.length <= 99);
        assert.equal(operations[0].Put!.Item!.productId, REVISION);
        // transaction처럼 item을 바꾸기 전에 모든 조건을 먼저 검사함.
        for (const operation of operations) {
          const write = operation.Put ?? operation.Delete!;
          assert.equal(write.TableName, "test-catalog");
          const key = operation.Put
            ? operation.Put.Item!.productId
            : operation.Delete!.Key!.productId;
          const current = records.get(key as string);
          if (write.ConditionExpression === "attribute_not_exists(productId)") {
            if (current) throw conditionalFailure();
          } else {
            assert.ok(
              write.ConditionExpression === "#version = :expectedVersion" ||
                (operation.Delete &&
                  write.ConditionExpression ===
                    "#version = :expectedVersion AND (attribute_not_exists(inventoryReserved) OR inventoryReserved = :zero) AND (attribute_not_exists(inventoryCommitted) OR inventoryCommitted = :zero)"),
            );
            if (
              operation.Delete &&
              ((current?.inventoryReserved ?? 0) !== 0 ||
                (current?.inventoryCommitted ?? 0) !== 0)
            )
              throw conditionalFailure();
            if (
              current?.version !== write.ExpressionAttributeValues?.[":expectedVersion"]
            )
              throw conditionalFailure();
          }
        }
        transactions.push(structuredClone(command.input));
        for (const operation of operations) {
          if (operation.Put)
            records.set(
              operation.Put.Item!.productId as string,
              structuredClone(operation.Put.Item!),
            );
          else records.delete(operation.Delete!.Key!.productId as string);
        }
        if (loseCommitResponse) {
          loseCommitResponse = false;
          throw new Error("Response lost after commit");
        }
        return {};
      }
      throw new Error("Unexpected SDK command");
    },
  );
  const noNetwork = async () => {
    throw new Error("Network forbidden");
  };
  const cognito = t.mock.method(
    CognitoIdentityProviderClient.prototype,
    "send",
    noNetwork,
  );
  const fetch = t.mock.method(globalThis, "fetch", noNetwork);
  t.after(() => {
    assert.equal(cognito.mock.callCount(), 0);
    assert.equal(fetch.mock.callCount(), 0);
    if (oldTable === undefined) delete process.env.CATALOG_TABLE_NAME;
    else process.env.CATALOG_TABLE_NAME = oldTable;
    if (oldPool === undefined) delete process.env.USER_POOL_ID;
    else process.env.USER_POOL_ID = oldPool;
  });
  return {
    records,
    transactions,
    reads,
    scans,
    setFailWrite: () => {
      failWrite = true;
    },
    setFailRead: () => {
      failRead = true;
    },
    setFailScan: () => {
      failScan = true;
    },
    setEndlessScan: () => {
      endlessScan = true;
    },
    beforeTransaction: (callback: () => void) => {
      beforeTransaction = callback;
    },
    setScanPages: (pages: readonly (readonly Record<string, unknown>[])[]) => {
      scanPages = pages;
    },
    loseCommitResponse: () => {
      loseCommitResponse = true;
    },
    reportScanCount: (count: number) => {
      reportedScanCount = count;
    },
    stallScan: () => {
      stalledScan = true;
    },
    beforeScan: (callback: () => void) => {
      beforeScan = callback;
    },
    beforeRead: (callback: (readCount: number) => void) => {
      beforeRead = callback;
    },
    scanSignal: () => scanSignal,
  };
}
export const shortSleeve = {
  kind: "shortSleeve",
  values: {
    length: 72,
    shoulder: 50.5,
    chest: 56,
    sleeveLength: 22,
    hem: 55,
    sleeveWidth: 20.5,
    armhole: 24,
  },
};
export const longPants = {
  kind: "longPants",
  values: { length: 100, waist: 40, hip: 52, thigh: 32, rise: 30, hem: 21.5 },
};
export function top(patch: Partial<CatalogProductRecord> = {}) {
  return product({
    productId: "prd_top",
    slug: "top",
    name: "Top",
    sku: "TOP-M",
    category: "Top",
    sizes: ["M"],
    status: "PUBLISHED",
    publicationStatus: "PUBLISHED",
    image: "/top.webp",
    ...patch,
  });
}
