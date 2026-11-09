import { CircuitBreaker, type ServiceDefinition } from "@nmk/shared";
import type { AccountingWriter } from "@nmk/accounting";

/**
 * Возвращает в 1С стадии, которые родились у нас (скан участка, бригада, вручную).
 * Стадии из самой 1С обратно не пишем. Выключенный модуль просто пропускает события.
 * 1С недоступна — событие повторяется шиной с паузой, потом уходит в dead и видно администратору.
 */
export function writeback(writer: AccountingWriter): ServiceDefinition {
  const breaker = new CircuitBreaker("1c-write", { threshold: 3, cooldownMs: 60_000, timeoutMs: 20_000 });
  return {
    name: "accounting-writeback",
    module: {
      key: "accounting_writeback", title: "Запись в 1С", version: "0.1.0", dependsOn: ["orders"],
      description: "Возвращает в 1С стадии, отмеченные на производстве. Требует расширения конфигурации 1С", menu: [],
    },
    subscriptions: {
      "order.stage_changed": async (ev, { db }) => {
        if (ev.payload.source === "onec") return;
        if (!(await db.query(`select core.module_enabled('accounting_writeback') as e`)).rows[0].e) return;
        const { rows: [o] } = await db.query(
          `select o.onec_ref, s.title from core.orders o join core.stages s on s.code = $2 where o.id = $1`,
          [ev.payload.orderId, ev.payload.to]);
        if (!o?.onec_ref) return;
        await breaker.call((signal) => writer.setStage(o.onec_ref, o.title, signal));
      },
    },
  };
}
