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
