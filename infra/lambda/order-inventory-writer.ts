/** 역할: 주문 증빙·상품 버전·OCR 카탈로그 revision을 한 DynamoDB transaction으로 함께 commit하는 공용 writer임. */
import {
  GetCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { documentClient, getRequiredEnvironment } from "./dynamodb-client.js";
import {
  validFinancialEvents,
  type FinancialEvent,
  type OrderRecord,
} from "./order-record.js";
import { InventoryError, stockInteger } from "./order-inventory-domain.js";
import { verifiedCancellation, type TossPayment } from "./toss-payments.js";
import { type StockDelta, readOrder, readProducts } from "./order-inventory-store.js";

type Write = NonNullable<TransactWriteCommandInput["TransactItems"]>[number];

/** 주문 전체 CAS로 출고·환불 의도·모든 재고 작업을 직렬화함. */
export async function writeInventoryOrder(
  order: OrderRecord,
  next: OrderRecord,
  deltas: ReadonlyMap<string, StockDelta> = new Map(),
  financialProof?: TossPayment,
): Promise<OrderRecord> {
  const orderTable = getRequiredEnvironment("ORDER_TABLE_NAME");
  const catalogTable = getRequiredEnvironment("CATALOG_TABLE_NAME");
  const timestamp = new Date().toISOString();
  const paymentVersion = (order.paymentVersion ?? 0) + 1;
  const financialEvents: FinancialEvent[] = [...(order.financialEvents ?? [])];
  if (next.paidAt && !financialEvents.some((event) => event.kind === "APPROVAL")) {
    const validProviderTime =
      !!financialProof?.approvedAt &&
      Number.isFinite(Date.parse(financialProof.approvedAt)) &&
      Date.parse(financialProof.approvedAt) <= Date.parse(timestamp);
    financialEvents.push({
      eventId: `financial_${paymentVersion}_approval`,
      kind: "APPROVAL",
      amount: next.total,
      occurredAt: validProviderTime
        ? new Date(financialProof!.approvedAt!).toISOString()
        : Number.isFinite(Date.parse(next.paidAt)) &&
            Date.parse(next.paidAt) <= Date.parse(timestamp)
          ? new Date(next.paidAt).toISOString()
          : timestamp,
      recordedAt: timestamp,
      timeBasis: validProviderTime ? "PROVIDER" : "OBSERVED",
    });
  }
  const beforeRefund = Math.max(
    order.financialRefundedAmount ?? 0,
    order.inventory?.refundedAmount ?? 0,
  );
  const afterRefund = Math.max(
    next.financialRefundedAmount ?? 0,
    next.inventory?.refundedAmount ?? 0,
  );
  if (afterRefund < beforeRefund) throw new InventoryError("PAYMENT_STALE_STATE", 503);
  if (afterRefund > beforeRefund) {
    const known = new Set(
      [
        ...(order.financialEvents ?? []).map((e) => e.transactionKey),
        ...Object.values(order.inventory?.operations ?? {}).map(
          (e) => e.transactionKey,
        ),
      ].filter(Boolean),
    );
    const cancellations =
      financialProof?.cancels.filter((c) => !known.has(c.transactionKey)) ?? [];
    const delta = afterRefund - beforeRefund;
    const providerDated =
      !!financialProof &&
      verifiedCancellation(financialProof) &&
      cancellations.length > 0 &&
      cancellations.reduce((sum, c) => sum + c.cancelAmount, 0) === delta &&
      cancellations.every(
        (c) =>
          c.canceledAt &&
          Number.isFinite(Date.parse(c.canceledAt)) &&
          Date.parse(c.canceledAt) <= Date.parse(timestamp) &&
          (!next.paidAt || Date.parse(c.canceledAt) >= Date.parse(next.paidAt)),
      );
    if (providerDated)
      for (const [index, cancellation] of cancellations.entries())
        financialEvents.push({
          eventId: `financial_${paymentVersion}_refund_${index}`,
          kind: "REFUND",
          amount: cancellation.cancelAmount,
          occurredAt: new Date(cancellation.canceledAt!).toISOString(),
          recordedAt: timestamp,
          timeBasis: "PROVIDER",
          transactionKey: cancellation.transactionKey,
        });
    else
      financialEvents.push({
        eventId: `financial_${paymentVersion}_refund`,
        kind: "REFUND",
        amount: afterRefund - beforeRefund,
        occurredAt: timestamp,
        recordedAt: timestamp,
        timeBasis: "OBSERVED",
      });
  }
  if (!validFinancialEvents(financialEvents, next.total))
    throw new InventoryError("FINANCIAL_EVENTS_INVALID", 503);
  const item = {
    ...next,
    updatedAt: timestamp,
    paymentVersion,
    ...(financialEvents.length ? { financialEvents } : {}),
  };
  for (let attempt = 0; attempt < 4; attempt++) {
    const financialCondition =
      order.paymentVersion === undefined
        ? "attribute_not_exists(paymentVersion)"
        : "paymentVersion = :paymentVersion";
    const writes: Write[] = [
      {
        Put: {
          TableName: orderTable,
          Item: item,
          ConditionExpression: `${order.inventory ? "inventory.#version = :version AND requestFingerprint = :fingerprint" : "attribute_not_exists(inventory) AND #status = :status AND requestFingerprint = :fingerprint"} AND ${financialCondition}`,
          ExpressionAttributeNames: order.inventory
            ? { "#version": "version" }
            : { "#status": "status" },
          ExpressionAttributeValues: {
            ...(order.inventory
              ? {
                  ":version": order.inventory.version,
                  ":fingerprint": order.requestFingerprint,
                }
              : { ":status": order.status, ":fingerprint": order.requestFingerprint }),
            ...(order.paymentVersion === undefined
              ? {}
              : { ":paymentVersion": order.paymentVersion }),
          },
        },
      },
    ];
    if (deltas.size) {
      const products = await readProducts([...deltas.keys()]);
      for (const [id, delta] of deltas) {
        const p = products.get(id)!;
        const reserved = p.inventoryReserved ?? 0;
        if (
          delta.reserved > 0 &&
          order.lines
            .filter((line) => line.productId === id)
            .some(
              (line) =>
                p.status !== "PUBLISHED" ||
                p.price !== line.unitPrice ||
                !p.sizes.includes(line.selectedSize),
            )
        )
          throw new InventoryError("CHECKOUT_CATALOG_CHANGED");
        const quantity = p.inventoryQuantity + delta.quantity;
        const nextReserved = reserved + delta.reserved;
        const committed = (p.inventoryCommitted ?? 0) - delta.quantity;
        if (
          !stockInteger(quantity) ||
          !stockInteger(nextReserved, quantity) ||
          !stockInteger(committed, Number.MAX_SAFE_INTEGER - 1)
        )
          throw new InventoryError("INVENTORY_INSUFFICIENT_OR_CONFLICT");
        writes.push({
          Update: {
            TableName: catalogTable,
            Key: { productId: id },
            ConditionExpression: "#version = :version",
            UpdateExpression:
              "SET inventoryQuantity = :quantity, inventoryReserved = :reserved, inventoryCommitted = :committed, #version = :nextVersion, updatedAt = :updatedAt",
            ExpressionAttributeNames: { "#version": "version" },
            ExpressionAttributeValues: {
              ":version": p.version,
              ":quantity": quantity,
              ":reserved": nextReserved,
              ":committed": committed,
              ":nextVersion": p.version + 1,
              ":updatedAt": timestamp,
            },
          },
        });
      }
      const { Item: revision } = await documentClient.send(
        new GetCommand({
          TableName: catalogTable,
          Key: { productId: "~catalog_revision" },
          ConsistentRead: true,
        }),
      );
      if (
        revision &&
        (revision.recordType !== "CATALOG_IDENTITY_REVISION" ||
          !stockInteger(revision.version, Number.MAX_SAFE_INTEGER - 1) ||
          revision.version < 1)
      )
        throw new InventoryError("CATALOG_REVISION_INVALID", 503);
      const version = (revision?.version as number | undefined) ?? 0;
      writes.push({
        Put: {
          TableName: catalogTable,
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
    }
    try {
      await documentClient.send(new TransactWriteCommand({ TransactItems: writes }));
      return item;
    } catch (error) {
      const current = await readOrder(order.orderId);
      if (
        current &&
        current.paymentVersion === item.paymentVersion &&
        current.status === item.status &&
        current.paymentStatus === item.paymentStatus &&
        current.providerPaymentKey === item.providerPaymentKey &&
        current.financialRefundedAmount === item.financialRefundedAmount &&
        JSON.stringify(current.financialEvents) ===
          JSON.stringify(item.financialEvents) &&
        JSON.stringify(current.inventory) === JSON.stringify(item.inventory)
      )
        return current;
      if (
        current?.paymentVersion !== order.paymentVersion ||
        current?.inventory?.version !== order.inventory?.version ||
        current?.status !== order.status
      )
        throw new InventoryError("ORDER_OPERATION_CONFLICT");
      if (
        !(
          error &&
          typeof error === "object" &&
          "name" in error &&
          error.name === "TransactionCanceledException"
        )
      )
        throw new InventoryError("INVENTORY_STORAGE_UNAVAILABLE", 503);
    }
  }
  throw new InventoryError("INVENTORY_CONCURRENT_CHANGE");
}
