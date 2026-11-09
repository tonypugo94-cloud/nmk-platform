/**
 * Клиент шины событий (схема bus в PostgreSQL).
 * Публикация — внутри транзакции сервиса. Потребление — цикл claim → handler → ack/nack.
 */
import type pg from "pg";
import { eventSchema } from "./events.js";
import type { Logger } from "./logger.js";

export type Queryable = Pick<pg.Pool | pg.PoolClient | pg.Client, "query">;

export type BusEvent<P = unknown> = {
  deliveryId: number;
  attempts: number;
  eventId: number;
  type: string;
  key: string | null;
  payload: P;
  source: string;
  occurredAt: Date;
};

export type Handler = (event: BusEvent<any>, ctx: { db: pg.Pool; log: Logger }) => Promise<void>;

export async function publish(db: Queryable, type: string, key: string | null, payload: unknown, idempotencyKey?: string): Promise<number> {
  const schema = eventSchema(type);
  if (schema) schema.parse(payload);
  const { rows } = await db.query(`select bus.publish($1, $2, $3::jsonb, $4) as id`, [type, key, JSON.stringify(payload ?? {}), idempotencyKey ?? null]);
  return Number(rows[0].id);
}

export async function subscribe(db: Queryable, subscriber: string, patterns: string[]) {
  await db.query(`select bus.subscribe($1, $2)`, [subscriber, patterns]);
}

export async function claim(db: Queryable, subscriber: string, limit = 20, leaseSeconds = 60): Promise<BusEvent[]> {
  const { rows } = await db.query(`select * from bus.claim($1, $2, $3)`, [subscriber, limit, leaseSeconds]);
  return rows.map((r) => ({
    deliveryId: Number(r.delivery_id), attempts: r.attempts, eventId: Number(r.event_id), type: r.type,
    key: r.key, payload: r.payload, source: r.source, occurredAt: r.occurred_at,
  }));
}

export async function ack(db: Queryable, deliveryId: number) {
  await db.query(`select bus.ack($1)`, [deliveryId]);
}

export async function nack(db: Queryable, deliveryId: number, error: string, maxAttempts = 8): Promise<"pending" | "dead"> {
  const { rows } = await db.query(`select bus.nack($1, $2, $3) as status`, [deliveryId, error, maxAttempts]);
  return rows[0].status;
}

/** Совпадение типа события с шаблоном подписки: order.* , * , order.stage_changed */
export function matches(pattern: string, type: string): boolean {
  if (pattern === "*") return true;
  const re = new RegExp("^" + pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
  return re.test(type);
}

/**
 * Обрабатывает одну пачку доставок. Ошибка в обработчике одного события не мешает остальным:
 * это событие уходит на повтор с паузой, после maxAttempts — в dead.
 */
export async function processBatch(opts: {
  db: pg.Pool; subscriber: string; handlers: Record<string, Handler>; log: Logger; limit?: number; maxAttempts?: number;
}): Promise<number> {
  const events = await claim(opts.db, opts.subscriber, opts.limit ?? 20);
  for (const ev of events) {
    const entry = Object.entries(opts.handlers).find(([p]) => matches(p, ev.type));
    try {
      if (entry) {
        const schema = eventSchema(ev.type);
        if (schema) ev.payload = schema.parse(ev.payload);
        await entry[1](ev, { db: opts.db, log: opts.log });
      }
      await ack(opts.db, ev.deliveryId);
    } catch (e) {
      const status = await nack(opts.db, ev.deliveryId, (e as Error).stack ?? String(e), opts.maxAttempts ?? 8);
      opts.log[status === "dead" ? "error" : "warn"]("event handler failed", {
        type: ev.type, eventId: ev.eventId, attempts: ev.attempts, status, error: (e as Error).message,
      });
    }
  }
  return events.length;
}
