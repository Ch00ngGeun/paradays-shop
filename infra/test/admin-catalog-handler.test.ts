/** Real handler with an atomic, conditional in-memory SDK transport. No credentials or network. */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { GetCommand, ScanCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import {
  handler,
  isCatalogProductRecord,
  toPublicCatalogProduct,
  type CatalogProductRecord,
} from "../lambda/admin-catalog-handler.js";
import { documentClient } from "../lambda/dynamodb-client.js";
import {
  SIZE_CHART_KIND_RULES,
  SIZE_CHART_KINDS,
  isSizeChartValues,
  sizeChartKindsFor,
} from "../lambda/size-chart-rules.js";

const REVISION = "~catalog_revision";
test("public stock projects available units rather than physical on-hand units", () => {
  assert.equal(
    toPublicCatalogProduct(
      product({
        status: "PUBLISHED",
        publicationStatus: "PUBLISHED",
        image: "/deck.webp",
        inventoryQuantity: 10,
        inventoryReserved: 7,
      }),
    )?.inventoryQuantity,
    3,
  );
});
function product(patch: Partial<CatalogProductRecord> = {}): CatalogProductRecord {
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
function existing(patch: Record<string, unknown> = {}) {
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
function fresh(patch: Record<string, unknown> = {}) {
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
function event(
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
function unpack(response: APIGatewayProxyResultV2) {
  assert.ok(
    typeof response === "object" &&
      response !== null &&
      "body" in response &&
      typeof response.body === "string",
  );
  return { status: response.statusCode, body: JSON.parse(response.body) };
}
function conditionalFailure() {
  return Object.assign(new Error("private storage details"), {
    name: "TransactionCanceledException",
    CancellationReasons: [{ Code: "ConditionalCheckFailed" }],
  });
}
function fixture(
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
        // Validate every condition before changing any item, exactly as a transaction must.
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

test("existing intake adds n server-side and atomically stores a private allowlisted receipt", async (t) => {
  const db = fixture(t);
  const response = unpack(await handler(event("POST", existing())));
  assert.equal(response.status, 200);
  assert.equal(response.body.product.inventoryQuantity, 12);
  assert.equal(response.body.product.version, 4);
  assert.deepEqual(response.body.receipt, {
    operationId: "ocr_stable_operation",
    kind: "existing",
    quantity: 2,
    beforeStock: 10,
    afterStock: 12,
    replayed: false,
  });
  assert.equal(db.transactions.length, 1);
  assert.equal(db.transactions[0].TransactItems!.length, 4);
  const ledger = [...db.records.values()].find(
    (item) => item.recordType === "CATALOG_INTAKE_RECEIPT",
  )!;
  assert.equal(ledger.inventoryQuantity, undefined);
  assert.equal(ledger.publicationStatus, undefined);
  assert.equal(ledger.slug, undefined);
  assert.equal(ledger.createdBy, undefined);
  assert.equal(JSON.stringify(ledger).includes("old-admin"), false);
  assert.equal(JSON.stringify(ledger).includes("admin-A"), false);
});

test("server-owned reservations survive PATCH and OCR intake; below-hold, option changes and deletion fail", async (t) => {
  const db = fixture(t, [product({ inventoryReserved: 4 })]);
  assert.equal(
    unpack(
      await handler(event("PATCH", { version: 3, inventoryReserved: 0 }, "prd_deck")),
    ).status,
    400,
  );
  assert.equal(
    unpack(
      await handler(event("PATCH", { version: 3, inventoryQuantity: 3 }, "prd_deck")),
    ).status,
    409,
  );
  assert.equal(
    unpack(await handler(event("PATCH", { version: 3, sizes: ["9"] }, "prd_deck")))
      .status,
    409,
  );
  assert.equal(
    unpack(await handler(event("DELETE", { version: 3 }, "prd_deck"))).status,
    409,
  );
  assert.equal(
    unpack(
      await handler(event("PATCH", { version: 3, inventoryQuantity: 11 }, "prd_deck")),
    ).status,
    200,
  );
  assert.equal(db.records.get("prd_deck")!.inventoryReserved, 4);
  assert.equal(
    unpack(
      await handler(
        event("POST", existing({ existing: { productId: "prd_deck", version: 4 } })),
      ),
    ).status,
    200,
  );
  assert.equal(db.records.get("prd_deck")!.inventoryReserved, 4);
  assert.equal(db.records.get("prd_deck")!.inventoryQuantity, 13);
});

test("reserved products accept full-form edits that resend unchanged identity fields", async (t) => {
  const db = fixture(t, [product({ inventoryReserved: 4 })]);
  const unchangedIdentity = {
    name: "Deck",
    brandName: "Example",
    sku: "DECK-825",
    price: 80_000,
    sizes: ["8.25"],
  };
  const edited = unpack(
    await handler(
      event(
        "PATCH",
        { version: 3, ...unchangedIdentity, description: ["Updated copy"] },
        "prd_deck",
      ),
    ),
  );
  assert.equal(edited.status, 200);
  assert.deepEqual(db.records.get("prd_deck")!.description, ["Updated copy"]);
  assert.equal(db.records.get("prd_deck")!.inventoryReserved, 4);
  const repriced = unpack(
    await handler(
      event("PATCH", { version: 4, ...unchangedIdentity, price: 90_000 }, "prd_deck"),
    ),
  );
  assert.equal(repriced.status, 409);
  assert.equal(repriced.body.code, "CATALOG_PRODUCT_RESERVED");
  assert.equal(db.records.get("prd_deck")!.price, 80_000);
});

test("invalid comparison prices are rejected without writing", async (t) => {
  const db = fixture(t, [product({ price: 80_000, compareAtPrice: 100_000 })]);
  for (const compareAtPrice of [-1, 80_000, "not-a-price"]) {
    const response = unpack(
      await handler(event("PATCH", { version: 3, compareAtPrice }, "prd_deck")),
    );
    assert.equal(response.status, 400, String(compareAtPrice));
  }
  assert.equal(db.transactions.length, 0);
  assert.equal(db.records.get("prd_deck")!.compareAtPrice, 100_000);
});

test("a write race cannot clear the current comparison price", async (t) => {
  const db = fixture(t, [product({ price: 80_000, compareAtPrice: 100_000 })]);
  db.beforeTransaction(() => {
    db.records.set("prd_deck", { ...db.records.get("prd_deck")!, version: 4 });
  });
  const raced = unpack(
    await handler(event("PATCH", { version: 3, compareAtPrice: null }, "prd_deck")),
  );
  assert.equal(raced.status, 409);
  assert.equal(db.transactions.length, 0);
  assert.equal(db.records.get("prd_deck")!.compareAtPrice, 100_000);
});

test("outstanding sold units block hard deletion; archival remains possible", async (t) => {
  const db = fixture(t, [product({ inventoryCommitted: 2 })]);
  assert.equal(
    unpack(await handler(event("DELETE", { version: 3 }, "prd_deck"))).status,
    409,
  );
  assert.equal(
    unpack(await handler(event("PATCH", { version: 3, status: "DRAFT" }, "prd_deck")))
      .status,
    200,
  );
  assert.equal(db.records.get("prd_deck")!.inventoryCommitted, 2);
});
test("same request replays saved snapshot after later catalog changes without another add", async (t) => {
  const db = fixture(t);
  await handler(event("POST", existing()));
  db.records.set("prd_deck", {
    ...db.records.get("prd_deck"),
    inventoryQuantity: 99,
    version: 8,
  });
  const response = unpack(await handler(event("POST", existing())));
  assert.equal(response.status, 200);
  assert.equal(response.body.receipt.replayed, true);
  assert.equal(response.body.product.inventoryQuantity, 12);
  assert.equal(db.records.get("prd_deck")!.inventoryQuantity, 99);
  assert.equal(db.transactions.length, 1);
});
test("same operation with changed payload rejects rather than re-adds", async (t) => {
  const db = fixture(t);
  await handler(event("POST", existing()));
  const response = unpack(await handler(event("POST", existing({ quantity: 3 }))));
  assert.equal(response.status, 409);
  assert.equal(response.body.code, "OCR_INTAKE_OPERATION_CONFLICT");
  assert.equal(db.transactions.length, 1);
});
test("concurrent identical requests commit once and the loser replays the winner", async (t) => {
  const db = fixture(t);
  const responses = await Promise.all([
    handler(event("POST", existing())),
    handler(event("POST", existing())),
  ]);
  assert.deepEqual(
    responses.map((item) => unpack(item).status),
    [200, 200],
  );
  assert.deepEqual(responses.map((item) => unpack(item).body.receipt.replayed).sort(), [
    false,
    true,
  ]);
  assert.equal(db.records.get("prd_deck")!.inventoryQuantity, 12);
  assert.equal(db.transactions.length, 1);
});
for (const [kind, body] of [
  ["existing", existing],
  ["new", fresh],
] as const) {
  test(`a ${kind} intake whose same operation commits after the receipt check replays instead of 409`, async (t) => {
    const db = fixture(t);
    const snapshot = () =>
      new Map([...db.records].map(([key, value]) => [key, structuredClone(value)]));
    const restore = (state: Map<string, Record<string, unknown>>) => {
      db.records.clear();
      for (const [key, value] of state) db.records.set(key, structuredClone(value));
    };
    const initial = snapshot();
    const winner = unpack(await handler(event("POST", body())));
    assert.equal(winner.status, kind === "new" ? 201 : 200);
    const committed = snapshot();
    const winnerWrites = db.transactions.length;
    restore(initial);
    // The winner commits right after the loser's first receipt read.
    const firstRead = db.reads.length + 1;
    db.beforeRead((count) => {
      if (count === firstRead + 1) restore(committed);
    });
    const loser = unpack(await handler(event("POST", body())));
    assert.equal(loser.status, 200);
    assert.equal(loser.body.receipt.replayed, true);
    assert.equal(db.transactions.length, winnerWrites);
  });
}

test("an intake whose committed product was deleted before the loser read replays instead of 404", async (t) => {
  const db = fixture(t);
  assert.equal(unpack(await handler(event("POST", existing()))).status, 200);
  const writes = db.transactions.length;
  // The loser misses the receipt on its first read; then it lands and the product is gone.
  const receipts = [...db.records].filter(
    ([, value]) => value.recordType === "CATALOG_INTAKE_RECEIPT",
  );
  assert.ok(receipts.length > 0);
  for (const [key] of receipts) db.records.delete(key);
  db.records.delete("prd_deck");
  const firstRead = db.reads.length + 1;
  db.beforeRead((count) => {
    if (count === firstRead + 1)
      for (const [key, value] of receipts) db.records.set(key, structuredClone(value));
  });
  const loser = unpack(await handler(event("POST", existing())));
  assert.equal(loser.status, 200);
  assert.equal(loser.body.receipt.replayed, true);
  assert.equal(db.transactions.length, writes);
});

test("a failed receipt recheck before an early intake failure is a 503, not an unhandled error", async (t) => {
  const db = fixture(t, [product({ version: 9 })]);
  const firstRead = db.reads.length + 1;
  db.beforeRead((count) => {
    // receipt, revision, product, then the recheck read fails
    if (count === firstRead + 3) throw new Error("private read details");
  });
  const response = unpack(await handler(event("POST", existing())));
  assert.equal(response.status, 503);
  assert.equal(response.body.code, "CATALOG_STORAGE_UNAVAILABLE");
  assert.equal(db.transactions.length, 0);
});

test("the global receipt rejects another admin's same operation without replay or a second add", async (t) => {
  const db = fixture(t);
  await handler(event("POST", existing()));
  const rejected = unpack(
    await handler(event("POST", existing(), undefined, "admin-B")),
  );
  assert.equal(rejected.status, 409);
  assert.equal(rejected.body.code, "OCR_INTAKE_OPERATION_CONFLICT");
  assert.equal(rejected.body.product, undefined);
  const alsoRejected = unpack(
    await handler(
      event(
        "POST",
        existing({ existing: { productId: "prd_deck", version: 4 } }),
        undefined,
        "admin-B",
      ),
    ),
  );
  assert.equal(alsoRejected.status, 409);
  assert.equal(alsoRejected.body.code, "OCR_INTAKE_OPERATION_CONFLICT");
  assert.equal(db.records.get("prd_deck")!.inventoryQuantity, 12);
  assert.equal(db.transactions.length, 1);
  assert.equal(
    [...db.records.values()].filter(
      (item) => item.recordType === "CATALOG_INTAKE_RECEIPT",
    ).length,
    1,
  );
});
test("new intake requires price/category and creates a non-featured, image-free DRAFT with initial stock", async (t) => {
  const db = fixture(t);
  const response = unpack(
    await handler(
      event("POST", fresh({ product: { ...fresh().product, name: "새 바퀴" } })),
    ),
  );
  assert.equal(response.status, 201);
  assert.equal(response.body.product.name, "새 바퀴");
  assert.equal(response.body.product.price, 0);
  assert.equal(response.body.product.category, "Wheels");
  assert.equal(response.body.product.inventoryQuantity, 4);
  assert.equal(response.body.product.status, "DRAFT");
  assert.equal(response.body.product.featured, false);
  assert.deepEqual(response.body.product.sizes, ["56mm"]);
  assert.deepEqual(response.body.product.images, []);
  assert.equal(response.body.product.createdBy, undefined);
  assert.equal(
    db.scans.every((scan) => scan.ConsistentRead === true),
    true,
  );
  assert.equal(db.transactions.length, 1);
});
test("new intake replay returns the same product and does not generate a duplicate", async (t) => {
  const db = fixture(t, []);
  const first = unpack(await handler(event("POST", fresh())));
  const second = unpack(await handler(event("POST", fresh())));
  assert.equal(second.status, 200);
  assert.equal(second.body.product.productId, first.body.product.productId);
  assert.equal(second.body.receipt.replayed, true);
  assert.equal(db.transactions.length, 1);
});
test("legacy exact SKU and normalized name/brand/option block duplicate new products", async (t) => {
  const db = fixture(t);
  const matches = [
    { ...fresh().product, sku: " DECK-825 " },
    {
      name: " deck ",
      brandName: "EXAMPLE",
      option: "8.25",
      price: 1,
      category: "Deck",
    },
    { name: "Deck", brandName: "Example", option: "", price: 1, category: "Deck" },
  ];
  for (const candidate of matches) {
    const response = unpack(
      await handler(event("POST", fresh({ product: candidate }))),
    );
    assert.equal(response.status, 409);
    assert.equal(response.body.code, "CATALOG_PRODUCT_DUPLICATE");
    assert.deepEqual(response.body.productIds, ["prd_deck"]);
  }
  assert.equal(db.transactions.length, 0);
});
test("distinct explicit options are not fuzzy merged", async (t) => {
  const db = fixture(t);
  const response = unpack(
    await handler(
      event(
        "POST",
        fresh({
          product: {
            name: "Deck",
            brandName: "Example",
            option: "8.5",
            price: 1,
            category: "Deck",
          },
        }),
      ),
    ),
  );
  assert.equal(response.status, 201);
  assert.equal(db.transactions.length, 1);
});
test("two administrators cannot create the same identity concurrently", async (t) => {
  const db = fixture(t, []);
  const responses = await Promise.all([
    handler(event("POST", fresh(), undefined, "admin-A")),
    handler(event("POST", fresh(), undefined, "admin-B")),
  ]);
  assert.deepEqual(
    responses.map((response) => unpack(response).status).sort(),
    [201, 409],
  );
  assert.equal(db.transactions.length, 1);
  assert.equal(
    [...db.records.values()].filter(
      (item) => item.recordType === "CATALOG_INTAKE_RECEIPT",
    ).length,
    1,
  );
});
test("revision change between scan and commit prevents a stale duplicate decision", async (t) => {
  const db = fixture(t, []);
  db.beforeTransaction(() => {
    db.records.set(REVISION, {
      productId: REVISION,
      recordType: "CATALOG_IDENTITY_REVISION",
      version: 1,
    });
    db.records.set(
      "prd_other",
      product({ productId: "prd_other", name: "New wheel", sizes: ["56mm"] }),
    );
  });
  const response = unpack(await handler(event("POST", fresh())));
  assert.equal(response.status, 409);
  assert.equal(response.body.code, "CATALOG_IDENTITY_CONFLICT");
  assert.equal(db.transactions.length, 0);
  assert.equal(
    [...db.records.values()].some(
      (item) => item.recordType === "CATALOG_INTAKE_RECEIPT",
    ),
    false,
  );
});
test("version conflict, missing product, overflow and malformed intake do not write", async (t) => {
  const db = fixture(t);
  const cases: readonly [unknown, number][] = [
    [existing({ existing: { productId: "prd_deck", version: 2 } }), 409],
    [existing({ existing: { productId: "prd_missing", version: 1 } }), 404],
    [existing({ quantity: 1_000_000 }), 400],
    [existing({ quantity: -1 }), 400],
    [existing({ stock: 100 }), 400],
    [fresh({ product: { ...fresh().product, price: -1 } }), 400],
    [fresh({ product: { ...fresh().product, category: "Invalid" } }), 400],
    [fresh({ product: { ...fresh().product, status: "PUBLISHED" } }), 400],
  ];
  for (const [input, expected] of cases)
    assert.equal(unpack(await handler(event("POST", input))).status, expected);
  assert.equal(db.transactions.length, 0);
});
test("transaction failure leaves stock and receipt unchanged", async (t) => {
  const db = fixture(t);
  db.setFailWrite();
  const response = unpack(await handler(event("POST", existing())));
  assert.equal(response.status, 503);
  assert.equal(response.body.code, "CATALOG_STORAGE_UNAVAILABLE");
  assert.equal(JSON.stringify(response).includes("private"), false);
  assert.equal(db.records.get("prd_deck")!.inventoryQuantity, 10);
  assert.equal(db.records.size, 1);
});
test("failed or truncated identity scan fails closed without a product/receipt write", async (t) => {
  const db = fixture(t);
  db.setEndlessScan();
  assert.equal(unpack(await handler(event("POST", fresh()))).status, 503);
  assert.equal(db.scans.length, 1_000);
  db.setFailScan();
  assert.equal(unpack(await handler(event("POST", fresh()))).status, 503);
  assert.equal(db.transactions.length, 0);
});
test("malformed legacy records and malformed revision fail closed", async (t) => {
  const db = fixture(t);
  db.records.set("prd_broken", { productId: "prd_broken", name: "Hidden duplicate" });
  assert.equal(unpack(await handler(event("POST", fresh()))).status, 503);
  db.records.delete("prd_broken");
  db.records.set(REVISION, { productId: REVISION, recordType: "WRONG", version: 1 });
  assert.equal(unpack(await handler(event("POST", fresh()))).status, 503);
  assert.equal(db.transactions.length, 0);
});
test("normal creation uses the duplicate scan/revision transaction and preserves explicit ID conflicts", async (t) => {
  const db = fixture(t);
  const payload = {
    name: "Deck",
    brand: "Example",
    category: "Deck",
    price: 1,
    sizes: ["8.25"],
    stock: 0,
  };
  const duplicate = unpack(await handler(event("POST", payload)));
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.code, "CATALOG_PRODUCT_DUPLICATE");
  const idConflict = unpack(
    await handler(event("POST", { ...payload, productId: "prd_deck" })),
  );
  assert.equal(idConflict.body.code, "CATALOG_PRODUCT_ID_CONFLICT");
  const created = unpack(
    await handler(event("POST", { ...payload, name: "Another deck" })),
  );
  assert.equal(created.status, 201);
  assert.equal(created.body.product.status, "DRAFT");
  assert.equal(db.transactions.length, 1);
  assert.equal(db.transactions[0].TransactItems!.length, 2);
});
test("normal identity PATCH cannot introduce another product's identity and excludes itself", async (t) => {
  const db = fixture(t, [
    product(),
    product({ productId: "prd_other", name: "Other deck", sku: "OTHER" }),
  ]);
  const duplicate = unpack(
    await handler(event("PATCH", { version: 3, name: "Other deck" }, "prd_deck")),
  );
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.code, "CATALOG_PRODUCT_DUPLICATE");
  const same = unpack(
    await handler(event("PATCH", { version: 3, name: "Deck" }, "prd_deck")),
  );
  assert.equal(same.status, 200);
  assert.equal(same.body.product.version, 4);
  assert.equal(db.transactions.length, 1);
});
test("normal stock-only PATCH and DELETE still advance the revision atomically", async (t) => {
  const db = fixture(t);
  assert.equal(
    unpack(await handler(event("PATCH", { version: 3, stock: 20 }, "prd_deck"))).status,
    200,
  );
  assert.equal(db.records.get(REVISION)!.version, 1);
  assert.equal(db.scans.length, 0);
  assert.equal(
    unpack(await handler(event("DELETE", { version: 4 }, "prd_deck"))).status,
    200,
  );
  assert.equal(db.records.get(REVISION)!.version, 2);
  assert.equal(db.records.has("prd_deck"), false);
});

test("PATCH explicitly clears compareAtPrice without reviving it from the stored product", async (t) => {
  const db = fixture(t, [
    product({
      status: "PUBLISHED",
      publicationStatus: "PUBLISHED",
      image: "/deck.webp",
      price: 80_000,
      compareAtPrice: 100_000,
    }),
  ]);

  const clearedByNull = unpack(
    await handler(
      event("PATCH", { version: 3, price: 120_000, compareAtPrice: null }, "prd_deck"),
    ),
  );
  assert.equal(clearedByNull.status, 200);
  assert.equal(clearedByNull.body.product.price, 120_000);
  assert.equal(clearedByNull.body.product.compareAtPrice, undefined);
  assert.equal(Object.hasOwn(db.records.get("prd_deck")!, "compareAtPrice"), false);

  const changed = unpack(
    await handler(event("PATCH", { version: 4, compareAtPrice: 140_000 }, "prd_deck")),
  );
  assert.equal(changed.status, 200);
  assert.equal(changed.body.product.compareAtPrice, 140_000);

  const omitted = unpack(
    await handler(event("PATCH", { version: 5, featured: true }, "prd_deck")),
  );
  assert.equal(omitted.status, 200);
  assert.equal(omitted.body.product.compareAtPrice, 140_000);

  const successfulWrites = db.transactions.length;
  const invalid = unpack(
    await handler(event("PATCH", { version: 6, compareAtPrice: 0 }, "prd_deck")),
  );
  assert.equal(invalid.status, 400);
  assert.equal(db.transactions.length, successfulWrites);
  assert.equal(db.records.get("prd_deck")!.compareAtPrice, 140_000);
  assert.equal(db.records.get("prd_deck")!.version, 6);

  const clearedByEmptyText = unpack(
    await handler(event("PATCH", { version: 6, compareAtPrice: "" }, "prd_deck")),
  );
  assert.equal(clearedByEmptyText.status, 200);
  assert.equal(clearedByEmptyText.body.product.compareAtPrice, undefined);
  assert.equal(Object.hasOwn(db.records.get("prd_deck")!, "compareAtPrice"), false);
  assert.equal(
    toPublicCatalogProduct(db.records.get("prd_deck") as CatalogProductRecord)
      ?.compareAtPrice,
    undefined,
  );

  const productWrite = db.transactions
    .at(-1)!
    .TransactItems!.find((item) => item.Put?.Item?.productId === "prd_deck")!.Put!;
  assert.equal(productWrite.ConditionExpression, "#version = :expectedVersion");
  assert.equal(productWrite.ExpressionAttributeValues?.[":expectedVersion"], 6);

  const stale = unpack(
    await handler(event("PATCH", { version: 6, compareAtPrice: 150_000 }, "prd_deck")),
  );
  assert.equal(stale.status, 409);
  assert.equal(db.transactions.length, successfulWrites + 1);
  assert.equal(Object.hasOwn(db.records.get("prd_deck")!, "compareAtPrice"), false);
  assert.equal(db.records.get("prd_deck")!.version, 7);
});
test("deckSpec-only PATCH saves, publishes, survives other edits and clears with null", async (t) => {
  const db = fixture(t, [
    product({
      status: "PUBLISHED",
      publicationStatus: "PUBLISHED",
      image: "/deck.webp",
      inventoryQuantity: 10,
      inventoryReserved: 2,
    }),
  ]);
  const deckSpec = {
    nose: 6.875,
    tail: 6.5,
    width: 8.5,
    length: 31.75,
    wheelbase: 14.25,
  };

  // A reserved product still accepts a size-spec edit because it is not part of its identity.
  const saved = unpack(
    await handler(event("PATCH", { version: 3, deckSpec }, "prd_deck")),
  );
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.product.deckSpec, deckSpec);
  assert.equal(saved.body.product.version, 4);
  assert.deepEqual(
    toPublicCatalogProduct(db.records.get("prd_deck") as CatalogProductRecord)
      ?.deckSpec,
    deckSpec,
  );

  const otherEdit = unpack(
    await handler(event("PATCH", { version: 4, featured: true }, "prd_deck")),
  );
  assert.equal(otherEdit.status, 200);
  assert.deepEqual(otherEdit.body.product.deckSpec, deckSpec);

  const successfulWrites = db.transactions.length;
  for (const invalid of [
    { ...deckSpec, tail: 0 },
    { ...deckSpec, width: "8.5" },
    { ...deckSpec, length: 101 },
    { ...deckSpec, nose: 6.87501 },
    { ...deckSpec, tail: 1e-7 },
    { nose: 6.875 },
    "8.5",
  ]) {
    const rejected = unpack(
      await handler(event("PATCH", { version: 5, deckSpec: invalid }, "prd_deck")),
    );
    assert.equal(rejected.status, 400);
  }
  assert.equal(db.transactions.length, successfulWrites);
  assert.deepEqual(db.records.get("prd_deck")!.deckSpec, deckSpec);

  const cleared = unpack(
    await handler(event("PATCH", { version: 5, deckSpec: null }, "prd_deck")),
  );
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.product.deckSpec, undefined);
  assert.equal(Object.hasOwn(db.records.get("prd_deck")!, "deckSpec"), false);
  assert.equal(
    toPublicCatalogProduct(db.records.get("prd_deck") as CatalogProductRecord)
      ?.deckSpec,
    undefined,
  );
});

test("sizeDeckSpec PATCH saves and clears one option, keeps the default, and drops renamed options", async (t) => {
  const db = fixture(t, [
    product({
      status: "PUBLISHED",
      publicationStatus: "PUBLISHED",
      image: "/deck.webp",
      sizes: ["8.0", "8.25", "8.5"],
    }),
  ]);
  const base = { nose: 6.875, tail: 6.5, width: 8.25, length: 31.75, wheelbase: 14.25 };
  const small = { ...base, width: 8, wheelbase: 14 };
  const large = { ...base, width: 8.5, length: 32 };
  const stored = () => db.records.get("prd_deck") as CatalogProductRecord;
  const patch = async (body: Record<string, unknown>) =>
    unpack(await handler(event("PATCH", body, "prd_deck")));

  assert.equal((await patch({ version: 3, deckSpec: base })).status, 200);
  const savedSmall = await patch({ version: 4, size: "8.0", sizeDeckSpec: small });
  assert.equal(savedSmall.status, 200);
  assert.deepEqual(savedSmall.body.product.deckSpec, base);
  assert.deepEqual(savedSmall.body.product.deckSpecsBySize, { "8.0": small });
  const savedLarge = await patch({ version: 5, size: "8.5", sizeDeckSpec: large });
  assert.deepEqual(savedLarge.body.product.deckSpecsBySize, {
    "8.0": small,
    "8.5": large,
  });
  assert.deepEqual(toPublicCatalogProduct(stored())?.deckSpecsBySize, {
    "8.0": small,
    "8.5": large,
  });
  assert.deepEqual(toPublicCatalogProduct(stored())?.deckSpec, base);

  // A default-only save leaves the option values alone.
  const defaultEdit = await patch({ version: 6, deckSpec: { ...base, tail: 6.625 } });
  assert.deepEqual(defaultEdit.body.product.deckSpecsBySize, {
    "8.0": small,
    "8.5": large,
  });

  const writes = db.transactions.length;
  for (const invalid of [
    { version: 7, size: "9.0", sizeDeckSpec: small },
    { version: 7, size: " 8.0", sizeDeckSpec: small },
    { version: 7, size: 8, sizeDeckSpec: small },
    { version: 7, sizeDeckSpec: small },
    { version: 7, size: "8.0" },
    { version: 7, size: "8.0", deckSpec: small },
    { version: 7, size: "8.0", sizeDeckSpec: small, deckSpec: base },
    { version: 7, size: "8.0", sizeDeckSpec: small, sizes: "8.0" },
    { version: 7, size: "8.0", sizeDeckSpec: { ...small, tail: 0 } },
    { version: 7, size: "8.0", sizeDeckSpec: "8.5" },
  ]) {
    assert.equal((await patch(invalid)).status, 400, JSON.stringify(invalid));
  }
  // The full map is server-built and cannot be replaced directly through PATCH.
  const ignored = await patch({ version: 7, deckSpecsBySize: { "8.25": base } });
  assert.equal(ignored.status, 200);
  assert.deepEqual(ignored.body.product.deckSpecsBySize, {
    "8.0": small,
    "8.5": large,
  });
  assert.equal(db.transactions.length, writes + 1);

  const stale = await patch({ version: 7, size: "8.0", sizeDeckSpec: null });
  assert.equal(stale.status, 409);
  assert.deepEqual(stored().deckSpecsBySize, { "8.0": small, "8.5": large });

  const cleared = await patch({ version: 8, size: "8.0", sizeDeckSpec: null });
  assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.body.product.deckSpecsBySize, { "8.5": large });
  assert.deepEqual(cleared.body.product.deckSpec, { ...base, tail: 6.625 });

  // Renaming 8.5 through a product save drops its value; the empty map leaves the row.
  const renamed = await patch({ version: 9, sizes: "8.0, 8.25, 8.75" });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.product.deckSpecsBySize, undefined);
  assert.equal(Object.hasOwn(stored(), "deckSpecsBySize"), false);
  assert.deepEqual(stored().deckSpec, { ...base, tail: 6.625 });
});

