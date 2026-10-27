/** Real handler with an atomic, conditional in-memory SDK transport. No credentials or network. */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { GetCommand, ScanCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyResultV2,
} from "aws-lambda";
import {
  handler,
  toPublicCatalogProduct,
  type CatalogProductRecord,
} from "../lambda/admin-catalog-handler.js";
import { documentClient } from "../lambda/dynamodb-client.js";

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
