import type pg from "pg";
import type { ServiceDefinition } from "@nmk/shared";
import { plan, type Inputs } from "./algorithm.js";

export async function runAutoplan(db: pg.Pool, today = new Date().toISOString().slice(0, 10)) {
  const enabled = (await db.query(`select core.module_enabled('autoplanner') as e`)).rows[0].e;
  if (!enabled) return null;
  const from = new Date(new Date(today).getTime() + 86_400_000).toISOString().slice(0, 10);
  const { rows: [{ id: runId }] } = await db.query(`insert into autoplan.runs default values returning id`);
  try {
    const inp: Inputs = (await db.query(`select autoplan.inputs($1::date, 10) as i`, [from])).rows[0].i;
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
    const lead = Number(((await db.query(`select value->>'confirmLeadDays' as v from core.settings where key='autoplan'`)).rows[0]?.v) ?? 5);
    const due = (await db.query(`select autoplan.due_for_confirmation($1) as ids`, [lead])).rows[0].ids;
    if (due.length) await db.query(`select planning.request_confirmation($1::uuid[])`, [due]);
    await db.query(`update autoplan.runs set finished_at = now(), planned = $2, skipped = $3::jsonb where id = $1`, [runId, p.assignments.length, JSON.stringify(p.skipped)]);
    return p;
  } catch (e) {
    await db.query(`update autoplan.runs set finished_at = now(), error = $2 where id = $1`, [runId, (e as Error).message]);
    throw e;
  }
}

export const autoplanner: ServiceDefinition = {
  name: "autoplanner",
  module: {
    key: "autoplanner", title: "Автоплан", version: "0.1.0", dependsOn: ["planning", "messaging"],
    description: "Сам собирает машины на ближайшие дни и отправляет клиентам даты на подтверждение. Менеджер утверждает",
    roles: ["admin", "manager", "production_head", "production_deputy"], menu: [],
  },
  // отказ клиента или новый готовый заказ — перепланировать
  subscriptions: {
    "installation.cancelled": async (_e, { db }) => { await runAutoplan(db); },
    "order.ready_for_install": async (_e, { db }) => { await runAutoplan(db); },
  },
  tasks: [{ name: "daily", everyMs: 60 * 60_000, runOnStart: true, run: async ({ db }) => { await runAutoplan(db); } }],
};
