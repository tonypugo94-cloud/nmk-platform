import { publish, type ServiceDefinition } from "@nmk/shared";

/** Витрины считаются представлениями в БД. Сервис только раз в неделю собирает сводку собственнику. */
export async function weeklyDigest(db: import("pg").Pool, now = new Date()) {
  const msk = new Date(now.getTime() + 3 * 3_600_000);
  const { rows: [cfg] } = await db.query(`select value from core.settings where key = 'analytics'`);
  const dow = msk.getUTCDay() === 0 ? 7 : msk.getUTCDay();
  if (dow !== cfg.value.digestWeekday || msk.getUTCHours() < cfg.value.digestHour) return null;
  const week = new Date(Date.UTC(msk.getUTCFullYear(), msk.getUTCMonth(), msk.getUTCDate() - 7 - (dow - 1))).toISOString().slice(0, 10);
  const { rows: [{ t }] } = await db.query(`select analytics.digest_text($1::date) as t`, [week]);
  const { rowCount } = await db.query(`insert into analytics.digests (week, text) values ($1, $2) on conflict do nothing`, [week, t]);
  if (!rowCount) return null;
  await publish(db, "analytics.digest_ready", null, { text: t, week }, `digest:${week}`);
  return t as string;
}

export const analytics: ServiceDefinition = {
  name: "analytics",
  module: {
    key: "analytics", title: "Сводка", version: "0.1.0", dependsOn: ["orders"],
    description: "Панель собственника: риски неустоек, план и факт, узкие места, склад, клиенты, сделка; сводка в MAX по понедельникам",
    roles: ["admin", "owner"], menu: [{ path: "/owner", title: "Сводка" }],
  },
  tasks: [{ name: "digest", everyMs: 10 * 60_000, runOnStart: true, run: async ({ db }) => { await weeklyDigest(db); } }],
};