test("only option values whose size still exists are kept or returned", async (t) => {
  const spec = { nose: 6.875, tail: 6.5, width: 8.25, length: 31.75, wheelbase: 14.25 };
  // A row written while an older server ignored the pruning may still hold a removed option.
  const legacy = product({
    status: "PUBLISHED",
    publicationStatus: "PUBLISHED",
    image: "/deck.webp",
    sizes: ["8.25", "8.5"],
    deckSpecsBySize: { "8.25": spec, "8.0": spec },
  });
  const db = fixture(t, [legacy]);
  assert.deepEqual(toPublicCatalogProduct(legacy)?.deckSpecsBySize, { "8.25": spec });
  const read = unpack(await handler(event("GET", undefined, "prd_deck")));
  assert.deepEqual(read.body.product.deckSpecsBySize, { "8.25": spec });

  const saved = unpack(
    await handler(event("PATCH", { version: 3, featured: true }, "prd_deck")),
  );
  assert.equal(saved.status, 200);
  assert.deepEqual(db.records.get("prd_deck")!.deckSpecsBySize, { "8.25": spec });
  assert.equal(
    isCatalogProductRecord(
      product({ deckSpecsBySize: { "8.25": { ...spec, tail: 0 } } }),
    ),
    false,
  );
});

test("option size charts are never taken from a create body", async (t) => {
  const db = fixture(t, []);
  const spec = { nose: 6.875, tail: 6.5, width: 8.25, length: 31.75, wheelbase: 14.25 };
  const created = unpack(
    await handler(
      event("POST", {
        name: "New deck",
        brandName: "Example",
        sizes: ["8.25"],
        category: "Deck",
        price: 80_000,
        deckSpecsBySize: { "8.25": spec },
      }),
    ),
  );
  assert.equal(created.status, 201);
  assert.equal(created.body.product.deckSpecsBySize, undefined);
  const row = [...db.records.values()].find((item) => item.name === "New deck")!;
  assert.equal(Object.hasOwn(row, "deckSpecsBySize"), false);
});

