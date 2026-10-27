/** Dedicated ledger; stock, catalog revision, day CAS and sale proof commit atomically. */
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
import { validFinancialEvents } from "./order-record.js";
import { salesRequestDeadline, salesRequestSignal } from "./sales-request-deadline.js";
import {
  calculateTotals,
  integer,
  kstDay,
  record,
  SALE_METHODS,
  saleWarnings,
  sortEntries,
  SalesError,
  type DayReport,
  type DaySnapshot,
  type OnlineEvent,
  type SaleEntry,
  type SalesCommand,
  type StockPreview,
} from "./sales-ledger-domain.js";

type Write = NonNullable<TransactWriteCommandInput["TransactItems"]>[number];
type State = {
  businessDay: string;
  entryId: "~state";
  recordType: "SALES_DAY";
  version: number;
  status: "OPEN" | "CLOSED";
  snapshots: DaySnapshot[];
  history: { action: string; reason: string; at: string; by: string }[];
};
type StoredEntry = SaleEntry & {
  fingerprint: string;
  createdBy: string;
  updatedBy: string;
  audit: unknown[];
  previewToken?: string;
};
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const ledgerTable = () => getRequiredEnvironment("SALES_LEDGER_TABLE_NAME");
const catalogTable = () => getRequiredEnvironment("CATALOG_TABLE_NAME");
const now = () => new Date().toISOString();
/** A stalled SDK cannot turn a bounded complete read into an eventual partial success. */
async function readPage(
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
async function get(day: string, entryId: string) {
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
async function state(day: string): Promise<State> {
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
function publicEntry(e: StoredEntry): SaleEntry {
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
async function entry(day: string, id: string): Promise<StoredEntry> {
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
function stateWrite(before: State, next: State): Write {
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
function entryWrite(e: StoredEntry, previousVersion = 0): Write {
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
async function transact(writes: Write[]) {
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
async function allEntries(day: string) {
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
/** Completion is mandatory. Legacy refunds without dated evidence are never assigned to a guessed day. */
export async function readOnline(day: string) {
  const events: OnlineEvent[] = [],
    warnings = new Set<string>();
  let cursor: Record<string, unknown> | undefined;
  const asOf = now(),
    deadline = Date.now() + 8_000;
  for (let page = 0; page < 100; page++) {
    if (Date.now() > deadline) break;
    const response = await readPage(
      new ScanCommand({
        TableName: getRequiredEnvironment("ORDER_TABLE_NAME"),
        ConsistentRead: true,
        ProjectionExpression:
          "orderId, paidAt, refundedAt, financialEvents, financialRefundedAmount, inventory, #total, #status, paymentStatus",
        ExpressionAttributeNames: { "#total": "total", "#status": "status" },
        ExclusiveStartKey: cursor,
      }),
      deadline,
      "ONLINE_PAGINATION_INCOMPLETE",
    );
    for (const o of response.Items ?? []) {
      if (
        typeof o.orderId !== "string" ||
        !integer(o.total, Number.MAX_SAFE_INTEGER) ||
        o.total < 1
      )
        throw new SalesError("ONLINE_ORDER_INVALID", 503);
      if (Array.isArray(o.financialEvents)) {
        if (!validFinancialEvents(o.financialEvents, o.total))
          throw new SalesError("ONLINE_FINANCIAL_EVENT_INVALID", 503);
        for (const e of o.financialEvents) {
          if (
            !record(e) ||
            !["APPROVAL", "REFUND"].includes(String(e.kind)) ||
            !integer(e.amount, Number.MAX_SAFE_INTEGER) ||
            typeof e.occurredAt !== "string" ||
            !Number.isFinite(Date.parse(e.occurredAt)) ||
            typeof e.recordedAt !== "string" ||
            !Number.isFinite(Date.parse(e.recordedAt)) ||
            !["PROVIDER", "OBSERVED"].includes(String(e.timeBasis))
          )
            throw new SalesError("ONLINE_FINANCIAL_EVENT_INVALID", 503);
          if (
            kstDay(e.occurredAt) === day &&
            Date.parse(e.recordedAt) <= Date.parse(asOf)
          )
            events.push({
              orderId: o.orderId,
              kind: e.kind as OnlineEvent["kind"],
              amount: e.amount,
              occurredAt: e.occurredAt,
              timeBasis: e.timeBasis as OnlineEvent["timeBasis"],
            });
        }
        const approval = o.financialEvents.some(
          (e: { kind?: string }) => e.kind === "APPROVAL",
        );
        if (!approval && typeof o.paidAt === "string" && kstDay(o.paidAt) === day)
          events.push({
            orderId: o.orderId,
            kind: "APPROVAL",
            amount: o.total,
            occurredAt: o.paidAt,
            timeBasis: "OBSERVED",
          });
      } else if (typeof o.paidAt === "string") {
        if (!Number.isFinite(Date.parse(o.paidAt)))
          throw new SalesError("ONLINE_ORDER_TIME_INVALID", 503);
        if (kstDay(o.paidAt) === day)
          events.push({
            orderId: o.orderId,
            kind: "APPROVAL",
            amount: o.total,
            occurredAt: o.paidAt,
            timeBasis: "OBSERVED",
          });
      }
      const refunded = Math.max(
        o.financialRefundedAmount ?? 0,
        o.inventory?.refundedAmount ?? 0,
      );
      if (!integer(refunded, o.total))
        throw new SalesError("ONLINE_REFUND_INVALID", 503);
      const proven = (o.financialEvents ?? [])
        .filter((e: { kind: string }) => e.kind === "REFUND")
        .reduce((sum: number, e: { amount: number }) => sum + e.amount, 0);
      if (
        refunded > proven ||
        ((o.status === "REFUNDED" ||
          (o.status === "CANCELED" && typeof o.paidAt === "string")) &&
          !refunded &&
          !proven)
      )
        warnings.add("ONLINE_REFUND_HISTORY_UNAVAILABLE");
      if (
        refunded &&
        !o.paidAt &&
        !(o.financialEvents ?? []).some((e: { kind: string }) => e.kind === "APPROVAL")
      )
        warnings.add("ONLINE_APPROVAL_HISTORY_UNAVAILABLE");
      if (
        ["PAID", "REFUNDED"].includes(o.status) &&
        !o.paidAt &&
        !(o.financialEvents ?? []).some((e: { kind: string }) => e.kind === "APPROVAL")
      )
        warnings.add("ONLINE_APPROVAL_HISTORY_UNAVAILABLE");
      if (record(o.inventory) && o.inventory.pendingRefund)
        warnings.add("ONLINE_REFUND_RESULT_PENDING");
      if (
        record(o.inventory) &&
        o.inventory.state === "RESERVED" &&
        o.inventory.approvalAttemptedAt
      )
        warnings.add("ONLINE_PAYMENT_RESULT_PENDING");
      if (proven > refunded)
        throw new SalesError("ONLINE_REFUND_EVIDENCE_MISMATCH", 503);
    }
    cursor = response.LastEvaluatedKey;
    if (!cursor) {
      events.sort(
        (a, b) =>
          a.occurredAt.localeCompare(b.occurredAt) ||
          a.orderId.localeCompare(b.orderId) ||
          a.kind.localeCompare(b.kind),
      );
      return {
        events,
        warnings: [...warnings],
        asOf,
        fingerprint: digest([events, [...warnings].sort()]),
      };
    }
  }
  throw new SalesError("ONLINE_PAGINATION_INCOMPLETE", 503);
}
export async function readSalesDay(day: string): Promise<DayReport> {
  const before = await state(day);
  const [stored, online] = await Promise.all([allEntries(day), readOnline(day)]);
  const after = await state(day);
  if (before.version !== after.version)
    throw new SalesError("SALES_DAY_CHANGED_REFRESH");
  const entries = sortEntries(stored.map(publicEntry));
  const warnings = [...online.warnings];
  if (entries.some((e) => e.status === "DRAFT")) warnings.push("UNPOSTED_SALES");
  if (entries.some((e) => e.status === "DRAFT" && saleWarnings(e).length))
    warnings.push("UNMATCHED_OR_AMOUNT_MISMATCH");
  const last = after.snapshots.at(-1);
  if (
    after.status === "CLOSED" &&
    last &&
    last.onlineFingerprint !== online.fingerprint
  )
    warnings.push("ONLINE_CHANGED_AFTER_CLOSE");
  return {
    businessDay: day,
    timezone: "Asia/Seoul",
    version: after.version,
    status: after.status,
    asOf: online.asOf,
    entries,
    onlineEvents: online.events,
    totals: calculateTotals(entries, online.events),
    warnings,
    onlineFingerprint: online.fingerprint,
    snapshots: after.snapshots,
    history: after.history.map(({ action, reason, at }) => ({ action, reason, at })),
    complete: true,
  };
}
async function stockPreview(
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
async function stockWrites(
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
export async function operateSalesDay(
  day: string,
  command: SalesCommand,
  user: string,
): Promise<Record<string, unknown>> {
  const fingerprint = digest(command),
    timestamp = now();
  const s = await state(day);
  if (command.action === "close" || command.action === "reopen") {
    const receiptId = `~operation#${command.operationId}`,
      prior = await get(day, receiptId);
    if (prior) {
      if (prior.fingerprint !== fingerprint)
        throw new SalesError("SALE_OPERATION_REUSED");
      return { report: await readSalesDay(day) };
    }
    if (s.version !== command.expectedVersion)
      throw new SalesError("SALES_DAY_CHANGED_REFRESH");
    if (s.history.length >= 100) throw new SalesError("SALES_DAY_HISTORY_LIMIT");
    let next: State;
    if (command.action === "close") {
      if (s.status !== "OPEN" || day > kstDay(timestamp))
        throw new SalesError("SALES_DAY_NOT_OPEN");
      const report = await readSalesDay(day);
      if (
        report.version !== s.version ||
        report.onlineFingerprint !== command.onlineFingerprint
      )
        throw new SalesError("ONLINE_OR_SALES_CHANGED_REFRESH");
      if (report.warnings.length)
        throw new SalesError("SALES_CLOSE_RECONCILIATION_REQUIRED");
      if (report.totals.cash !== command.cashComparedAmount)
        throw new SalesError("CASH_SALES_COMPARISON_MISMATCH");
      const snapshot: DaySnapshot = {
        snapshotId: command.operationId,
        closedAt: now(),
        observedAt: report.asOf,
        version: s.version + 1,
        totals: report.totals,
        onlineFingerprint: report.onlineFingerprint,
        cashComparedAmount: command.cashComparedAmount,
        entryManifest: digest(report.entries),
        entryCount: report.entries.length,
        onlineEvents: report.onlineEvents,
      };
      next = {
        ...s,
        version: s.version + 1,
        status: "CLOSED",
        snapshots: [...s.snapshots, snapshot],
        history: [
          ...s.history,
          { action: "CLOSE", reason: "매출 대조 확인", at: timestamp, by: user },
        ],
      };
    } else {
      if (s.status !== "CLOSED") throw new SalesError("SALES_DAY_NOT_CLOSED");
      next = {
        ...s,
        version: s.version + 1,
        status: "OPEN",
        history: [
          ...s.history,
          { action: "REOPEN", reason: command.reason, at: timestamp, by: user },
        ],
      };
    }
    await transact([
      stateWrite(s, next),
      {
        Put: {
          TableName: ledgerTable(),
          Item: {
            businessDay: day,
            entryId: receiptId,
            recordType: "SALES_OPERATION",
            fingerprint,
            at: timestamp,
            by: user,
          },
          ConditionExpression: "attribute_not_exists(entryId)",
        },
      },
    ]);
    return { report: await readSalesDay(day) };
  }
  // Matching replay succeeds even after close, but can never add a second stock delta.
  const previous = (await get(day, command.entryId)) as StoredEntry | undefined;
  if (command.action === "save" && previous?.fingerprint === fingerprint)
    return { entry: publicEntry(previous) };
  if (
    command.action === "post" &&
    previous?.status === "POSTED" &&
    previous.previewToken === command.previewToken
  )
    return { entry: publicEntry(previous) };
  if (command.action === "reverse" && previous?.fingerprint === fingerprint)
    return { entry: publicEntry(previous) };
  if (
    command.action === "void" &&
    previous?.status === "VOID" &&
    previous.fingerprint === fingerprint
  )
    return { entry: publicEntry(previous) };
  if (s.status !== "OPEN") throw new SalesError("SALES_DAY_CLOSED");
  const nextState = { ...s, version: s.version + 1 };
  if (command.action === "save") {
    if (
      (previous?.version ?? 0) !== command.expectedVersion ||
      (previous && previous.status !== "DRAFT")
    )
      throw new SalesError("SALE_VERSION_OR_STATUS_CONFLICT");
    const input = {
      entryId: command.entryId,
      soldAt: command.soldAt,
      method: command.method,
      reference: command.reference,
      amount: command.amount,
      memo: command.memo,
      lines: command.lines,
    };
    const e: StoredEntry = {
      ...input,
      businessDay: day,
      recordType: "SALE",
      version: command.expectedVersion + 1,
      status: "DRAFT",
      kind: "SALE",
      createdAt: previous?.createdAt ?? timestamp,
      updatedAt: timestamp,
      createdBy: previous?.createdBy ?? user,
      updatedBy: user,
      fingerprint,
      audit: [
        ...(previous?.audit ?? []),
        { at: timestamp, by: user, action: "SAVE", input },
      ],
    };
    const claimId = `~reference#${digest([e.method, e.reference.toUpperCase()])}`;
    await transact([
      stateWrite(s, nextState),
      entryWrite(e, command.expectedVersion),
      {
        Put: {
          TableName: ledgerTable(),
          Item: {
            businessDay: day,
            entryId: claimId,
            recordType: "SALES_REFERENCE",
            saleId: e.entryId,
          },
          ConditionExpression: "attribute_not_exists(entryId) OR saleId = :sale",
          ExpressionAttributeValues: { ":sale": e.entryId },
        },
      },
    ]);
    return { entry: publicEntry(e) };
  }
  if (command.action === "reverse") {
    if (previous) throw new SalesError("SALE_OPERATION_REUSED");
    const original = await entry(command.originalDay, command.originalId);
    if (
      original.status !== "POSTED" ||
      original.kind !== "SALE" ||
      command.soldAt < original.soldAt
    )
      throw new SalesError("SALE_REVERSAL_INVALID");
    const e: StoredEntry = {
      ...original,
      businessDay: day,
      entryId: command.entryId,
      version: 1,
      kind: "REVERSAL",
      original: { businessDay: command.originalDay, entryId: command.originalId },
      restocked: command.restockInspected,
      soldAt: command.soldAt,
      memo: command.reason,
      createdAt: timestamp,
      updatedAt: timestamp,
      createdBy: user,
      updatedBy: user,
      fingerprint,
      audit: [{ action: "REVERSE", at: timestamp, by: user, reason: command.reason }],
    };
    const rows = command.restockInspected ? await stockPreview(e, 1) : [];
    const claimId = `~reversal#${original.entryId}`;
    await transact([
      stateWrite(s, nextState),
      entryWrite(e),
      {
        Put: {
          TableName: ledgerTable(),
          Item: {
            businessDay: original.businessDay,
            entryId: claimId,
            recordType: "SALES_REVERSAL",
            reversalDay: day,
            reversalId: e.entryId,
          },
          ConditionExpression: "attribute_not_exists(entryId)",
        },
      },
      ...(await stockWrites(rows, timestamp)),
    ]);
    return { entry: publicEntry(e) };
  }
  const e = await entry(day, command.entryId);
  if (e.status !== "DRAFT" || e.version !== command.version)
    throw new SalesError("SALE_VERSION_OR_STATUS_CONFLICT");
  if (command.action === "preview" || command.action === "post") {
    const rows = await stockPreview(e),
      previewToken = digest([day, e.entryId, e.version, rows]);
    if (command.action === "preview")
      return { preview: rows, previewToken, entryId: e.entryId, version: e.version };
    if (previewToken !== command.previewToken)
      throw new SalesError("SALE_STOCK_CHANGED_PREVIEW_AGAIN");
    const posted = {
      ...e,
      status: "POSTED" as const,
      version: e.version + 1,
      previewToken,
      updatedAt: timestamp,
      updatedBy: user,
      lines: e.lines.map((line) => ({
        ...line,
        name: rows.find((row) => row.productId === line.productId)!.name,
      })),
      audit: [...e.audit, { action: "POST", at: timestamp, by: user, rows }],
    };
    await transact([
      stateWrite(s, nextState),
      entryWrite(posted, e.version),
      ...(await stockWrites(rows, timestamp)),
    ]);
    return { entry: publicEntry(posted) };
  }
  const voided = {
    ...e,
    status: "VOID" as const,
    version: e.version + 1,
    updatedAt: timestamp,
    updatedBy: user,
    fingerprint,
    memo: command.reason,
    audit: [
      ...e.audit,
      { action: "VOID", reason: command.reason, at: timestamp, by: user },
    ],
  };
  await transact([stateWrite(s, nextState), entryWrite(voided, e.version)]);
  return { entry: publicEntry(voided) };
}
