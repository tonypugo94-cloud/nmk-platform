import pg from "pg";
export const DB_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres@localhost:54329/postgres?host=/tmp";
export const urlFor = (user: string) => DB_URL.replace("postgres@", `${user}@`);
export function pool(user = "postgres") { return new pg.Pool({ connectionString: urlFor(user), max: 3 }); }
/** Создаёт сервисную роль с входом (локально trust-аутентификация). */
export async function serviceRole(admin: pg.Pool, name: string) {
  await admin.query(`select core.ensure_service_role($1)`, [name]);
  await admin.query(`alter role ${name} login`);
}
/** Чистит прикладные данные между тестами, не трогая справочники-сиды. */
export async function cleanData(admin: pg.Pool) {
  await admin.query(`truncate bus.deliveries, bus.events, bus.subscriptions, core.order_events, core.order_items, core.orders, core.customers, core.catalog_items, core.cemeteries, core.directions cascade`);
}

/** Заказ через ту же функцию, что использует обмен с 1С. */
export async function makeOrder(admin: pg.Pool, over: Record<string, unknown> = {}) {
  const o = {
    ref: "ref-" + Math.random().toString(36).slice(2), number: "4812", date: "2026-11-01", dueDate: "2026-12-01", status: "open",
    dataVersion: "v1", stage: "Принят", customer: { ref: "c-" + Math.random().toString(36).slice(2), fullName: "Смирнова Е. А.", phone: "+79990000000" },
    items: [
      { itemRef: "i-stela", name: "Стела 100×50×8", kind: "stela", qty: 1, weightKg: 110, lengthMm: 1000, widthMm: 500, thicknessMm: 80 },
      { itemRef: "i-stand", name: "Подставка 60×20×15", kind: "stand", qty: 1, weightKg: 45, lengthMm: 600, widthMm: 200, thicknessMm: 150 },
      { itemRef: "i-flower", name: "Цветник 100×50", kind: "flowerbed", qty: 1, weightKg: 30 },
      { itemRef: "i-install", name: "Установка", kind: "service", qty: 1 },
    ],
    ...over,
  };
  const { rows } = await admin.query(`select core.apply_accounting_order($1::jsonb) as r`, [JSON.stringify(o)]);
  return rows[0].r.orderId as string;
}