test("unsafe option names are refused and saved option charts survive DynamoDB marshalling", async (t) => {
  const unsafe = ["__proto__", "constructor", "prototype"];
  const db = fixture(t, [product({ sizes: [...unsafe, "8.25"] })]);
  const spec = { nose: 6.875, tail: 6.5, width: 8.25, length: 31.75, wheelbase: 14.25 };
  for (const size of unsafe) {
    const refused = unpack(
      await handler(
        event("PATCH", { version: 3, size, sizeDeckSpec: spec }, "prd_deck"),
      ),
    );
    assert.equal(refused.status, 400, size);
  }
  assert.equal(db.transactions.length, 0);

  const saved = unpack(
    await handler(
      event("PATCH", { version: 3, size: "8.25", sizeDeckSpec: spec }, "prd_deck"),
    ),
  );
  assert.equal(saved.status, 200);
  // The in-memory transport skips the SDK conversion, so round-trip the stored row through it.
  const row = db.records.get("prd_deck")!;
  const restored = unmarshall(marshall(row, { removeUndefinedValues: true }));
  assert.deepEqual(restored.deckSpecsBySize, { "8.25": spec });
  assert.equal(isCatalogProductRecord(restored), true);

  // A row that somehow holds such a key never returns it.
  const legacy = product({
    status: "PUBLISHED",
    publicationStatus: "PUBLISHED",
    image: "/deck.webp",
    sizes: [...unsafe, "8.25"],
    deckSpecsBySize: JSON.parse(
      JSON.stringify({ "8.25": spec, constructor: spec, prototype: spec }).replace(
        '"prototype"',
        '"__proto__"',
      ),
    ),
  });
  assert.deepEqual(toPublicCatalogProduct(legacy)?.deckSpecsBySize, { "8.25": spec });
});

