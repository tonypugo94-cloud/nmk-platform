import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool, serviceRole, cleanData, urlFor, makeOrder } from "../../../tests/db.js";
import { publish, runService, silentLogger, type RunningService } from "@nmk/shared";
import { gateway, MaxTransport, type Button, type Transport } from "@nmk/bots";
import { messaging } from "../src/definition.js";

const admin = pool();
class FakeTransport implements Transport {
  sent: { chatId: string; text: string; buttons: Button[][] }[] = [];
  down = false;
  constructor(readonly channel: "max" | "vk") {}
  async send(chatId: string, text: string, buttons: Button[][]) { if (this.down) throw new Error("API недоступен"); this.sent.push({ chatId, text, buttons }); return { externalId: String(this.sent.length) }; }
  parseWebhook(body: any) { return { updates: body.updates, authorized: true }; }
}

let msg: RunningService, max: RunningService, vk: RunningService, fmax: FakeTransport, fvk: FakeTransport, orderId: string, dir: string;
const opts = (u: string) => ({ databaseUrl: urlFor(u), port: 0, autoLoop: false, logger: silentLogger });
const tickAll = async () => { await msg.tick(); await max.tick(); await vk.tick(); await msg.tick(); await max.tick(); await vk.tick(); };
const hook = (svc: RunningService, updates: unknown[]) => fetch(`http://localhost:${svc.port}/webhook`, { method: "POST", body: JSON.stringify({ updates }) });
const day = (() => { const d = new Date(); d.setDate(d.getDate() + 10); return d.toISOString().slice(0, 10); })();

beforeAll(async () => { for (const r of ["svc_messaging", "svc_bot_max", "svc_bot_vk"]) await serviceRole(admin, r); });
afterAll(() => admin.end());
beforeEach(async () => {
  await cleanData(admin);
  dir = (await admin.query(`insert into core.directions (name) values ('Кстово') returning id`)).rows[0].id;
  await admin.query(`insert into core.cemeteries (name, direction_id) values ('Новое Кстово', $1)`, [dir]);
  const v = (await admin.query(`insert into core.vehicles (kind, plate, capacity_kg) values ('Газель', 'А820ВС', 1500) returning id`)).rows[0].id;
  orderId = await makeOrder(admin, { number: "4812", stage: "Готов", cemetery: "Новое Кстово" });
  const slot = (await admin.query(`select planning.ensure_slot($1, $2, $3) as id`, [day, dir, v])).rows[0].id;
  await admin.query(`select planning.assign($1, $2)`, [orderId, slot]);
  fmax = new FakeTransport("max"); fvk = new FakeTransport("vk");
  msg = await runService(messaging, opts("svc_messaging"));
  max = await runService(gateway(fmax), opts("svc_bot_max"));
  vk = await runService(gateway(fvk), opts("svc_bot_vk"));
});
const stopAll = () => Promise.all([msg.stop(), max.stop(), vk.stop()]);
const subscribe = async (svc: RunningService, chat: string) => {
  const code = (await admin.query(`select messaging.create_link_code($1) as c`, [orderId])).rows[0].c;
  await hook(svc, [{ chatId: chat, kind: "start", data: { code } }]);
};
const types = async () => (await admin.query(`select type from bus.events order by id`)).rows.map((r) => r.type);

