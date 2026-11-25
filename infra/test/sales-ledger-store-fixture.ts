import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import {
  GetCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { documentClient } from "../lambda/dynamodb-client.js";
import { operateSalesDay } from "../lambda/sales-ledger-store.js";
import type {
  SalesCommand,
  SaleEntry,
  StockPreview,
} from "../lambda/sales-ledger-domain.js";
export const day = "2026-10-15";
export const save = (
  id = "sale_001",
  reference = "APP-001",
): Extract<SalesCommand, { action: "save" }> => ({
  action: "save",
  entryId: id,
  expectedVersion: 0,
  soldAt: "2026-10-15T01:00:00.000Z",
  method: "CARD",
  reference,
  amount: 200,
  memo: "",
  lines: [
    { productId: "prd_deck", name: "Deck", option: "8", quantity: 2, unitAmount: 100 },
  ],
});
export function fixture(t: TestContext) {
  const ledger = new Map<string, Record<string, unknown>>();
  const products = new Map<string, Record<string, unknown>>([
    [
      "prd_deck",
      {
        productId: "prd_deck",
        name: "Deck",
        price: 100,
        sizes: ["8"],
        status: "PUBLISHED",
        currency: "KRW",
        inventoryQuantity: 10,
        inventoryReserved: 3,
        inventoryCommitted: 0,
        version: 1,
      },
    ],
  ]);
  let orders: Record<string, unknown>[] = [];
  let writes = 0;
  let lostReply = false;
  let race: (() => void) | undefined;
  const clone = <T>(value: T): T => structuredClone(value);
  const key = (d: string, id: string) => `${d}/${id}`;
  t.mock.method(documentClient, "send", async (c: unknown) => {
    if (c instanceof GetCommand)
      return {
        Item: clone(
          c.input.TableName === "fixture_catalog"
            ? products.get(c.input.Key!.productId)
            : ledger.get(key(c.input.Key!.businessDay, c.input.Key!.entryId)),
        ),
      };
    if (c instanceof QueryCommand)
      return {
        Items: clone(
          [...ledger.values()].filter(
            (e) => e.businessDay === c.input.ExpressionAttributeValues![":day"],
          ),
        ),
      };
    if (c instanceof ScanCommand) return { Items: clone(orders) };
    assert.ok(c instanceof TransactWriteCommand);
    if (race) {
      const callback = race;
      race = undefined;
      callback();
    }
    const items = c.input.TransactItems!;
    // Validate the entire batch before mutation, just as DynamoDB does.
    for (const w of items) {
      const op = w.Put ?? w.Update!;
      const item = w.Put?.Item ?? w.Update!.Key!;
      const existing =
        op.TableName === "fixture_catalog"
          ? products.get(item.productId)
          : ledger.get(key(item.businessDay, item.entryId));
      const v = op.ExpressionAttributeValues ?? {};
      let ok = true;
      if (op.ConditionExpression?.includes("attribute_not_exists"))
        ok =
          !existing ||
          ("saleId" in (existing ?? {}) && existing!.saleId === v[":sale"]);
      else if (op.ConditionExpression?.includes("#version"))
        ok =
          existing?.version === v[":version"] &&
          (!op.ConditionExpression.includes("#status") ||
            existing?.status === v[":draft"]);
      if (!ok)
        throw Object.assign(new Error("conditional"), {
          name: "TransactionCanceledException",
        });
    }
    for (const w of items)
      if (w.Put) {
        const item = clone(w.Put.Item!);
        if (w.Put.TableName === "fixture_catalog") products.set(item.productId, item);
        else ledger.set(key(item.businessDay, item.entryId), item);
      } else {
        const u = w.Update!,
          v = u.ExpressionAttributeValues!,
          p = products.get(u.Key!.productId)!;
        products.set(u.Key!.productId, {
          ...p,
          inventoryQuantity: v[":after"],
          inventoryCommitted:
            Number(p.inventoryCommitted ?? 0) + Number(v[":committed"]),
          version: v[":nextVersion"],
        });
      }
    writes++;
    if (lostReply) {
      lostReply = false;
      throw new Error("lost response after commit");
    }
    return {};
  });
  return {
    ledger,
    products,
    setOrders: (o: Record<string, unknown>[]) => {
      orders = o;
    },
    writes: () => writes,
    loseNextReply: () => {
      lostReply = true;
    },
    raceNextWrite: (callback: () => void) => {
      race = callback;
    },
  };
}
export async function post() {
  const p = (await operateSalesDay(
    day,
    { action: "preview", entryId: "sale_001", version: 1 },
    "admin",
  )) as { preview: StockPreview[]; previewToken: string };
  const command: SalesCommand = {
    action: "post",
    entryId: "sale_001",
    version: 1,
    previewToken: p.previewToken,
    confirmed: true,
  };
  const result = (await operateSalesDay(day, command, "admin")) as { entry: SaleEntry };
  return { result, command, preview: p.preview };
}