test("sizeName renames one option in place and moves its size chart atomically", async (t) => {
  const base = { nose: 6.875, tail: 6.5, width: 8.25, length: 31.75, wheelbase: 14.25 };
  const small = { ...base, width: 8, wheelbase: 14 };
  const large = { ...base, width: 8.5, length: 32 };
  const db = fixture(t, [
    product({
      status: "PUBLISHED",
      publicationStatus: "PUBLISHED",
      image: "/deck.webp",
      sizes: ["8.0", "8.25", "8.5"],
      deckSpec: base,
      // "8.75" is a stale key from a removed option that must not come back.
      deckSpecsBySize: { "8.0": small, "8.5": large, "8.75": base },
    }),
  ]);
  const stored = () => db.records.get("prd_deck") as CatalogProductRecord;
  const patch = async (body: Record<string, unknown>) =>
    unpack(await handler(event("PATCH", body, "prd_deck")));

  const renamed = await patch({
    version: 3,
    size: "8.0",
    sizeName: "8.0 wide",
    sizeDeckSpec: { ...small, tail: 6.625 },
  });
  assert.equal(renamed.status, 200);
  assert.deepEqual(renamed.body.product.sizes, ["8.0 wide", "8.25", "8.5"]);
  assert.deepEqual(renamed.body.product.deckSpecsBySize, {
    "8.0 wide": { ...small, tail: 6.625 },
    "8.5": large,
  });
  assert.deepEqual(renamed.body.product.deckSpec, base);
  assert.deepEqual(stored().sizes, ["8.0 wide", "8.25", "8.5"]);
  assert.equal(Object.hasOwn(stored().deckSpecsBySize!, "8.0"), false);
  assert.deepEqual(toPublicCatalogProduct(stored())?.sizes, [
    "8.0 wide",
    "8.25",
    "8.5",
  ]);

  // A name-only rename with an empty chart moves nothing and drops the stale same-named key.
  const nameOnly = await patch({
    version: 4,
    size: "8.5",
    sizeName: "8.75",
    sizeDeckSpec: null,
  });
  assert.equal(nameOnly.status, 200);
  assert.deepEqual(nameOnly.body.product.sizes, ["8.0 wide", "8.25", "8.75"]);
  assert.deepEqual(nameOnly.body.product.deckSpecsBySize, {
    "8.0 wide": { ...small, tail: 6.625 },
  });
  assert.equal(Object.hasOwn(stored().deckSpecsBySize!, "8.75"), false);

  // Keeping the same name behaves exactly like the H-035 option save.
  const same = await patch({
    version: 5,
    size: "8.25",
    sizeName: "8.25",
    sizeDeckSpec: base,
  });
  assert.equal(same.status, 200);
  assert.deepEqual(same.body.product.sizes, ["8.0 wide", "8.25", "8.75"]);
  assert.deepEqual(same.body.product.deckSpecsBySize["8.25"], base);

  const writes = db.transactions.length;
  for (const sizeName of [
    "",
    " 8.9",
    "8.9 ",
    "x".repeat(51),
    "8.9, 9.0",
    "8.9\n",
    "__proto__",
    "constructor",
    "prototype",
    "8.75",
    8.9,
    null,
  ]) {
    const refused = await patch({
      version: 6,
      size: "8.25",
      sizeName,
      sizeDeckSpec: base,
    });
    assert.equal(refused.status, 400, JSON.stringify(sizeName));
  }
  for (const invalid of [
    { version: 6, size: "8.25", sizeName: "8.9" },
    { version: 6, sizeName: "8.9", sizeDeckSpec: base },
    { version: 6, size: "9.0", sizeName: "8.9", sizeDeckSpec: base },
    { version: 6, size: "8.25", sizeName: "8.9", sizeDeckSpec: base, sizes: "8.9" },
  ]) {
    assert.equal((await patch(invalid)).status, 400, JSON.stringify(invalid));
  }
  assert.equal(db.transactions.length, writes);

  const stale = await patch({
    version: 5,
    size: "8.25",
    sizeName: "8.9",
    sizeDeckSpec: base,
  });
  assert.equal(stale.status, 409);
  assert.deepEqual(stored().sizes, ["8.0 wide", "8.25", "8.75"]);

  // The renamed row still survives the DynamoDB marshaller.
  const restored = unmarshall(marshall(stored(), { removeUndefinedValues: true }));
  assert.deepEqual(restored.sizes, ["8.0 wide", "8.25", "8.75"]);
  assert.equal(isCatalogProductRecord(restored), true);
});

test("a rename onto a stale key with an empty chart does not bring the stale chart back", async (t) => {
  const spec = { nose: 6.875, tail: 6.5, width: 8.25, length: 31.75, wheelbase: 14.25 };
  // "8.75" is left by an older server for an option that no longer exists.
  const db = fixture(t, [
    product({ sizes: ["8.25", "8.5"], deckSpecsBySize: { "8.75": spec } }),
  ]);
  const renamed = unpack(
    await handler(
      event(
        "PATCH",
        { version: 3, size: "8.5", sizeName: "8.75", sizeDeckSpec: null },
        "prd_deck",
      ),
    ),
  );
  assert.equal(renamed.status, 200);
  assert.deepEqual(renamed.body.product.sizes, ["8.25", "8.75"]);
  assert.equal(renamed.body.product.deckSpecsBySize, undefined);
  assert.equal(Object.hasOwn(db.records.get("prd_deck")!, "deckSpecsBySize"), false);
});

test("an existing option the new-name rules would refuse still saves and deletes its chart", async (t) => {
  const spec = { nose: 6.875, tail: 6.5, width: 8.25, length: 31.75, wheelbase: 14.25 };
  // An array-sent product body can store a comma inside one option, which a new name may not use.
  const legacy = "8.5, wide";
  const db = fixture(t, [product({ sizes: ["8.25", legacy] })]);
  for (const [version, body] of [
    [3, { size: legacy, sizeDeckSpec: spec }],
    [4, { size: legacy, sizeName: legacy, sizeDeckSpec: spec }],
    [5, { size: legacy, sizeDeckSpec: null }],
  ] as const) {
    const saved = unpack(
      await handler(event("PATCH", { version, ...body }, "prd_deck")),
    );
    assert.equal(saved.status, 200, JSON.stringify(body));
  }
  assert.deepEqual(db.records.get("prd_deck")!.sizes, ["8.25", legacy]);
  assert.equal(Object.hasOwn(db.records.get("prd_deck")!, "deckSpecsBySize"), false);
});

test("an option rename is refused while stock is reserved or when it duplicates another product", async (t) => {
  const spec = { nose: 6.875, tail: 6.5, width: 8.25, length: 31.75, wheelbase: 14.25 };
  const db = fixture(t, [
    product({ sizes: ["8.25", "8.5"], inventoryReserved: 1 }),
    product({
      productId: "prd_free",
      name: "Free deck",
      sku: "FREE-1",
      sizes: ["8.25"],
    }),
    product({
      productId: "prd_other",
      name: "Free deck",
      sku: "OTHER-1",
      sizes: ["9.0"],
    }),
  ]);
  const reserved = unpack(
    await handler(
      event(
        "PATCH",
        { version: 3, size: "8.5", sizeName: "8.75", sizeDeckSpec: spec },
        "prd_deck",
      ),
    ),
  );
  assert.equal(reserved.status, 409);
  assert.equal(reserved.body.code, "CATALOG_PRODUCT_RESERVED");
  // A chart-only save keeps working on a reserved product.
  const chartOnly = unpack(
    await handler(
      event(
        "PATCH",
        { version: 3, size: "8.5", sizeName: "8.5", sizeDeckSpec: spec },
        "prd_deck",
      ),
    ),
  );
  assert.equal(chartOnly.status, 200);
  assert.deepEqual(db.records.get("prd_deck")!.sizes, ["8.25", "8.5"]);

  const duplicate = unpack(
    await handler(
      event(
        "PATCH",
        { version: 3, size: "8.25", sizeName: "9.0", sizeDeckSpec: null },
        "prd_free",
      ),
    ),
  );
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.code, "CATALOG_PRODUCT_DUPLICATE");
  assert.deepEqual(duplicate.body.productIds, ["prd_other"]);
  assert.deepEqual(db.records.get("prd_free")!.sizes, ["8.25"]);
});