describe("боты", () => {
  it("подключение по QR → приветствие; подтверждение даты кнопкой → ответ в планировщик, напоминание накануне", async () => {
    await subscribe(max, "chat-1");
    await tickAll();
    expect(fmax.sent[0]!.text).toMatch(/подключены к уведомлениям по заказу № 4812/);
    await admin.query(`select planning.request_confirmation($1::uuid[])`, [[orderId]]);
    await tickAll();
    const confirm = fmax.sent.at(-1)!;
    expect(confirm.text).toMatch(/запланирована на/);
    expect(confirm.buttons.flat().map((b) => b.payload)).toEqual([`confirm:${orderId}`, `other:${orderId}`, `call:${orderId}`]);
    await hook(max, [{ chatId: "chat-1", kind: "button", data: { payload: `confirm:${orderId}` } }]);
    await tickAll();
    expect(await types()).toContain("confirmation.answered");
    expect(fmax.sent.at(-1)!.text).toMatch(/Спасибо! Установка/);
    const { rows: [r] } = await admin.query(`select status, (not_before at time zone 'Europe/Moscow')::date::text as d from messaging.messages where template = 'reminder'`);
    expect(r.status).toBe("queued");
    expect(r.d).toBe(new Date(new Date(day).getTime() - 86_400_000).toISOString().slice(0, 10));
    await stopAll();
  });

  it("«Другая дата» — кнопки ближайших свободных дней и «Позвоните мне»", async () => {
    await subscribe(max, "chat-1");
    await admin.query(`select planning.request_confirmation($1::uuid[])`, [[orderId]]);
    await tickAll();
    await hook(max, [{ chatId: "chat-1", kind: "button", data: { payload: `other:${orderId}` } }]);
    await tickAll();
    const last = fmax.sent.at(-1)!;
    expect(last.text).toBe("Выберите удобную дату установки:");
    expect(last.buttons.at(-1)![0]!.payload).toBe(`call:${orderId}`);
    expect(last.buttons[0]![0]!.payload).toMatch(new RegExp(`^date:${orderId}:\\d{4}-\\d{2}-\\d{2}$`));
    await stopAll();
  });

  it("MAX лежит — VK работает, сообщения MAX ждут и уходят после восстановления", async () => {
    await subscribe(max, "chat-max"); await subscribe(vk, "chat-vk");
    fmax.down = true;
    await tickAll();
    expect(fvk.sent).toHaveLength(1);
    expect(fmax.sent).toHaveLength(0);
    fmax.down = false;
    await admin.query(`update messaging.messages set not_before = now() where status = 'queued'`);
    await tickAll();
    expect(fmax.sent).toHaveLength(1);
    await stopAll();
  });

  it("чужой чат не может нажать кнопку чужого заказа; клиент без бота → «позвоните»", async () => {
    await admin.query(`select planning.request_confirmation($1::uuid[])`, [[orderId]]);
    await tickAll();
    expect(await types()).toContain("callback.requested");
    await hook(max, [{ chatId: "stranger", kind: "button", data: { payload: `confirm:${orderId}` } }]);
    await tickAll();
    expect(await types()).not.toContain("confirmation.answered");
    await stopAll();
  });

  it("приглашение на просмотр: доказательство с отметкой прочтения, текст неизменяем", async () => {
    await subscribe(max, "chat-1");
    await publish(admin, "viewing.invite_requested", `order:${orderId}`, { orderId });
    await tickAll();
    await hook(max, [{ chatId: "chat-1", kind: "button", data: { payload: `viewing_ack:${orderId}` } }]);
    await tickAll();
    const { rows: [e] } = await admin.query(`select status, sent_at, read_at, consent_at from messaging.api_evidence where template = 'viewing_invite'`);
    expect(e.status).toBe("read");
    expect(e.sent_at && e.read_at && e.consent_at).toBeTruthy();
    await expect(admin.query(`update messaging.messages set body = 'другое' where template = 'viewing_invite'`)).rejects.toThrow(/неизменяемо/);
    await stopAll();
  });
});

describe("транспорт MAX", () => {
  it("вебхук: deep-link, кнопка, проверка секрета", () => {
    const t = new MaxTransport({ token: "t", webhookSecret: "s" });
    expect(t.parseWebhook({ update_type: "bot_started", chat_id: 5, payload: "abc" }, { "x-max-bot-api-secret": "s" }).updates)
      .toEqual([{ chatId: "5", kind: "start", data: { code: "abc" } }]);
    expect(t.parseWebhook({ update_type: "message_callback", callback: { payload: "confirm:x", user: { user_id: 7 } }, message: { recipient: { chat_id: 9 } } }, { "x-max-bot-api-secret": "s" }).updates[0])
      .toMatchObject({ chatId: "9", kind: "button", data: { payload: "confirm:x" } });
    expect(t.parseWebhook({}, {}).authorized).toBe(false);
  });
});
