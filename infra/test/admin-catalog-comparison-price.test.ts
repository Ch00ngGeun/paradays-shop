/** Real remote-baseline handler; synthetic in-memory transport only, no network. */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import {
  handler,
  toPublicCatalogProduct,
  type CatalogProductRecord,
} from "../lambda/admin-catalog-handler.js";
import { documentClient } from "../lambda/dynamodb-client.js";

function product(): CatalogProductRecord {
  return {
    productId: "prd_test_deck",
    slug: "test-deck",
    name: "TEST Deck",
    brandId: "brand_test",
    brandName: "TEST Brand",
    category: "Deck",
    price: 80_000,
    compareAtPrice: 100_000,
    currency: "KRW",
    status: "PUBLISHED",
    publicationStatus: "PUBLISHED",
    inventoryQuantity: 10,
    featured: false,
    image: "/test-deck.webp",
    images: ["/test-deck.webp"],
    description: ["Synthetic comparison-price regression fixture"],
    sizes: ["8.25"],
    version: 3,
    createdAt: "2026-10-20T00:00:00.000Z",
    updatedAt: "2026-10-20T00:00:00.000Z",
    createdBy: "synthetic-admin",
    updatedBy: "synthetic-admin",
  };
}

function fixture(t: TestContext, race = false) {
  const previousTable = process.env.CATALOG_TABLE_NAME;
  process.env.CATALOG_TABLE_NAME = "synthetic-comparison-price-table";
  t.after(() => {
    if (previousTable === undefined) delete process.env.CATALOG_TABLE_NAME;
    else process.env.CATALOG_TABLE_NAME = previousTable;
  });
  let current = product();
  const writes: PutCommand["input"][] = [];
  t.mock.method(CognitoIdentityProviderClient.prototype, "send", async () => {
    throw new Error("Unexpected Cognito request; synthetic admin claim is explicit");
  });
  t.mock.method(documentClient, "send", async (command: unknown) => {
    if (command instanceof GetCommand) {
      assert.equal(command.input.TableName, "synthetic-comparison-price-table");
      assert.deepEqual(command.input.Key, { productId: "prd_test_deck" });
      return { Item: structuredClone(current) };
    }
    if (command instanceof PutCommand) {
      assert.equal(command.input.TableName, "synthetic-comparison-price-table");
      assert.equal(command.input.ConditionExpression, "#version = :expectedVersion");
      assert.deepEqual(command.input.ExpressionAttributeNames, {
        "#version": "version",
      });
      assert.equal(command.input.ExpressionAttributeValues?.[":expectedVersion"], 3);
      if (race)
        throw Object.assign(new Error("Synthetic conditional conflict"), {
          name: "ConditionalCheckFailedException",
        });
      writes.push(structuredClone(command.input));
      current = structuredClone(command.input.Item) as CatalogProductRecord;
      return {};
    }
    throw new Error("Unexpected SDK command; real transport is disabled");
  });
  return {
    get current() {
      return current;
    },
    writes,
  };
}

async function patch(body: Record<string, unknown>) {
  const event = {
    rawPath: "/admin/catalog/products/prd_test_deck",
    headers: {},
    isBase64Encoded: false,
    body: JSON.stringify(body),
    requestContext: {
      http: { method: "PATCH" },
      authorizer: {
        jwt: { claims: { sub: "synthetic-admin", "cognito:groups": "admin" } },
      },
    },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
  const response = await handler(event);
  assert.ok(typeof response === "object" && response !== null && "body" in response);
  assert.equal(typeof response.body, "string");
  return { status: response.statusCode, body: JSON.parse(response.body as string) };
}

for (const clearValue of [null, ""]) {
  test(`explicit ${JSON.stringify(clearValue)} removes persisted comparison price`, async (t) => {
    const db = fixture(t);
    const before = product();
    const result = await patch({
      version: 3,
      price: 120_000,
      compareAtPrice: clearValue,
    });
    assert.equal(result.status, 200);
    assert.equal(db.writes.length, 1);
    assert.equal(db.current.price, 120_000);
    assert.equal(db.current.version, 4);
    assert.equal(Object.hasOwn(db.current, "compareAtPrice"), false);
    assert.equal(Object.hasOwn(db.writes[0].Item!, "compareAtPrice"), false);
    assert.equal(Object.hasOwn(result.body.product, "compareAtPrice"), false);
    assert.equal(toPublicCatalogProduct(db.current)?.compareAtPrice, undefined);
    for (const key of [
      "inventoryQuantity",
      "status",
      "createdAt",
      "createdBy",
      "images",
      "sizes",
    ] as const)
      assert.deepEqual(db.current[key], before[key]);
  });
}

test("omission preserves existing comparison price", async (t) => {
  const db = fixture(t);
  const result = await patch({ version: 3, featured: true });
  assert.equal(result.status, 200);
  assert.equal(db.current.compareAtPrice, 100_000);
  assert.equal(result.body.product.compareAtPrice, 100_000);
  assert.equal(db.current.featured, true);
});

test("valid replacement wins over the stored comparison price", async (t) => {
  const db = fixture(t);
  const result = await patch({ version: 3, compareAtPrice: 140_000 });
  assert.equal(result.status, 200);
  assert.equal(db.current.compareAtPrice, 140_000);
  assert.equal(result.body.product.compareAtPrice, 140_000);
});

for (const invalidValue of [0, -1, 80_000, "invalid"]) {
  test(`invalid comparison price ${JSON.stringify(invalidValue)} cannot write`, async (t) => {
    const db = fixture(t);
    const result = await patch({ version: 3, compareAtPrice: invalidValue });
    assert.equal(result.status, 400);
    assert.equal(db.writes.length, 0);
    assert.deepEqual(db.current, product());
  });
}

test("stale request cannot remove the current comparison price", async (t) => {
  const db = fixture(t);
  const result = await patch({ version: 2, compareAtPrice: null });
  assert.equal(result.status, 409);
  assert.equal(db.writes.length, 0);
  assert.deepEqual(db.current, product());
});

test("conditional write conflict cannot remove the current comparison price", async (t) => {
  const db = fixture(t, true);
  const result = await patch({ version: 3, compareAtPrice: null });
  assert.equal(result.status, 409);
  assert.equal(db.writes.length, 0);
  assert.deepEqual(db.current, product());
});