test("a key left for a removed option does not count against the option limit", async (t) => {
  const spec = { nose: 6.875, tail: 6.5, width: 8.25, length: 31.75, wheelbase: 14.25 };
  const sizes = Array.from({ length: 20 }, (_, index) => `S${index}`);
  const legacy = Object.fromEntries([
    ...sizes.slice(0, 19).map((size) => [size, spec]),
    ["removed", spec],
  ]);
  const db = fixture(t, [product({ sizes, deckSpecsBySize: legacy })]);
  const saved = unpack(
    await handler(
      event("PATCH", { version: 3, size: "S19", sizeDeckSpec: spec }, "prd_deck"),
    ),
  );
  assert.equal(saved.status, 200);
  assert.deepEqual(
    Object.keys(db.records.get("prd_deck")!.deckSpecsBySize as object).sort(),
    [...sizes].sort(),
  );
});

test("internal rows cannot be addressed and are hidden without breaking catalog pagination", async (t) => {
  const db = fixture(t);
  await handler(event("POST", existing()));
  const ledger = [...db.records.values()].find(
    (item) => item.recordType === "CATALOG_INTAKE_RECEIPT",
  )!;
  assert.equal(
    unpack(
      await handler(
        event("GET", undefined, encodeURIComponent(ledger.productId as string)),
      ),
    ).status,
    404,
  );
  db.setEndlessScan();
  const list = unpack(await handler(event("GET")));
  assert.equal(list.body.products.length, 1);
  const cursorEvent = event("GET");
  cursorEvent.queryStringParameters = {
    cursor: Buffer.from(JSON.stringify({ productId: ledger.productId })).toString(
      "base64url",
    ),
  };
  assert.equal(unpack(await handler(cursorEvent)).status, 200);
});
test("admin authorization and table configuration fail before any storage mutation", async (t) => {
  const db = fixture(t);
  assert.equal(
    unpack(await handler(event("POST", fresh(), undefined, "", false))).status,
    401,
  );
  assert.equal(
    unpack(await handler(event("POST", fresh(), undefined, "not-admin", false))).status,
    403,
  );
  delete process.env.CATALOG_TABLE_NAME;
  assert.equal(unpack(await handler(event("POST", fresh()))).status, 503);
  assert.equal(db.reads.length, 0);
  assert.equal(db.transactions.length, 0);
});
test("storage read failure returns a safe error without contacting another service", async (t) => {
  const db = fixture(t);
  db.setFailRead();
  const response = unpack(await handler(event("POST", existing())));
  assert.equal(response.status, 503);
  assert.equal(JSON.stringify(response).includes("private"), false);
  assert.equal(db.transactions.length, 0);
});

test("a lost committed response is safely reconciled by the same operation replay", async (t) => {
  const db = fixture(t);
  db.loseCommitResponse();
  assert.equal(unpack(await handler(event("POST", existing()))).status, 503);
  const replay = unpack(await handler(event("POST", existing())));
  assert.equal(replay.status, 200);
  assert.equal(replay.body.receipt.replayed, true);
  assert.equal(db.records.get("prd_deck")!.inventoryQuantity, 12);
  assert.equal(db.transactions.length, 1);
});

test("duplicate scanning follows pages before deciding a new product is safe", async (t) => {
  const db = fixture(t);
  db.setScanPages([
    [product({ productId: "prd_first", name: "Unrelated" })],
    [product()],
  ]);
  const response = unpack(
    await handler(
      event(
        "POST",
        fresh({
          product: {
            name: "Deck",
            brandName: "Example",
            option: "8.25",
            price: 1,
            category: "Deck",
          },
        }),
      ),
    ),
  );
  assert.equal(response.status, 409);
  assert.equal(response.body.code, "CATALOG_PRODUCT_DUPLICATE");
  assert.equal(db.scans.length, 2);
  assert.deepEqual(db.scans[1].ExclusiveStartKey, { productId: "prd_page_cursor" });
  assert.equal(db.transactions.length, 0);
});

test("normal create and OCR create share the same atomic identity guard", async (t) => {
  const db = fixture(t, []);
  const responses = await Promise.all([
    handler(event("POST", fresh())),
    handler(
      event("POST", {
        name: "New wheel",
        brandName: "Example",
        sizes: ["56mm"],
        category: "Wheels",
        price: 0,
      }),
    ),
  ]);
  assert.deepEqual(
    responses.map((response) => unpack(response).status).sort(),
    [201, 409],
  );
  assert.equal(db.transactions.length, 1);
});

test("cross-admin simultaneous replay cannot produce a second addition or disclose an outcome", async (t) => {
  const db = fixture(t);
  const responses = await Promise.all([
    handler(event("POST", existing(), undefined, "admin-A")),
    handler(event("POST", existing(), undefined, "admin-B")),
  ]);
  assert.deepEqual(
    responses.map((response) => unpack(response).status).sort(),
    [200, 409],
  );
  const conflict = responses.map(unpack).find((response) => response.status === 409)!;
  assert.equal(conflict.body.code, "OCR_INTAKE_OPERATION_CONFLICT");
  assert.equal(conflict.body.product, undefined);
  assert.equal(conflict.body.receipt, undefined);
  assert.equal(db.records.get("prd_deck")!.inventoryQuantity, 12);
  assert.equal(db.transactions.length, 1);
});

test("replay re-applies response allowlists instead of returning arbitrary stored fields", async (t) => {
  const db = fixture(t);
  await handler(event("POST", existing()));
  const ledger = [...db.records.values()].find(
    (item) => item.recordType === "CATALOG_INTAKE_RECEIPT",
  )!;
  const outcome = ledger.outcome as {
    product: Record<string, unknown>;
    receipt: Record<string, unknown>;
  };
  outcome.product.createdBy = "private actor";
  outcome.product.rawText = "private source";
  outcome.receipt.rawText = "private source";
  const replay = unpack(await handler(event("POST", existing())));
  assert.equal(replay.status, 200);
  assert.equal(JSON.stringify(replay).includes("private"), false);
});

test("splitting or merging an already applied group cannot re-add its source rows", async (t) => {
  const db = fixture(t);
  const group = existing({
    quantity: 4,
    source: { jobId: "ocr_saved", rowIds: ["row_B", "row_A"] },
  });
  assert.equal(unpack(await handler(event("POST", group))).status, 200);
  for (const [index, rowIds] of [["row_A"], ["row_B"], ["row_C", "row_A"]].entries()) {
    const response = unpack(
      await handler(
        event(
          "POST",
          existing({
            operationId: `ocr_regroup_${index}`,
            quantity: 2,
            existing: { productId: "prd_deck", version: 4 },
            source: { jobId: "ocr_saved", rowIds },
          }),
        ),
      ),
    );
    assert.equal(response.status, 409);
    assert.equal(response.body.code, "OCR_INTAKE_ROW_CONFLICT");
    assert.equal(response.body.product, undefined);
  }
  assert.equal(db.records.get("prd_deck")!.inventoryQuantity, 14);
  assert.equal(db.records.get(REVISION)!.version, 1);
  assert.equal(db.transactions.length, 1);
  assert.equal(
    [...db.records.values()].filter(
      (item) => item.recordType === "CATALOG_INTAKE_RECEIPT",
    ).length,
    1,
  );
  assert.equal(
    [...db.records.values()].filter(
      (item) => item.recordType === "CATALOG_INTAKE_ROW_CLAIM",
    ).length,
    2,
  );
});

test("source order is canonical so reordering a group replays its original receipt", async (t) => {
  const db = fixture(t);
  const group = existing({
    source: { jobId: "ocr_saved", rowIds: ["row_B", "row_A"] },
  });
  await handler(event("POST", group));
  const replay = unpack(
    await handler(
      event("POST", {
        ...group,
        source: { jobId: "ocr_saved", rowIds: ["row_A", "row_B"] },
      }),
    ),
  );
  assert.equal(replay.status, 200);
  assert.equal(replay.body.receipt.replayed, true);
  assert.equal(db.transactions.length, 1);
});

test("retargeting a source row to another product or administrator cannot consume it again", async (t) => {
  const db = fixture(t, [
    product(),
    product({ productId: "prd_other", name: "Other deck", sku: "OTHER" }),
  ]);
  await handler(event("POST", existing()));
  for (const sub of ["admin-A", "admin-B"]) {
    const response = unpack(
      await handler(
        event(
          "POST",
          existing({
            operationId: `ocr_retarget_${sub}`,
            existing: { productId: "prd_other", version: 3 },
          }),
          undefined,
          sub,
        ),
      ),
    );
    assert.equal(response.status, 409);
    assert.equal(response.body.code, "OCR_INTAKE_ROW_CONFLICT");
    assert.equal(response.body.receipt, undefined);
  }
  assert.equal(db.records.get("prd_other")!.inventoryQuantity, 10);
  assert.equal(db.transactions.length, 1);
});

test("simultaneous different operation keys claiming the same row commit only one full transaction", async (t) => {
  const db = fixture(t, [
    product(),
    product({ productId: "prd_other", name: "Other deck", sku: "OTHER" }),
  ]);
  const responses = await Promise.all([
    handler(event("POST", existing())),
    handler(
      event(
        "POST",
        existing({
          operationId: "ocr_other_operation",
          existing: { productId: "prd_other", version: 3 },
        }),
      ),
    ),
  ]);
  assert.deepEqual(
    responses.map((response) => unpack(response).status).sort(),
    [200, 409],
  );
  assert.equal(
    responses.map(unpack).find((response) => response.status === 409)!.body.code,
    "OCR_INTAKE_ROW_CONFLICT",
  );
  assert.equal(db.transactions.length, 1);
  assert.equal(
    [...db.records.values()].filter(
      (item) => item.recordType === "CATALOG_INTAKE_RECEIPT",
    ).length,
    1,
  );
  assert.equal(
    [...db.records.values()].filter(
      (item) => item.recordType === "CATALOG_INTAKE_ROW_CLAIM",
    ).length,
    1,
  );
  assert.equal(
    Number(db.records.get("prd_deck")!.inventoryQuantity) +
      Number(db.records.get("prd_other")!.inventoryQuantity),
    22,
  );
});

