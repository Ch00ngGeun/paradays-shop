import { createHash } from "node:crypto";
import {
  GetCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { documentClient, getRequiredEnvironment } from "./dynamodb-client.js";
import { readProducts } from "./order-inventory-store.js";
import { stockInteger } from "./order-inventory-domain.js";
import { salesRequestDeadline, salesRequestSignal } from "./sales-request-deadline.js";
import {
  integer,
  record,
  SALE_METHODS,
  saleWarnings,
  SalesError,
  type DaySnapshot,
  type SaleEntry,
  type StockPreview,
} from "./sales-ledger-domain.js";

type Write = NonNullable<TransactWriteCommandInput["TransactItems"]>[number];

export type State = {
  businessDay: string;
  entryId: "~state";
  recordType: "SALES_DAY";
  version: number;
  status: "OPEN" | "CLOSED";
  snapshots: DaySnapshot[];
  history: { action: string; reason: string; at: string; by: string }[];
};

export type StoredEntry = SaleEntry & {
  fingerprint: string;
  createdBy: string;
  updatedBy: string;
  audit: unknown[];
  previewToken?: string;
};

export const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export const ledgerTable = () => getRequiredEnvironment("SALES_LEDGER_TABLE_NAME");

const catalogTable = () => getRequiredEnvironment("CATALOG_TABLE_NAME");

export const now = () => new Date().toISOString();

/** A stalled SDK cannot turn a bounded complete read into an eventual partial success. */
export async function readPage(
  command: QueryCommand | ScanCommand,
  deadline: number,
  code: string,
) {
  deadline = salesRequestDeadline(deadline);
  const requestSignal = salesRequestSignal();
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new SalesError(code, 503);
  const abort = new AbortController();
  const signal = requestSignal
    ? AbortSignal.any([requestSignal, abort.signal])
    : abort.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const expired = new Promise<never>((_, reject) => {
    onAbort = () => reject(new SalesError(code, 503));
    signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      abort.abort();
      reject(new SalesError(code, 503));
    }, remaining);
    timer.unref();
  });
  try {
    const operation =
      command instanceof QueryCommand
        ? documentClient.send(command, {
            abortSignal: signal,
          })
        : documentClient.send(command, {
            abortSignal: signal,
          });
    const response = await Promise.race([operation, expired]);
    if (Date.now() >= deadline) throw new SalesError(code, 503);
    return response;
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export async function get(day: string, entryId: string) {
  const abortSignal = salesRequestSignal();
  return (
    await documentClient.send(
      new GetCommand({
        TableName: ledgerTable(),
        Key: { businessDay: day, entryId },
        ConsistentRead: true,
      }),
      ...(abortSignal ? [{ abortSignal }] : []),
    )
  ).Item;
}

export async function state(day: string): Promise<State> {
  const item = await get(day, "~state");
  if (!item)
    return {
      businessDay: day,
      entryId: "~state",
      recordType: "SALES_DAY",
      version: 0,
      status: "OPEN",
      snapshots: [],
      history: [],
    };
  if (
    item.recordType !== "SALES_DAY" ||
    !integer(item.version, Number.MAX_SAFE_INTEGER - 1) ||
    !["OPEN", "CLOSED"].includes(item.status) ||
    !Array.isArray(item.snapshots) ||
    !Array.isArray(item.history)
  )
    throw new SalesError("SALES_DAY_INVALID", 503);
  return item as State;
}

export function publicEntry(e: StoredEntry): SaleEntry {
  return {
    businessDay: e.businessDay,
    entryId: e.entryId,
    recordType: "SALE",
    version: e.version,
    status: e.status,
    kind: e.kind,
    method: e.method,
    reference: e.reference,
    soldAt: e.soldAt,
    amount: e.amount,
    memo: e.memo,
    lines: e.lines.map(({ productId, name, option, quantity, unitAmount }) => ({
      productId,
      name,
      option,
      quantity,
      unitAmount,
    })),
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
    ...(e.original
      ? {
          original: {
            businessDay: e.original.businessDay,
            entryId: e.original.entryId,
          },
        }
      : {}),
    ...(typeof e.restocked === "boolean" ? { restocked: e.restocked } : {}),
  };
}

export async function entry(day: string, id: string): Promise<StoredEntry> {
  const e = await get(day, id);
  if (
    !e ||
    e.recordType !== "SALE" ||
    !integer(e.version, 100) ||
    !Array.isArray(e.lines) ||
    !Array.isArray(e.audit)
  )
    throw new SalesError("SALE_NOT_FOUND", 404);
  if (!(SALE_METHODS as readonly unknown[]).includes(e.method))
    throw new SalesError("SALE_RECORD_INVALID", 503);
  return e as StoredEntry;
}

export function stateWrite(before: State, next: State): Write {
  return {
    Put: {
      TableName: ledgerTable(),
      Item: next,
      ConditionExpression: before.version
        ? "#version = :version"
        : "attribute_not_exists(entryId)",
      ...(before.version
        ? {
            ExpressionAttributeNames: { "#version": "version" },
            ExpressionAttributeValues: { ":version": before.version },
          }
        : {}),
    },
  };
}

export function entryWrite(e: StoredEntry, previousVersion = 0): Write {
  return {
    Put: {
      TableName: ledgerTable(),
      Item: e,
      ConditionExpression: previousVersion
        ? "#version = :version AND #status = :draft"
        : "attribute_not_exists(entryId)",
      ...(previousVersion
        ? {
            ExpressionAttributeNames: { "#version": "version", "#status": "status" },
            ExpressionAttributeValues: {
              ":version": previousVersion,
              ":draft": "DRAFT",
            },
          }
        : {}),
    },
  };
}

export async function transact(writes: Write[]) {
  for (const write of writes)
    if (
      write.Put?.Item &&
      Buffer.byteLength(JSON.stringify(write.Put.Item), "utf8") > 300_000
    )
      throw new SalesError("SALES_RECORD_SIZE_LIMIT", 400);
  try {
    const abortSignal = salesRequestSignal();
    await documentClient.send(
      new TransactWriteCommand({ TransactItems: writes }),
      ...(abortSignal ? [{ abortSignal }] : []),
    );
  } catch (e) {
    if (
      record(e) &&
      ["TransactionCanceledException", "ConditionalCheckFailedException"].includes(
        String(e.name),
      )
    )
      throw new SalesError("SALES_CONCURRENT_OR_DUPLICATE");
    throw new SalesError("SALES_WRITE_UNCERTAIN", 503);
  }
}

export async function allEntries(day: string) {
  let cursor: Record<string, unknown> | undefined;
  const result: StoredEntry[] = [];
  const deadline = Date.now() + 8_000;
  for (let page = 0; page < 100; page++) {
    if (Date.now() > deadline) break;
    const response = await readPage(
      new QueryCommand({
        TableName: ledgerTable(),
        KeyConditionExpression: "businessDay = :day",
        ExpressionAttributeValues: { ":day": day },
        ConsistentRead: true,
        ExclusiveStartKey: cursor,
      }),
      deadline,
      "SALES_PAGINATION_INCOMPLETE",
    );
    for (const e of response.Items ?? [])
      if (e.recordType === "SALE") {
        if (
          !integer(e.amount) ||
          !Array.isArray(e.lines) ||
          !["DRAFT", "POSTED", "VOID"].includes(e.status) ||
          !(SALE_METHODS as readonly unknown[]).includes(e.method)
        )
          throw new SalesError("SALE_RECORD_INVALID", 503);
        result.push(e as StoredEntry);
      }
    cursor = response.LastEvaluatedKey;
    if (!cursor) return result;
  }
  throw new SalesError("SALES_PAGINATION_INCOMPLETE", 503);
}

export async function stockPreview(
  e: StoredEntry,
  direction: -1 | 1 = -1,
): Promise<StockPreview[]> {
  if (saleWarnings(e).length)
    throw new SalesError("SALE_PRODUCTS_OR_AMOUNT_UNCONFIRMED");
  const products = await readProducts(e.lines.map((l) => l.productId!));
  const quantities = new Map<string, number>();
  for (const l of e.lines) {
    const p = products.get(l.productId!)!;
    if (!p.sizes.includes(l.option)) throw new SalesError("SALE_OPTION_CHANGED");
    quantities.set(l.productId!, (quantities.get(l.productId!) ?? 0) + l.quantity);
  }
  return [...quantities]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, q]) => {
      const p = products.get(id)!,
        reserved = p.inventoryReserved ?? 0;
      const delta = direction * q,
        after = p.inventoryQuantity + delta;
      if (
        !stockInteger(after) ||
        after < reserved ||
        !stockInteger((p.inventoryCommitted ?? 0) - delta, Number.MAX_SAFE_INTEGER - 1)
      )
        throw new SalesError("SALE_STOCK_INSUFFICIENT_RECOUNT_REQUIRED");
      return {
        productId: id,
        name: p.name,
        quantity: p.inventoryQuantity,
        reserved,
        available: p.inventoryQuantity - reserved,
        delta,
        after,
        version: p.version,
      };
    });
}

