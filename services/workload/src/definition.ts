import type { ServiceDefinition } from "@nmk/shared";

/** Очереди считаются представлениями в БД и не зависят от сервиса; сервис только ищет риски по расписанию. */
export const workload: ServiceDefinition = {
  name: "workload",
  module: {
    key: "workload", title: "Участки", version: "0.1.0", dependsOn: ["orders", "tracking"],
    description: "Очереди участков по запасу дней, загрузка в часах, предупреждения о риске просрочки",
    roles: ["admin", "production_head", "production_deputy", "owner"],
    menu: [{ path: "/workload", title: "Участки" }],
  },
  tasks: [{ name: "risks", everyMs: 15 * 60_000, runOnStart: true, run: async ({ db }) => { await db.query(`select workload.detect_risks()`); } }],
};