test("a claimed source aborts new-product creation, receipt, revision and remaining claims together", async (t) => {
  const db = fixture(t);
  await handler(event("POST", existing()));
  const before = structuredClone([...db.records.entries()]);
  const response = unpack(
    await handler(
      event(
        "POST",
        fresh({ source: { jobId: "ocr_saved", rowIds: ["row_A", "row_unclaimed"] } }),
      ),
    ),
  );
  assert.equal(response.status, 409);
  assert.equal(response.body.code, "OCR_INTAKE_ROW_CONFLICT");
  assert.deepEqual([...db.records.entries()], before);
  assert.equal(db.transactions.length, 1);
});

test("96 source rows fit 99 atomic actions, while 97 rows are rejected before reading or writing", async (t) => {
  const db = fixture(t, []);
  const rowIds = Array.from({ length: 96 }, (_, index) => `row_${index}`);
  const response = unpack(
    await handler(event("POST", fresh({ source: { jobId: "ocr_saved", rowIds } }))),
  );
  assert.equal(response.status, 201);
  assert.equal(db.transactions[0].TransactItems!.length, 99);
  const reads = db.reads.length;
  const rejected = unpack(
    await handler(
      event(
        "POST",
        fresh({
          operationId: "ocr_oversized",
          source: { jobId: "ocr_saved", rowIds: [...rowIds, "row_97"] },
        }),
      ),
    ),
  );
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.code, "OCR_INTAKE_INVALID");
  assert.equal(db.reads.length, reads);
  assert.equal(db.transactions.length, 1);
});

test("claims contain only opaque references and are excluded from list, identity scan and direct routes", async (t) => {
  const db = fixture(t);
  await handler(event("POST", existing()));
  const claim = [...db.records.values()].find(
    (item) => item.recordType === "CATALOG_INTAKE_ROW_CLAIM",
  )!;
  assert.deepEqual(Object.keys(claim).sort(), [
    "operationHash",
    "ownerHash",
    "productId",
    "recordType",
  ]);
  assert.equal(JSON.stringify(claim).includes("ocr_saved"), false);
  assert.equal(JSON.stringify(claim).includes("row_A"), false);
  assert.equal(
    unpack(
      await handler(
        event("GET", undefined, encodeURIComponent(claim.productId as string)),
      ),
    ).status,
    404,
  );
  assert.equal(unpack(await handler(event("GET"))).body.products.length, 1);
  assert.equal(unpack(await handler(event("POST", fresh()))).status, 201);
  const cursorEvent = event("GET");
  cursorEvent.queryStringParameters = {
    cursor: Buffer.from(JSON.stringify({ productId: claim.productId })).toString(
      "base64url",
    ),
  };
  assert.equal(unpack(await handler(cursorEvent)).status, 200);
});

function historyPages(products: readonly CatalogProductRecord[] = [product()]) {
  const records: Record<string, unknown>[] = Array.from(
    { length: 5_001 },
    (_, index) => ({
      productId: `~catalog_${index % 2 ? "claim" : "receipt"}_${index.toString(16).padStart(64, "0")}`,
      recordType: index % 2 ? "CATALOG_INTAKE_ROW_CLAIM" : "CATALOG_INTAKE_RECEIPT",
    }),
  );
  records.push(...products);
  return Array.from({ length: Math.ceil(records.length / 1_000) }, (_, page) =>
    records.slice(page * 1_000, (page + 1) * 1_000),
  );
}

for (const mutation of ["normal-create", "ocr-create", "identity-update"] as const) {
  test(`${mutation} succeeds with more than 5000 permanent internal records and few products`, async (t) => {
    const db = fixture(t);
    db.setScanPages(historyPages());
    const request =
      mutation === "ocr-create"
        ? event("POST", fresh())
        : mutation === "normal-create"
          ? event("POST", {
              name: "Another deck",
              brandName: "Example",
              sizes: ["8.25"],
              category: "Deck",
              price: 1,
            })
          : event("PATCH", { version: 3, name: "Renamed deck" }, "prd_deck");
    const response = unpack(await handler(request));
    assert.equal(response.status, mutation === "identity-update" ? 200 : 201);
    assert.equal(db.scans.length, 6);
    assert.equal(
      db.scans.every((scan) => scan.ConsistentRead === true && scan.Limit === 1_000),
      true,
    );
    assert.equal(db.transactions.length, 1);
  });
}

test("a legacy duplicate behind more than 5000 internal records is still rejected", async (t) => {
  const db = fixture(t);
  db.setScanPages(historyPages());
  const response = unpack(
    await handler(
      event(
        "POST",
        fresh({
          product: {
            name: "Deck",
            brandName: "Example",
            option: "8.25",
            price: 1,
            category: "Deck",
          },
        }),
      ),
    ),
  );
  assert.equal(response.status, 409);
  assert.equal(response.body.code, "CATALOG_PRODUCT_DUPLICATE");
  assert.equal(db.scans.length, 6);
  assert.equal(db.transactions.length, 0);
});

test("5001 validated real products exceed the product budget with no partial mutation", async (t) => {
  const db = fixture(t, []);
  const products = Array.from({ length: 5_001 }, (_, index) =>
    product({
      productId: `prd_${index}`,
      name: `Product ${index}`,
      sku: `SKU-${index}`,
    }),
  );
  db.setScanPages(
    Array.from({ length: 6 }, (_, page) =>
      products.slice(page * 1_000, (page + 1) * 1_000),
    ),
  );
  const response = unpack(await handler(event("POST", fresh())));
  assert.equal(response.status, 503);
  assert.equal(db.transactions.length, 0);
  assert.equal(db.records.size, 0);
});

test("raw scan budget is separate from the real product budget", async (t) => {
  const db = fixture(t, []);
  db.reportScanCount(1_000_001);
  assert.equal(unpack(await handler(event("POST", fresh()))).status, 503);
  assert.equal(db.scans.length, 1);
  assert.equal(db.transactions.length, 0);
});

test("a stalled SDK scan cannot extend the five-second deadline even if it ignores abort", async (t) => {
  const db = fixture(t, []);
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  db.stallScan();
  const pending = handler(event("POST", fresh()));
  for (let tick = 0; tick < 12 && db.scans.length === 0; tick += 1)
    await Promise.resolve();
  assert.equal(db.scans.length, 1);
  let settled = false;
  void pending.then(() => {
    settled = true;
  });
  t.mock.timers.tick(4_999);
  await Promise.resolve();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  const response = unpack(await pending);
  assert.equal(response.status, 503);
  assert.equal(db.scanSignal()!.aborted, true);
  assert.equal(db.transactions.length, 0);
});

test("a scan resolving at the deadline cannot return a successful duplicate check", async (t) => {
  const db = fixture(t, []);
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  db.beforeScan(() => {
    t.mock.timers.setTime(Date.now() + 5_000);
  });
  assert.equal(unpack(await handler(event("POST", fresh()))).status, 503);
  assert.equal(db.scanSignal()!.aborted, true);
  assert.equal(db.transactions.length, 0);
});

const shortSleeve = {
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
const longPants = {
  kind: "longPants",
  values: { length: 100, waist: 40, hip: 52, thigh: 32, rise: 30, hem: 21.5 },
};
function top(patch: Partial<CatalogProductRecord> = {}) {
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

test("sizeChart PATCH saves a kind the category offers, publishes, survives other edits and clears with null", async (t) => {
  const db = fixture(t, [top()]);
  const stored = () => db.records.get("prd_top") as CatalogProductRecord;
  const saved = unpack(
    await handler(event("PATCH", { version: 3, sizeChart: shortSleeve }, "prd_top")),
  );
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.product.sizeChart, shortSleeve);
  assert.deepEqual(stored().sizeChart, shortSleeve);
  assert.deepEqual(toPublicCatalogProduct(stored())?.sizeChart, shortSleeve);

  // Like deckSpec, other fields may come with it or without it.
  const otherEdit = unpack(
    await handler(event("PATCH", { version: 4, featured: true }, "prd_top")),
  );
  assert.deepEqual(otherEdit.body.product.sizeChart, shortSleeve);
  const raglan = {
    kind: "raglanLongSleeve",
    values: { length: 70, chest: 58, cuff: 10, neckToCuff: 80, hem: 50, armhole: 30 },
  };
  const together = unpack(
    await handler(
      event("PATCH", { version: 5, featured: false, sizeChart: raglan }, "prd_top"),
    ),
  );
  assert.equal(together.status, 200);
  assert.deepEqual(stored().sizeChart, raglan);
  assert.equal(stored().featured, false);

  const writes = db.transactions.length;
  const { values } = shortSleeve;
  for (const invalid of [
    "shortSleeve",
    [],
    { kind: "shortSleeve" },
    { ...shortSleeve, extra: 1 },
    { kind: "deck", values },
    // Wheels and pants are real kinds, but not ones a top can use.
    { kind: "wheel", values: { diameter: 54, width: 33, contactWidth: 20 } },
    longPants,
    { kind: "shortSleeve", values: { ...values, armhole: undefined } },
    { kind: "shortSleeve", values: { ...values, extra: 1 } },
    { kind: "shortSleeve", values: { ...values, length: 0 } },
    { kind: "shortSleeve", values: { ...values, length: 300.1 } },
    { kind: "shortSleeve", values: { ...values, length: 72.25 } },
    { kind: "shortSleeve", values: { ...values, length: "72" } },
  ]) {
    const rejected = unpack(
      await handler(event("PATCH", { version: 6, sizeChart: invalid }, "prd_top")),
    );
    assert.equal(rejected.status, 400, JSON.stringify(invalid));
  }
  assert.equal(db.transactions.length, writes);
  assert.deepEqual(stored().sizeChart, raglan);

  const cleared = unpack(
    await handler(event("PATCH", { version: 6, sizeChart: null }, "prd_top")),
  );
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.product.sizeChart, undefined);
  assert.equal(Object.hasOwn(stored(), "sizeChart"), false);
});

