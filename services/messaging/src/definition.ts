/**
 * Логика общения с клиентами. Транспорт (MAX, VK) — в отдельных шлюзах: если один мессенджер
 * недоступен, второй и вся остальная система работают, а сообщения ждут в очереди.
 */
import type pg from "pg";
import { publish, type ServiceDefinition } from "@nmk/shared";

const ruDate = (d: string) => new Date(d + "T12:00:00").toLocaleDateString("ru-RU", { day: "numeric", month: "long", weekday: "short" });

async function settings(db: pg.Pool) {
  const { rows } = await db.query(`select value from core.settings where key = 'messaging'`);
  return rows[0].value as { reminderHour: number; undeliveredMinutes: number; noAnswerHours: number; viewingDays: number };
}

async function scheduleReminder(db: pg.Pool, orderId: string, day: string) {
  const { reminderHour } = await settings(db);
  const at = new Date(`${day}T00:00:00+03:00`);
  at.setDate(at.getDate() - 1);
  at.setHours(at.getHours() + reminderHour);
  await db.query(`select messaging.cancel_pending($1, 'reminder')`, [orderId]);
  await db.query(`select messaging.enqueue($1, 'reminder', $2::jsonb, $3)`, [orderId, JSON.stringify({ date: ruDate(day) }), at.toISOString()]);
}

async function plannedDay(db: pg.Pool, orderId: string): Promise<string | null> {
  const { rows } = await db.query(`select day::text from planning.order_assignment($1)`, [orderId]);
  return rows[0]?.day ?? null;
}

export async function handleInbound(db: pg.Pool, ev: { channel: string; chatId: string; kind: string; data: any }) {
  if (ev.kind === "start") {
    const code = String(ev.data?.code ?? "").trim().toLowerCase();
    const { rows: [lc] } = await db.query(`select order_id from messaging.link_codes where code = $1 and expires_at > now()`, [code]);
    if (!lc) return;
    const consent = "Клиент подключился по QR-коду из договора и согласился получать уведомления о заказе";
    const { rows: [sub] } = await db.query(
      `insert into messaging.subscriptions (order_id, channel, chat_id, consent_at, consent_text) values ($1, $2, $3, now(), $4)
       on conflict (order_id, channel, chat_id) do update set active = true returning id`, [lc.order_id, ev.channel, ev.chatId, consent]);
    await db.query(`update messaging.link_codes set used_at = coalesce(used_at, now()) where code = $1`, [code]);
    await db.query(`select messaging.enqueue($1, 'welcome', '{}'::jsonb, now(), null, $2)`, [lc.order_id, sub.id]);
    return;
  }
  if (ev.kind !== "button") return;
  const [action, orderId, extra] = String(ev.data?.payload ?? "").split(":");
  if (!orderId) return;
  // кнопку может нажать только подписчик этого заказа
  const { rowCount: ok } = await db.query(`select 1 from messaging.subscriptions where order_id = $1 and channel = $2 and chat_id = $3 and active`, [orderId, ev.channel, ev.chatId]);
  if (!ok) return;
  const key = `order:${orderId}`;
  switch (action) {
    case "confirm": {
      await publish(db, "confirmation.answered", key, { orderId, answer: "confirmed", channel: ev.channel });
      const day = await plannedDay(db, orderId);
      if (day) {
        await db.query(`select messaging.enqueue($1, 'confirmed', $2::jsonb)`, [orderId, JSON.stringify({ date: ruDate(day) })]);
        await scheduleReminder(db, orderId, day);
      }
      break;
    }
    case "other": {
      const { rows } = await db.query(`select day::text from planning.free_dates($1, current_date + 1, 3)`, [orderId]);
      const buttons = [...rows.map((r) => [{ text: ruDate(r.day), payload: `date:${orderId}:${r.day}` }]), [{ text: "Позвоните мне", payload: `call:${orderId}` }]];
      await db.query(`select messaging.enqueue($1, 'other_dates', '{}'::jsonb, now(), $2::jsonb)`, [orderId, JSON.stringify(buttons)]);
      break;
    }
    case "date": {
      await publish(db, "confirmation.answered", key, { orderId, answer: "other_date", date: extra, channel: ev.channel });
      await db.query(`select messaging.enqueue($1, 'confirmed', $2::jsonb)`, [orderId, JSON.stringify({ date: ruDate(extra!) })]);
      await scheduleReminder(db, orderId, extra!);
      break;
    }
    case "call": {
      await publish(db, "confirmation.answered", key, { orderId, answer: "call_me", channel: ev.channel });
      await publish(db, "callback.requested", key, { orderId, reason: "Клиент просит позвонить" });
      await db.query(`select messaging.enqueue($1, 'call_back')`, [orderId]);
      break;
    }
    case "viewing_ack": {
      const { rows: [m] } = await db.query(
        `select id from messaging.messages where order_id = $1 and template = 'viewing_invite' and chat_id = $2 order by created_at desc limit 1`, [orderId, ev.chatId]);
      if (m) await db.query(`select messaging.mark($1, 'read')`, [m.id]);
      break;
    }
  }
}

