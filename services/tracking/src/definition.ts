import type { ServiceDefinition } from "@nmk/shared";

/**
 * Сервис tracking только создаёт грузовые места и гасит бирки закрытых заказов.
 * Сами сканы идут с телефонов напрямую в tracking.record_scan() — участки работают,
 * даже если этот сервис остановлен.
 */
export const tracking: ServiceDefinition = {
  name: "tracking",
  module: {
    key: "tracking", title: "QR и участки", version: "0.1.0", dependsOn: ["orders"],
    description: "Грузовые места заказа (стела, паллет-комплект), QR-бирки, отметки участков «Взял / Готово»",
    roles: ["admin", "production_head", "production_deputy", "station", "storekeeper"],
    menu: [
      { path: "/tracking/labels", title: "Бирки", roles: ["admin", "production_head", "production_deputy", "storekeeper"] },
      { path: "/station", title: "Участок", roles: ["admin", "station", "storekeeper"] },
    ],
  },
  subscriptions: {
    "order.upserted": async (ev, { db }) => { await db.query(`select tracking.ensure_cargo_units($1)`, [ev.payload.orderId]); },
    "order.closed": async (ev, { db }) => { await db.query(`select tracking.deactivate_order($1)`, [ev.payload.orderId]); },
  },
};