test("a category change keeps a size chart the new category offers and drops one it does not", async (t) => {
  const db = fixture(t, [
    top({ sizeChart: shortSleeve as CatalogProductRecord["sizeChart"] }),
  ]);
  const stored = () => db.records.get("prd_top") as CatalogProductRecord;
  // Top and Outerwear share both top drawings.
  const outerwear = unpack(
    await handler(event("PATCH", { version: 3, category: "Outerwear" }, "prd_top")),
  );
  assert.equal(outerwear.status, 200);
  assert.deepEqual(stored().sizeChart, shortSleeve);
  // A top drawing means nothing for bottoms, so it is removed rather than kept hidden.
  const bottom = unpack(
    await handler(event("PATCH", { version: 4, category: "Bottom" }, "prd_top")),
  );
  assert.equal(bottom.status, 200);
  assert.equal(bottom.body.product.sizeChart, undefined);
  assert.equal(Object.hasOwn(stored(), "sizeChart"), false);
  // A chart sent with the category change is checked against the new category.
  assert.equal(
    unpack(
      await handler(
        event(
          "PATCH",
          { version: 5, category: "Wheels", sizeChart: longPants },
          "prd_top",
        ),
      ),
    ).status,
    400,
  );
  // A category that is not even a string is a bad request, not a crash, and writes nothing.
  const writes = db.transactions.length;
  for (const category of [{ toString: null }, ["Bottom"], 7, null])
    assert.equal(
      unpack(
        await handler(
          event("PATCH", { version: 5, category, sizeChart: longPants }, "prd_top"),
        ),
      ).status,
      400,
      JSON.stringify(category),
    );
  assert.equal(db.transactions.length, writes);
  const both = unpack(
    await handler(
      event(
        "PATCH",
        { version: 5, category: "Bottom", sizeChart: longPants },
        "prd_top",
      ),
    ),
  );
  assert.equal(both.status, 200);
  assert.deepEqual(stored().sizeChart, longPants);
  // Deck keeps its own deckSpec; a deck cannot hold this chart.
  assert.equal(
    unpack(await handler(event("PATCH", { version: 6, category: "Deck" }, "prd_top")))
      .status,
    200,
  );
  assert.equal(Object.hasOwn(stored(), "sizeChart"), false);
});

test("product creation ignores sizeChart, which is saved only by PATCH", async (t) => {
  const db = fixture(t, []);
  const created = unpack(
    await handler(
      event("POST", {
        name: "New top",
        brand: "Example",
        category: "Top",
        price: 1,
        sizes: ["M"],
        stock: 0,
        sizeChart: shortSleeve,
      }),
    ),
  );
  assert.equal(created.status, 201);
  assert.equal(created.body.product.sizeChart, undefined);
  const record = [...db.records.values()].find((row) => row.name === "New top");
  assert.equal(Object.hasOwn(record!, "sizeChart"), false);
});

test("a malformed or mismatched stored size chart never hides the product and is left out", async (t) => {
  for (const sizeChart of [
    { kind: "shortSleeve", values: { length: 72 } },
    { ...longPants },
    "72",
  ]) {
    const row = top({
      sizeChart: sizeChart as unknown as CatalogProductRecord["sizeChart"],
    });
    assert.equal(isCatalogProductRecord(row), true);
    const visible = toPublicCatalogProduct(row);
    assert.equal(visible?.slug, "top");
    assert.equal(visible?.sizeChart, undefined);
  }
  const db = fixture(t, [
    top({ sizeChart: longPants as unknown as CatalogProductRecord["sizeChart"] }),
  ]);
  const read = unpack(await handler(event("GET", undefined, "prd_top")));
  assert.equal(read.status, 200);
  assert.equal(read.body.product.sizeChart, undefined);
  // An unrelated save still works and cleans the unusable value away.
  const saved = unpack(
    await handler(event("PATCH", { version: 3, featured: true }, "prd_top")),
  );
  assert.equal(saved.status, 200);
  assert.equal(Object.hasOwn(db.records.get("prd_top")!, "sizeChart"), false);
});

test("server size chart rules match the storefront rules table", async () => {
  // The root package is not an infra dependency, so it is loaded at run time only.
  const client = (await import(
    new URL("../../lib/size-chart.ts", import.meta.url).href
  )) as {
    SIZE_CHART_KINDS: readonly string[];
    SIZE_CHART_KIND_INFO: Record<string, { unit: string; fields: { key: string }[] }>;
    sizeChartKindsFor: (category: string) => readonly string[];
    isSizeChartValues: (kind: string, value: unknown) => boolean;
  };
  assert.deepEqual([...SIZE_CHART_KINDS], [...client.SIZE_CHART_KINDS]);
  for (const kind of SIZE_CHART_KINDS) {
    const info = client.SIZE_CHART_KIND_INFO[kind];
    assert.equal(SIZE_CHART_KIND_RULES[kind].unit, info.unit, kind);
    assert.deepEqual(
      [...SIZE_CHART_KIND_RULES[kind].keys],
      info.fields.map((field) => field.key),
      kind,
    );
  }
  // Both sides judge the same values, including each unit's edges, the same way.
  for (const kind of SIZE_CHART_KINDS) {
    const { unit, keys } = SIZE_CHART_KIND_RULES[kind];
    const max = unit === "mm" ? 100 : 300;
    const filled = (value: unknown) =>
      Object.fromEntries(keys.map((key) => [key, value]));
    const cases: [unknown, boolean][] = [
      [filled(max), true],
      [filled(0.1), true],
      [filled(12.5), true],
      [filled(max + 0.1), false],
      [filled(0), false],
      [filled(-1), false],
      [filled(12.25), false],
      [filled("12"), false],
      [filled(Number.NaN), false],
      [filled(Number.POSITIVE_INFINITY), false],
      [{ ...filled(12), extra: 12 }, false],
      [Object.fromEntries(keys.slice(1).map((key) => [key, 12])), false],
      [null, false],
      [[], false],
    ];
    for (const [value, expected] of cases) {
      const label = `${kind} ${JSON.stringify(value)}`;
      assert.equal(isSizeChartValues(kind, value), expected, label);
      assert.equal(client.isSizeChartValues(kind, value), expected, label);
    }
  }
  assert.equal(
    isSizeChartValues("wheel", { diameter: 100, width: 100, contactWidth: 100 }),
    true,
  );
  assert.equal(
    isSizeChartValues("wheel", { diameter: 100.1, width: 100, contactWidth: 100 }),
    false,
  );
  for (const category of [
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
    "__proto__",
  ])
    assert.deepEqual(
      [...sizeChartKindsFor(category)],
      [...client.sizeChartKindsFor(category)],
      category,
    );
});

const raglanValues = {
  length: 70,
  chest: 58,
  cuff: 10,
  neckToCuff: 80,
  hem: 50,
  armhole: 30,
};
const deckValues = {
  nose: 6.875,
  tail: 6.5,
  width: 8.5,
  length: 31.75,
  wheelbase: 14.25,
};
type Row = CatalogProductRecord;

test("sizeChartValues PATCH saves and clears one option under the product's drawing, even without a default", async (t) => {
  const db = fixture(t, [top({ sizes: ["S", "M"] })]);
  const stored = () => db.records.get("prd_top") as Row;
  const patch = async (body: Record<string, unknown>) =>
    unpack(await handler(event("PATCH", body, "prd_top")));
  // No default and no chosen drawing yet: the category's default drawing applies and is recorded.
  const saved = await patch({
    version: 3,
    size: "M",
    sizeChartValues: shortSleeve.values,
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.product.sizeChartKind, "shortSleeve");
  assert.deepEqual(saved.body.product.sizeChartsBySize, { M: shortSleeve.values });
  assert.equal(saved.body.product.sizeChart, undefined);
  assert.equal(stored().sizeChartKind, "shortSleeve");
  assert.deepEqual(toPublicCatalogProduct(stored())?.sizeChartsBySize, {
    M: shortSleeve.values,
  });
  assert.equal(toPublicCatalogProduct(stored())?.sizeChartKind, "shortSleeve");

  const writes = db.transactions.length;
  for (const invalid of [
    // Other fields never ride along, so an older server cannot half-apply it.
    { version: 4, size: "M", sizeChartValues: shortSleeve.values, featured: true },
    { version: 4, size: "M", sizeChartValues: shortSleeve.values, sizeDeckSpec: null },
    { version: 4, size: "M", sizeChartValues: shortSleeve.values, sizeChart: null },
    { version: 4, size: "XL", sizeChartValues: shortSleeve.values },
    { version: 4, size: "__proto__", sizeChartValues: shortSleeve.values },
    { version: 4, size: "M", sizeChartValues: raglanValues },
    {
      version: 4,
      size: "M",
      sizeChartValues: { ...shortSleeve.values, length: 300.1 },
    },
    { version: 4, size: "M", sizeChartValues: "72" },
    { version: 4, size: "M" },
  ])
    assert.equal((await patch(invalid)).status, 400, JSON.stringify(invalid));
  assert.equal(db.transactions.length, writes);

  const cleared = await patch({ version: 4, size: "M", sizeChartValues: null });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.product.sizeChartsBySize, undefined);
  assert.equal(Object.hasOwn(stored(), "sizeChartsBySize"), false);
  // The chosen drawing stays after its last value is gone.
  assert.equal(cleared.body.product.sizeChartKind, "shortSleeve");

  // A deck has no clothing or wheel drawing to follow.
  const deck = fixture(t, [product()]);
  assert.equal(
    unpack(
      await handler(
        event(
          "PATCH",
          {
            version: 3,
            size: "8.25",
            sizeChartValues: { diameter: 54, width: 33, contactWidth: 20 },
          },
          "prd_deck",
        ),
      ),
    ).status,
    400,
  );
  assert.equal(deck.transactions.length, 0);
});

