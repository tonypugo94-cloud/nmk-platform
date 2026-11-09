import { publish, type ServiceDefinition } from "@nmk/shared";

/** Отметки работ идут с телефонов прямо в БД. Сервис закрывает месяц: событие «ведомость готова». */
export const piecework: ServiceDefinition = {
  name: "piecework",
  module: {
    key: "piecework", title: "Сделка", version: "0.1.0", dependsOn: ["tracking"],
    description: "Справочник операций и ставок, отметки обработчиков по QR, расчёт погонных метров, ведомость за месяц",
    roles: ["admin", "production_head", "production_deputy", "owner", "station"],
    menu: [{ path: "/piecework", title: "Сделка", roles: ["admin", "production_head", "production_deputy", "owner"] }],
  },
  tasks: [{
    name: "month-close", everyMs: 6 * 3_600_000, runOnStart: true,
    run: async ({ db }) => {
      const { rows: [r] } = await db.query(
        `select to_char(date_trunc('month', now()) - interval '1 month', 'YYYY-MM') as month,
                coalesce(sum(amount), 0)::float as total, count(distinct user_id)::int as workers
           from piecework.records where voided_at is null
            and recorded_at >= date_trunc('month', now()) - interval '1 month' and recorded_at < date_trunc('month', now())`);
      if (r.workers) await publish(db, "piecework.statement_ready", null, { month: r.month, totalRub: r.total, workers: r.workers }, `piecework.statement:${r.month}`);
    },
  }],
};