export async function stockWrites(
  rows: readonly StockPreview[],
  timestamp: string,
): Promise<Write[]> {
  if (!rows.length) return [];
  const writes: Write[] = rows.map((r) => ({
    Update: {
      TableName: catalogTable(),
      Key: { productId: r.productId },
      ConditionExpression: "#version = :version AND inventoryQuantity = :before",
      UpdateExpression:
        "SET inventoryQuantity = :after, inventoryCommitted = if_not_exists(inventoryCommitted, :zero) + :committed, #version = :nextVersion, updatedAt = :at",
      ExpressionAttributeNames: { "#version": "version" },
      ExpressionAttributeValues: {
        ":version": r.version,
        ":before": r.quantity,
        ":after": r.after,
        ":committed": -r.delta,
        ":zero": 0,
        ":nextVersion": r.version + 1,
        ":at": timestamp,
      },
    },
  }));
  const abortSignal = salesRequestSignal();
  const { Item: revision } = await documentClient.send(
    new GetCommand({
      TableName: catalogTable(),
      Key: { productId: "~catalog_revision" },
      ConsistentRead: true,
    }),
    ...(abortSignal ? [{ abortSignal }] : []),
  );
  if (
    revision &&
    (revision.recordType !== "CATALOG_IDENTITY_REVISION" ||
      !stockInteger(revision.version, Number.MAX_SAFE_INTEGER - 1) ||
      revision.version < 1)
  )
    throw new SalesError("CATALOG_REVISION_INVALID", 503);
  const version = revision?.version ?? 0;
  writes.push({
    Put: {
      TableName: catalogTable(),
      Item: {
        productId: "~catalog_revision",
        recordType: "CATALOG_IDENTITY_REVISION",
        version: version + 1,
      },
      ConditionExpression: version
        ? "#version = :version"
        : "attribute_not_exists(productId)",
      ...(version
        ? {
            ExpressionAttributeNames: { "#version": "version" },
            ExpressionAttributeValues: { ":version": version },
          }
        : {}),
    },
  });
  return writes;
}