const stageTemplates: Record<string, string> = { in_production: "stage_in_production", ready: "stage_ready", installed: "installed" };

export const messaging: ServiceDefinition = {
  name: "messaging",
  module: {
    key: "messaging", title: "Клиенты", version: "0.1.0", dependsOn: ["orders", "planning"],
    description: "Боты MAX и VK: статусы, приглашение на просмотр с фиксацией, подтверждение даты, напоминания",
    roles: ["admin", "manager", "production_head", "production_deputy"],
    menu: [{ path: "/messaging", title: "Клиенты" }],
  },
  subscriptions: {
    "messaging.inbound": async (ev, { db }) => handleInbound(db, ev.payload),
    "order.stage_changed": async (ev, { db }) => {
      const t = stageTemplates[ev.payload.to];
      if (t) await db.query(`select messaging.enqueue($1, $2)`, [ev.payload.orderId, t]);
    },
    "confirmation.requested": async (ev, { db }) => {
      const n = (await db.query(`select messaging.enqueue($1, 'confirm_date', $2::jsonb) as n`,
        [ev.payload.orderId, JSON.stringify({ date: ruDate(ev.payload.date) })])).rows[0].n;
      if (!n) await publish(db, "callback.requested", ev.key, { orderId: ev.payload.orderId, reason: "Клиент не подключён к боту — подтвердите дату по телефону" });
    },
    "viewing.invite_requested": async (ev, { db }) => {
      const { viewingDays } = await settings(db);
      const until = ev.payload.until ?? new Date(Date.now() + viewingDays * 86_400_000).toISOString().slice(0, 10);
      const n = (await db.query(`select messaging.enqueue($1, 'viewing_invite', $2::jsonb) as n`, [ev.payload.orderId, JSON.stringify({ until: ruDate(until) })])).rows[0].n;
      if (!n) await publish(db, "callback.requested", ev.key, { orderId: ev.payload.orderId, reason: "Клиент не подключён к боту — пригласите на просмотр по телефону" });
    },
    "installation.rescheduled": async (ev, { db }) => { await db.query(`select messaging.cancel_pending($1, 'reminder')`, [ev.payload.orderId]); },
    "installation.cancelled": async (ev, { db }) => { await db.query(`select messaging.cancel_pending($1, 'reminder')`, [ev.payload.orderId]); },
  },
  tasks: [{
    name: "watchdog", everyMs: 5 * 60_000,
    run: async ({ db }) => {
      const s = await settings(db);
      // не доставлено вовремя (мессенджер лежит или клиент заблокировал бота) — позвонить
      const { rows: stuck } = await db.query(
        `update messaging.messages set alerted = true
          where not alerted and order_id is not null and template not in ('reminder')
            and ((status in ('queued','sending') and not_before < now() - make_interval(mins => $1)) or status = 'failed')
          returning order_id, template`, [s.undeliveredMinutes]);
      for (const m of stuck) await publish(db, "callback.requested", `order:${m.order_id}`, { orderId: m.order_id, reason: `Сообщение «${m.template}» не доставлено — позвоните клиенту` });
      // дату не подтвердили — позвонить
      const { rows: silent } = await db.query(
        `update messaging.messages m set alerted = true
          where not alerted and template = 'confirm_date' and status in ('sent','delivered','read') and sent_at < now() - make_interval(hours => $1)
            and exists (select 1 from planning.order_assignment(m.order_id) a where a.confirm_status = 'sent')
          returning order_id`, [s.noAnswerHours]);
      for (const m of silent) await publish(db, "callback.requested", `order:${m.order_id}`, { orderId: m.order_id, reason: "Клиент не ответил на подтверждение даты" });
    },
  }],
};
