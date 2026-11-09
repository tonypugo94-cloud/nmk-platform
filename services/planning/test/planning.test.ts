import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool, serviceRole, cleanData, urlFor, makeOrder } from "../../../tests/db.js";
import { publish, runService, silentLogger } from "@nmk/shared";
import { planning } from "../src/definition.js";

const admin = pool();
let dir: string, gazel: string, gazon: string;
beforeAll(async () => { await serviceRole(admin, "svc_planning"); });
afterAll(() => admin.end());
beforeEach(async () => {
  await cleanData(admin);
  dir = (await admin.query(`insert into core.directions (name) values ('Кстово') returning id`)).rows[0].id;
  await admin.query(`insert into core.cemeteries (name, direction_id) values ('Новое Кстово', $1)`, [dir]);
  gazel = (await admin.query(`insert into core.vehicles (kind, plate, capacity_kg) values ('Газель', 'А820ВС', 1500) returning id`)).rows[0].id;
  gazon = (await admin.query(`insert into core.vehicles (kind, plate, capacity_kg) values ('ГАЗон', 'В941ЕК', 3000) returning id`)).rows[0].id;
});

// ближайший понедельник через неделю+, чтобы не зависеть от сегодняшней даты
const monday = (() => { const d = new Date(); d.setDate(d.getDate() + 7 + ((8 - d.getDay()) % 7)); return d.toISOString().slice(0, 10); })();
const plus = (d: string, n: number) => new Date(new Date(d).getTime() + n * 86_400_000).toISOString().slice(0, 10);
const readyOrder = (n: string, extra: Record<string, unknown> = {}) => makeOrder(admin, { number: n, stage: "Готов", cemetery: "Новое Кстово", ...extra });
const slot = async (day: string, vehicle = gazel) => (await admin.query(`select planning.ensure_slot($1, $2, $3) as id`, [day, dir, vehicle])).rows[0].id;
const types = async () => (await admin.query(`select type from bus.events order by id`)).rows.map((r) => r.type);

describe("планировщик установок", () => {
  it("готовые без даты → в машину: загрузка по весу, перегруз, перенос на другой день", async () => {
    const a = await readyOrder("A");
    expect((await admin.query(`select count(*)::int n from planning.api_ready_unplanned`)).rows[0].n).toBe(1);
    const s1 = await slot(monday);
    const r = (await admin.query(`select planning.assign($1, $2) as r`, [a, s1])).rows[0].r;
    expect(r).toMatchObject({ loadKg: 185, capacityKg: 1500, overload: false });
    expect((await admin.query(`select count(*)::int n from planning.api_ready_unplanned`)).rows[0].n).toBe(0);
    const big = await readyOrder("BIG", { items: [{ itemRef: "heavy", name: "Комплекс", kind: "stela", qty: 1, weightKg: 1400 }] });
    expect((await admin.query(`select planning.assign($1, $2) as r`, [big, s1])).rows[0].r.overload).toBe(true);
    const s2 = await slot(plus(monday, 1));
    await admin.query(`select planning.assign($1, $2)`, [a, s2]);
    expect(await types()).toContain("installation.rescheduled");
  });

  it("«Другая дата»: сначала машины направления со свободным тоннажем, пятница-резерв в конце", async () => {
    const a = await readyOrder("A");
    const s1 = await slot(plus(monday, 2));
    const dates = (await admin.query(`select day::text, slot_id, reserve from planning.free_dates($1, $2, 6)`, [a, monday])).rows;
    expect(dates[0].reserve).toBe(false);
    expect(dates.find((d) => d.slot_id === s1)).toBeTruthy();
    expect(dates.at(-1)!.reserve || dates.every((d) => !d.reserve)).toBe(true);
  });

  it("подтверждение: запрос → ответы клиента применяются сервисом (перенос, отказ)", async () => {
    const a = await readyOrder("A"); const b = await readyOrder("B");
    const s1 = await slot(monday);
    await admin.query(`select planning.assign($1, $2)`, [a, s1]);
    await admin.query(`select planning.assign($1, $2)`, [b, s1]);
    expect((await admin.query(`select planning.request_confirmation($1::uuid[]) as n`, [[a, b]])).rows[0].n).toBe(2);
    const svc = await runService(planning, { databaseUrl: urlFor("svc_planning"), port: 0, autoLoop: false, logger: silentLogger });
    await publish(admin, "confirmation.answered", `order:${a}`, { orderId: a, answer: "other_date", date: plus(monday, 1), channel: "max" });
    await publish(admin, "confirmation.answered", `order:${b}`, { orderId: b, answer: "declined", channel: "vk" });
    await svc.tick(); await svc.stop();
    const { rows } = await admin.query(`select number, day::text, confirm_status from planning.api_assignments`);
    expect(rows).toEqual([{ number: "A", day: plus(monday, 1), confirm_status: "confirmed" }]);
    expect(await types()).toContain("installation.cancelled");
  });

  it("накладная на экипаж: адреса по порядку, состав без услуг, событие для погрузки", async () => {
    const a = await readyOrder("A");
    const s1 = await slot(monday, gazon);
    await admin.query(`select planning.assign($1, $2)`, [a, s1]);
    const w = (await admin.query(`select planning.print_waybill($1) as w`, [s1])).rows[0].w;
    expect(w.id).toMatch(/^W-\d{8}-941$/);
    expect(w.orders[0].items.map((i: any) => i.name)).toEqual(["Стела 100×50×8", "Подставка 60×20×15", "Цветник 100×50"]);
    const ev = (await admin.query(`select payload from bus.events where type = 'waybill.printed'`)).rows[0].payload;
    expect(ev.orderIds).toEqual([a]);
  });
});
