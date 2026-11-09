/**
 * Каталог событий. Каждый модуль описывает свои события здесь (или в своём пакете
 * через defineEvent) — так публикация и обработка проверяются одной Zod-схемой.
 */
import { z } from "zod";

const registry = new Map<string, z.ZodTypeAny>();

export function defineEvent<T extends z.ZodTypeAny>(type: string, schema: T) {
  if (!/^[a-z0-9_]+(\.[a-z0-9_]+)+$/.test(type)) throw new Error(`bad event type: ${type}`);
  registry.set(type, schema);
  return { type, schema } as const;
}

export function eventSchema(type: string): z.ZodTypeAny | undefined {
  return registry.get(type);
}

export const orderKey = (orderId: string) => `order:${orderId}`;

const uuid = z.string().uuid();

export const Events = {
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
