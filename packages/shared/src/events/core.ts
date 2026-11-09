import { z } from "zod";
import { defineEvent, uuid } from "./registry.js";

export const CoreEvents = {
  orderUpserted: defineEvent("order.upserted", z.object({ orderId: uuid, number: z.string(), created: z.boolean(), source: z.string() })),
  orderStageChanged: defineEvent("order.stage_changed", z.object({
    orderId: uuid, from: z.string().nullable(), to: z.string(), source: z.string(),
    comment: z.string().nullish(), by: z.string().nullish(),
  })),
  orderReadyForInstall: defineEvent("order.ready_for_install", z.object({ orderId: uuid })),
  orderClosed: defineEvent("order.closed", z.object({ orderId: uuid })),
  orderCemeteryUnmatched: defineEvent("order.cemetery_unmatched", z.object({ orderId: uuid, cemetery: z.string() })),
  customerAnonymized: defineEvent("customer.anonymized", z.object({ count: z.number() })),
  accountingSyncCompleted: defineEvent("accounting.sync_completed", z.object({
    changed: z.number(), unchanged: z.number(), failed: z.number(), durationMs: z.number(),
  })),
  accountingSyncFailed: defineEvent("accounting.sync_failed", z.object({ error: z.string() })),
  accountingStockChanged: defineEvent("accounting.stock_changed", z.object({ items: z.number() })),
} as const;