test("the kind PATCH clears the default and every option value; a default cannot switch drawing under option values", async (t) => {
  const db = fixture(t, [
    top({
      sizes: ["S", "M"],
      sizeChart: shortSleeve as Row["sizeChart"],
      sizeChartKind: "shortSleeve",
      sizeChartsBySize: { M: shortSleeve.values },
    }),
  ]);
  const stored = () => db.records.get("prd_top") as Row;
  const patch = async (body: Record<string, unknown>) =>
    unpack(await handler(event("PATCH", body, "prd_top")));
  const raglan = { kind: "raglanLongSleeve", values: raglanValues };
  assert.equal((await patch({ version: 3, sizeChart: raglan })).status, 400);
  const sameKind = await patch({
    version: 3,
    sizeChart: { ...shortSleeve, values: { ...shortSleeve.values, length: 73 } },
  });
  assert.equal(sameKind.status, 200);
  assert.deepEqual(stored().sizeChartsBySize, { M: shortSleeve.values });

  const writes = db.transactions.length;
  for (const invalid of [
    { version: 4, sizeChartKind: "wheel" },
    { version: 4, sizeChartKind: "deck" },
    { version: 4, sizeChartKind: null },
    { version: 4, sizeChartKind: "raglanLongSleeve", featured: true },
    { version: 4, sizeChartKind: "raglanLongSleeve", sizeChart: raglan },
  ])
    assert.equal((await patch(invalid)).status, 400, JSON.stringify(invalid));
  assert.equal(db.transactions.length, writes);

  // Choosing the drawing already in use keeps every value.
  const same = await patch({ version: 4, sizeChartKind: "shortSleeve" });
  assert.equal(same.status, 200);
  assert.equal(stored().sizeChart?.values.length, 73);
  assert.deepEqual(stored().sizeChartsBySize, { M: shortSleeve.values });

  const changed = await patch({ version: 5, sizeChartKind: "raglanLongSleeve" });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.product.sizeChartKind, "raglanLongSleeve");
  assert.equal(changed.body.product.sizeChart, undefined);
  assert.equal(changed.body.product.sizeChartsBySize, undefined);
  for (const field of ["sizeChart", "sizeChartsBySize"])
    assert.equal(Object.hasOwn(stored(), field), false, field);
  // New values now follow the new drawing.
  assert.equal(
    (await patch({ version: 6, size: "S", sizeChartValues: raglanValues })).status,
    200,
  );
  assert.equal((await patch({ version: 7, sizeChart: raglan })).status, 200);
  assert.deepEqual(stored().sizeChartsBySize, { S: raglanValues });
});

test("renaming an option moves both kinds of option value, and saves prune missing options and special keys", async (t) => {
  const db = fixture(t, [
    top({
      sizes: ["S", "M"],
      sizeChartKind: "shortSleeve",
      sizeChartsBySize: { S: shortSleeve.values, M: shortSleeve.values },
      deckSpecsBySize: { S: deckValues },
    }),
  ]);
  const stored = () => db.records.get("prd_top") as Row;
  const patch = async (body: Record<string, unknown>) =>
    unpack(await handler(event("PATCH", body, "prd_top")));
  const longer = { ...shortSleeve.values, length: 75 };
  const renamed = await patch({
    version: 3,
    size: "M",
    sizeName: "L",
    sizeChartValues: longer,
  });
  assert.equal(renamed.status, 200);
  assert.deepEqual(stored().sizes, ["S", "L"]);
  assert.deepEqual(stored().sizeChartsBySize, { S: shortSleeve.values, L: longer });
  // A deck-value rename carries the size chart value along too.
  const deckRename = await patch({
    version: 4,
    size: "S",
    sizeName: "XS",
    sizeDeckSpec: null,
  });
  assert.equal(deckRename.status, 200);
  assert.deepEqual(stored().sizeChartsBySize, { L: longer, XS: shortSleeve.values });
  assert.equal(Object.hasOwn(stored(), "deckSpecsBySize"), false);

  // A product save that drops an option drops its value.
  assert.equal((await patch({ version: 5, sizes: ["XS"] })).status, 200);
  assert.deepEqual(stored().sizeChartsBySize, { XS: shortSleeve.values });

  // DynamoDB keeps the nested values exactly.
  const restored = unmarshall(
    marshall(stored(), { removeUndefinedValues: true }),
  ) as Row;
  assert.deepEqual(restored.sizeChartsBySize, stored().sizeChartsBySize);
  assert.equal(restored.sizeChartKind, "shortSleeve");
  assert.equal(isCatalogProductRecord(restored), true);

  // Keys that are not options, or that name Object internals, never reach a response.
  const legacy = top({
    sizes: ["M", "__proto__", "constructor"],
    sizeChartKind: "shortSleeve",
    sizeChartsBySize: JSON.parse(
      `{"__proto__":${JSON.stringify(shortSleeve.values)},"constructor":${JSON.stringify(shortSleeve.values)},"M":${JSON.stringify(shortSleeve.values)},"XL":${JSON.stringify(shortSleeve.values)}}`,
    ),
  });
  assert.equal(isCatalogProductRecord(legacy), true);
  const output = toPublicCatalogProduct(legacy)?.sizeChartsBySize;
  assert.deepEqual(Object.keys(output ?? {}), ["M"]);
  assert.equal(Object.getPrototypeOf(output), Object.prototype);
});

test("a category change drops option values and the chosen drawing it cannot use; creation ignores them", async (t) => {
  const db = fixture(t, [
    top({
      sizes: ["M"],
      sizeChartKind: "raglanLongSleeve",
      sizeChartsBySize: { M: raglanValues },
    }),
  ]);
  const stored = () => db.records.get("prd_top") as Row;
  assert.equal(
    unpack(
      await handler(event("PATCH", { version: 3, category: "Outerwear" }, "prd_top")),
    ).status,
    200,
  );
  assert.deepEqual(stored().sizeChartsBySize, { M: raglanValues });
  assert.equal(stored().sizeChartKind, "raglanLongSleeve");
  const bottom = unpack(
    await handler(event("PATCH", { version: 4, category: "Bottom" }, "prd_top")),
  );
  assert.equal(bottom.status, 200);
  for (const field of ["sizeChartKind", "sizeChartsBySize"]) {
    assert.equal(Object.hasOwn(stored(), field), false, field);
    assert.equal(bottom.body.product[field], undefined, field);
  }

  const created = unpack(
    await handler(
      event("POST", {
        name: "Fresh top",
        brand: "Example",
        category: "Top",
        price: 1,
        sizes: ["M"],
        stock: 0,
        sizeChartKind: "raglanLongSleeve",
        sizeChartsBySize: { M: raglanValues },
      }),
    ),
  );
  assert.equal(created.status, 201);
  const record = [...db.records.values()].find((row) => row.name === "Fresh top")!;
  for (const field of ["sizeChartKind", "sizeChartsBySize"])
    assert.equal(Object.hasOwn(record, field), false, field);
});

const partialDeck = {
  nose: 6.875,
  tail: null,
  width: null,
  length: 31.75,
  wheelbase: null,
};

test("a deck row with blank size fields stays a valid product in the admin list and the store", async (t) => {
  // The record check runs on every read; a blank field must never hide the product.
  const row = product({
    status: "PUBLISHED",
    publicationStatus: "PUBLISHED",
    image: "/deck.webp",
    sizes: ["8.25", "8.5"],
    deckSpec: partialDeck,
    deckSpecsBySize: { "8.5": { ...partialDeck, nose: null, tail: 6.5 } },
  });
  assert.equal(isCatalogProductRecord(row), true);
  const visible = toPublicCatalogProduct(row);
  assert.deepEqual(visible?.deckSpec, partialDeck);
  assert.deepEqual(visible?.deckSpecsBySize, {
    "8.5": { ...partialDeck, nose: null, tail: 6.5 },
  });
  // DynamoDB keeps the blank fields as null.
  const restored = unmarshall(marshall(row, { removeUndefinedValues: true }));
  assert.deepEqual(restored.deckSpec, partialDeck);
  assert.equal(isCatalogProductRecord(restored), true);

  fixture(t, [row]);
  const list = unpack(await handler(event("GET")));
  assert.equal(list.status, 200);
  assert.equal(list.body.products.length, 1);
  assert.deepEqual(list.body.products[0].deckSpec, partialDeck);
  const read = unpack(await handler(event("GET", undefined, "prd_deck")));
  assert.deepEqual(read.body.product.deckSpecsBySize["8.5"].nose, null);
  // A broken value still makes the row invalid, as before.
  assert.equal(
    isCatalogProductRecord(product({ deckSpec: { ...partialDeck, tail: 0 } })),
    false,
  );
});

test("a deckSpec PATCH saves blank fields as null and needs at least one number", async (t) => {
  const db = fixture(t, [product({ sizes: ["8.25", "8.5"] })]);
  const stored = () => db.records.get("prd_deck") as CatalogProductRecord;
  const patch = async (body: Record<string, unknown>) =>
    unpack(await handler(event("PATCH", body, "prd_deck")));

  const saved = await patch({ version: 3, deckSpec: partialDeck });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.product.deckSpec, partialDeck);
  assert.deepEqual(stored().deckSpec, partialDeck);

  const writes = db.transactions.length;
  for (const invalid of [
    { nose: null, tail: null, width: null, length: null, wheelbase: null },
    // Every field must still be present; a blank one is null, not missing.
    { nose: 6.875, tail: null, width: null, length: 31.75 },
    { ...partialDeck, tail: "null" },
    { ...partialDeck, tail: 0 },
  ]) {
    assert.equal((await patch({ version: 4, deckSpec: invalid })).status, 400);
    assert.equal(
      (await patch({ version: 4, size: "8.5", sizeDeckSpec: invalid })).status,
      400,
    );
  }
  assert.equal(db.transactions.length, writes);

  // One option with blank fields, then a rename that carries it.
  const option = { ...partialDeck, width: 8.5 };
  const optionSaved = await patch({ version: 4, size: "8.5", sizeDeckSpec: option });
  assert.equal(optionSaved.status, 200);
  assert.deepEqual(stored().deckSpecsBySize, { "8.5": option });
  const renamed = await patch({
    version: 5,
    size: "8.5",
    sizeName: "8.6",
    sizeDeckSpec: { ...option, tail: 6.5 },
  });
  assert.equal(renamed.status, 200);
  assert.deepEqual(stored().deckSpecsBySize, { "8.6": { ...option, tail: 6.5 } });
  // An unrelated edit keeps the blank fields, and deleting still uses null.
  assert.equal((await patch({ version: 6, featured: true })).status, 200);
  assert.deepEqual(stored().deckSpec, partialDeck);
  assert.equal((await patch({ version: 7, deckSpec: null })).status, 200);
  assert.equal(Object.hasOwn(stored(), "deckSpec"), false);
  // An older client's full spec still saves as before.
  assert.equal(
    (
      await patch({
        version: 8,
        deckSpec: {
          nose: 6.875,
          tail: 6.5,
          width: 8.5,
          length: 31.75,
          wheelbase: 14.25,
        },
      })
    ).status,
    200,
  );
});
