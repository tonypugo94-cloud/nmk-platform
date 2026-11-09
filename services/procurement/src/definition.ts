import type { ServiceDefinition } from "@nmk/shared";

const recalc = async ({ db }: { db: import("pg").Pool }) => { await db.query(`select procurement.recalculate()`); };

export const procurement: ServiceDefinition = {
  name: "procurement",
  module: {
    key: "procurement", title: "Закупки", version: "0.1.0", dependsOn: ["orders"],
    description: "Расчёт потребности по заказам и остаткам, черновики заявок, утверждение начальником",
    roles: ["admin", "production_head", "production_deputy", "owner"],
    menu: [{ path: "/procurement", title: "Закупки" }],
  },
  subscriptions: {
    "accounting.stock_changed": (_e, ctx) => recalc(ctx),
    "order.stage_changed": (_e, ctx) => recalc(ctx),
    "order.upserted": (_e, ctx) => recalc(ctx),
  },
  tasks: [
    { name: "recalculate", everyMs: 30 * 60_000, runOnStart: true, run: recalc },
    { name: "late", everyMs: 3 * 3_600_000, runOnStart: true, run: async ({ db }) => { await db.query(`select procurement.detect_late()`); } },
  ],
};
