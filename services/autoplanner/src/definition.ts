import type pg from "pg";
import type { ServiceDefinition } from "@nmk/shared";
import { plan, workDays, type Inputs } from "./algorithm.js";

const TZ = "Europe/Moscow";
export const mskDate = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d);
export const mskTime = (d = new Date()) => new Intl.DateTimeFormat("ru-RU", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
const addDays = (d: string, n: number) => new Date(new Date(d + "T12:00:00Z").getTime() + n * 86_400_000).toISOString().slice(0, 10);

export type Trigger = "daily" | "event" | "manual";

/**
 * Собирает план на целевые дни: по умолчанию послезавтра (planFromDays = 2, horizonDays = 1).
 * Уже стоящие в машинах заказы не трогает, добавляет только готовые без даты.
 * Клиентам этих заказов сразу уходит просьба подтвердить дату; менеджер утром проверяет план
 * и прозванивает тех, кто не ответил или попросил позвонить.
 */
export async function runAutoplan(db: pg.Pool, opts: { today?: string; trigger?: Trigger } = {}) {
  const enabled = (await db.query(`select core.module_enabled('autoplanner') as e`)).rows[0].e;
  if (!enabled) return null;
  const today = opts.today ?? mskDate();
  const cfg = (await db.query(`select value from core.settings where key = 'autoplan'`)).rows[0]?.value ?? {};
  const from = addDays(today, Number(cfg.planFromDays ?? 2));
  const { rows: [{ id: runId }] } = await db.query(`insert into autoplan.runs (trigger) values ($1) returning id`, [opts.trigger ?? "manual"]);
  try {
    const inp: Inputs = (await db.query(`select autoplan.inputs($1::date, 10) as i`, [from])).rows[0].i;
    const target = workDays(from, inp);
    const p = plan(inp, from);
    const slotIds = new Map<string, string>();
    for (const a of p.assignments) {
      const key = `${a.day}|${a.vehicleId}`;
      let slot = a.slotId ?? slotIds.get(key);
      if (!slot) slot = (await db.query(`select planning.ensure_slot($1, $2, $3) as id`, [a.day, a.directionId, a.vehicleId])).rows[0].id as string;
      slotIds.set(key, slot);
      await db.query(`select planning.assign($1, $2)`, [a.orderId, slot]);
    }
    for (const s of p.sequences) {
      const slot = slotIds.get(`${s.day}|${s.vehicleId}`) ?? (await db.query(`select id from planning.api_slots where day = $1 and vehicle_id = $2`, [s.day, s.vehicleId])).rows[0]?.id;
      if (slot) await db.query(`select planning.set_sequence($1, $2::uuid[])`, [slot, s.orderIds]);
    }
    const lead = Number(cfg.confirmLeadDays ?? 5);
    const due = (await db.query(`select autoplan.due_for_confirmation($1) as ids`, [lead])).rows[0].ids;
    if (due.length) await db.query(`select planning.request_confirmation($1::uuid[])`, [due]);
    await db.query(`update autoplan.runs set finished_at = now(), planned = $2, skipped = $3::jsonb, target_days = $4::date[] where id = $1`,
      [runId, p.assignments.length, JSON.stringify(p.skipped), target]);
    return { ...p, targetDays: target };
  } catch (e) {
    await db.query(`update autoplan.runs set finished_at = now(), error = $2 where id = $1`, [runId, (e as Error).message]);
    throw e;
  }
}

/** Пора ли ежедневный запуск: время МСК не раньше runAt, и сегодня ежедневного запуска ещё не было. */
export async function dailyDue(db: pg.Pool, now = new Date()) {
  const cfg = (await db.query(`select value from core.settings where key = 'autoplan'`)).rows[0]?.value ?? {};
  if (mskTime(now) < String(cfg.runAt ?? "16:30")) return false;
  const { rows } = await db.query(
    `select 1 from autoplan.runs where trigger = 'daily' and error is null and (started_at at time zone '${TZ}')::date = $1::date limit 1`, [mskDate(now)]);
  return rows.length === 0;
}

export const autoplanner: ServiceDefinition = {
  name: "autoplanner",
  module: {
    key: "autoplanner", title: "Автоплан", version: "0.2.0", dependsOn: ["planning", "messaging"],
    description: "Каждый день собирает машины на послезавтра с учётом погоды и сроков и просит клиентов подтвердить дату. Менеджер утром проверяет",
    roles: ["admin", "manager", "production_head", "production_deputy"], menu: [],
  },
  subscriptions: {
    // отказ клиента или новый готовый заказ — дособрать план на целевой день
    "installation.cancelled": async (_e, { db }) => { await runAutoplan(db, { trigger: "event" }); },
    "order.ready_for_install": async (_e, { db }) => { await runAutoplan(db, { trigger: "event" }); },
    // кнопка «Собрать план сейчас»
    "autoplan.requested": async (_e, { db }) => { await runAutoplan(db, { trigger: "manual" }); },
  },
  tasks: [{
    name: "daily", everyMs: 5 * 60_000, runOnStart: true,
    run: async ({ db }) => { if (await dailyDue(db)) await runAutoplan(db, { trigger: "daily" }); },
  }],
};
