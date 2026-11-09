import type { ServiceDefinition } from "@nmk/shared";

/**
 * Само планирование (машины, перетаскивание, печать накладных) идёт из интерфейса прямо в функции БД.
 * Сервис обрабатывает асинхронное: ответы клиентов из бота, закрытие и установку заказов.
 * Если сервис лежит — ответы клиентов копятся в очереди и применятся после старта.
 */
export const planning: ServiceDefinition = {
  name: "planning",
  module: {
    key: "planning", title: "Установки", version: "0.1.0", dependsOn: ["orders"],
    description: "Календарь «направление × день», машины по тоннажу, резервная пятница, подтверждения, накладные на экипаж",
    roles: ["admin", "manager", "production_head", "production_deputy"],
    menu: [{ path: "/planning", title: "Установки" }],
  },
  subscriptions: {
    "confirmation.answered": async (ev, { db }) => {
      await db.query(`select planning.apply_confirmation($1, $2, $3::date)`, [ev.payload.orderId, ev.payload.answer, ev.payload.date ?? null]);
    },
    "order.closed": async (ev, { db }) => { await db.query(`select planning.unassign($1, 'Заказ закрыт')`, [ev.payload.orderId]); },
    "order.stage_changed": async (ev, { db }) => {
      if (ev.payload.to === "installed") await db.query(`select planning.mark_installed($1)`, [ev.payload.orderId]);
    },
  },
};
