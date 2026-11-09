import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool, serviceRole, cleanData, urlFor, makeOrder } from "../../../tests/db.js";
import { runService, silentLogger } from "@nmk/shared";
import { weeklyDigest } from "../src/definition.js";
import { messaging } from "../../messaging/src/definition.js";

const admin = pool();
let svc: ReturnType<typeof pool>;
beforeAll(async () => { await serviceRole(admin, "svc_analytics"); await serviceRole(admin, "svc_messaging"); svc = pool("svc_analytics"); });
afterAll(async () => { await svc.end(); await admin.end(); });
beforeEach(async () => { await cleanData(admin); await admin.query(`truncate analytics.digests`); });
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

describe("панель собственника", () => {
  it("риск неустойки в рублях: просрочка 5 дней по заказу 100 000 ₽ = 15 000 ₽", async () => {
    await makeOrder(admin, { number: "LATE", dueDate: day(-5), amount: 100000, stage: "Готов" });
    await makeOrder(admin, { number: "OK", dueDate: day(30), amount: 50000 });
    const { rows } = await admin.query(`select number, penalty_rub::int from analytics.api_risk`);
    expect(rows).toEqual([{ number: "LATE", penalty_rub: 15000 }]);
    const s = (await admin.query(`select analytics.summary() as s`)).rows[0].s;
    expect(s).toMatchObject({ riskOrders: 1, riskRub: 15000, readyWaiting: 1 });
  });

  it("сводка — раз в неделю, в понедельник с 8:00 МСК, уходит собственнику в MAX", async () => {
    await makeOrder(admin, { number: "LATE", dueDate: day(-2), amount: 100000 });
    await admin.query(`update core.settings set value = value || '{"ownerChats": [{"channel": "max", "chatId": "owner-1"}]}' where key = 'messaging'`);
    const m = await runService(messaging, { databaseUrl: urlFor("svc_messaging"), port: 0, autoLoop: false, logger: silentLogger });
    expect(await weeklyDigest(svc, new Date("2026-11-16T04:00:00Z"))).toBeNull();            // пн 07:00 МСК — рано
    const t = await weeklyDigest(svc, new Date("2026-11-16T06:00:00Z"));                      // пн 09:00 МСК
    expect(t).toMatch(/НМК · неделя 09\.11–15\.11/);
    expect(t).toMatch(/Под риском неустойки: 1/);
    expect(await weeklyDigest(svc, new Date("2026-11-16T07:00:00Z"))).toBeNull();            // второй раз — нет
    await m.tick(); await m.stop();
    expect((await admin.query(`select chat_id, template from messaging.messages`)).rows).toEqual([{ chat_id: "owner-1", template: "digest" }]);
  });
});
