/**
 * Синхронизация заказов и остатков из учётной системы. Только чтение.
 * Заказ, который не удалось применить, не останавливает остальные: ошибка пишется
 * в sync_state, и заказ будет повторён в следующий запуск.
 */
import type pg from "pg";
import { CircuitBreaker, publish, type Logger } from "@nmk/shared";
import type { AccountingAdapter } from "@nmk/accounting";

export type SyncOptions = { lookbackDays?: number; batchSize?: number };

export async function syncOrders(db: pg.Pool, adapter: AccountingAdapter, breaker: CircuitBreaker, log: Logger, opts: SyncOptions = {}) {
  const started = Date.now();
  const { rows: [run] } = await db.query(`insert into integration.runs (kind) values ('orders') returning id`);
  let changed = 0, unchanged = 0, failed = 0;
  try {
    const since = new Date(Date.now() - (opts.lookbackDays ?? 400) * 86_400_000);
    const versions = await breaker.call((signal) => adapter.listOrderVersions(since, signal));
    const { rows: known } = await db.query(`select ref, data_version from integration.sync_state`);
    const knownMap = new Map(known.map((r) => [r.ref as string, r.data_version as string | null]));
    const toFetch = versions.filter((v) => knownMap.get(v.ref) !== v.dataVersion);
    unchanged = versions.length - toFetch.length;

    for (const v of toFetch.slice(0, opts.batchSize ?? 200)) {
      try {
        const order = await breaker.call((signal) => adapter.getOrder(v.ref, signal));
        const client = await db.connect();
        try {
          await client.query("begin");
          await client.query(`select core.apply_accounting_order($1::jsonb)`, [JSON.stringify(order)]);
          await client.query(
            `insert into integration.sync_state (ref, data_version, synced_at, last_error, failed_at, attempts)
             values ($1, $2, now(), null, null, 0)
             on conflict (ref) do update set data_version = excluded.data_version, synced_at = now(), last_error = null, failed_at = null, attempts = 0`,
            [order.ref, order.dataVersion]);
          await client.query("commit");
          changed++;
        } catch (e) {
          await client.query("rollback");
          throw e;
        } finally {
          client.release();
        }
      } catch (e) {
        failed++;
        log.warn("order sync failed", { ref: v.ref, error: (e as Error).message });
        await db.query(
          `insert into integration.sync_state (ref, last_error, failed_at, attempts) values ($1, $2, now(), 1)
           on conflict (ref) do update set last_error = excluded.last_error, failed_at = now(), attempts = integration.sync_state.attempts + 1`,
          [v.ref, (e as Error).message]);
        if ((e as Error).name === "CircuitOpenError") break; // учётная система легла — не долбим её дальше
      }
    }

    await db.query(`update integration.runs set finished_at = now(), ok = $2, changed = $3, unchanged = $4, failed = $5 where id = $1`,
      [run.id, failed === 0, changed, unchanged, failed]);
    if (changed || failed) await publish(db, "accounting.sync_completed", null, { changed, unchanged, failed, durationMs: Date.now() - started });
    return { changed, unchanged, failed };
  } catch (e) {
    await db.query(`update integration.runs set finished_at = now(), ok = false, error = $2 where id = $1`, [run.id, (e as Error).message]);
    // Событие об отказе — только при переходе «работало → не работает», чтобы не спамить.
    const { rows } = await db.query(`select ok from integration.runs where kind='orders' and finished_at is not null and id < $1 order by id desc limit 1`, [run.id]);
    if (rows[0]?.ok !== false) await publish(db, "accounting.sync_failed", null, { error: (e as Error).message });
    throw e;
  }
}

export async function syncStock(db: pg.Pool, adapter: AccountingAdapter, breaker: CircuitBreaker) {
  const { rows: [run] } = await db.query(`insert into integration.runs (kind) values ('stock') returning id`);
  try {
    const stock = await breaker.call((signal) => adapter.listStock(signal));
    const client = await db.connect();
    try {
      await client.query("begin");
      await client.query(`delete from integration.stock`);
      for (const s of stock) {
        await client.query(
          `insert into integration.stock (item_ref, warehouse_ref, qty) values ($1, $2, $3)
           on conflict (item_ref, warehouse_ref) do update set qty = integration.stock.qty + excluded.qty`,
          [s.itemRef, s.warehouseRef ?? "", s.qty]);
      }
      await client.query(`update integration.runs set finished_at = now(), ok = true, changed = $2 where id = $1`, [run.id, stock.length]);
      await publish(client, "accounting.stock_changed", null, { items: stock.length });
      await client.query("commit");
    } catch (e) {
      await client.query("rollback");
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    await db.query(`update integration.runs set finished_at = now(), ok = false, error = $2 where id = $1`, [run.id, (e as Error).message]);
    throw e;
  }
}
