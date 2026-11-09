import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool, cleanData } from "./db.js";

const admin = pool();
afterAll(() => admin.end());
beforeEach(async () => {
  await cleanData(admin);
  await admin.query(`select bus.subscribe('postgres', array['*'])`);
  const { rows } = await admin.query(`insert into core.directions (name) values ('Кстово') returning id`);
  await admin.query(`insert into core.cemeteries (name, aliases, direction_id) values ('Новое кладбище', array['кладб. Новое'], $1)`, [rows[0].id]);
});

const order = (over: Record<string, unknown> = {}) => ({
  ref: "ref-1", number: "4812", date: "2026-11-01", dueDate: "2026-12-01", status: "open", amount: 100000,
  dataVersion: "v1", stage: "в производстве", cemetery: "кладб. Новое", plot: "уч. 12",
  customer: { ref: "c-1", fullName: "Смирнова Е. А.", phone: "+79990000000" },
  items: [
    { itemRef: "i-1", sku: "ПВ-1", name: "Стела 100×50×8", kind: "stela", qty: 1, weightKg: 110, lengthMm: 1000, widthMm: 500, thicknessMm: 80 },
    { itemRef: "i-2", name: "Цветник", kind: "flowerbed", qty: 2, weightKg: 30 },
  ],
  ...over,
});
const apply = async (o: unknown) => (await admin.query(`select core.apply_accounting_order($1::jsonb) as r`, [JSON.stringify(o)])).rows[0].r;
const events = async () => (await admin.query(`select type, payload from bus.events order by id`)).rows;

describe("заказы из учётной системы", () => {
  it("создаёт заказ, клиента, изделия, сопоставляет кладбище и направление", async () => {
    const r = await apply(order());
    expect(r.result).toBe("created");
    const { rows: [o] } = await admin.query(`select * from core.api_orders where id = $1`, [r.orderId]);
    expect(o.stage_code).toBe("in_production");
    expect(o.cemetery).toBe("Новое кладбище");
    expect(o.direction).toBe("Кстово");
    expect(Number(o.weight_kg)).toBe(170);
    expect((await events()).map((e) => e.type)).toEqual(["order.upserted"]);
  });

  it("та же версия данных — без изменений и без событий", async () => {
    await apply(order());
    expect((await apply(order())).result).toBe("unchanged");
    expect(await events()).toHaveLength(1);
  });

  it("смена стадии в 1С → stage_changed и ready_for_install; журнал заказа заполняется", async () => {
    const { orderId } = await apply(order());
    await apply(order({ dataVersion: "v2", stage: "Готов" }));
    const types = (await events()).map((e) => e.type);
    expect(types).toEqual(["order.upserted", "order.upserted", "order.stage_changed", "order.ready_for_install"]);
    const { rows } = await admin.query(`select type from core.order_events where order_id = $1 order by id`, [orderId]);
    expect(rows).toHaveLength(4);
  });

  it("ручная стадия не откатывается, если в 1С поменяли что-то другое", async () => {
    const { orderId } = await apply(order());
    await admin.query(`select core.set_order_stage($1, 'ready', 'manual', 'проверка')`, [orderId]);
    await apply(order({ dataVersion: "v2", plot: "уч. 13" })); // стадия в 1С та же
    const { rows: [o] } = await admin.query(`select stage_code, stage_source, plot from core.orders where id = $1`, [orderId]);
    expect(o).toMatchObject({ stage_code: "ready", stage_source: "manual", plot: "уч. 13" });
  });

  it("неизвестное кладбище — событие для ручного сопоставления", async () => {
    await apply(order({ cemetery: "Неизвестное" }));
    expect((await events()).map((e) => e.type)).toContain("order.cemetery_unmatched");
  });

  it("закрытие заказа и обезличивание клиента по сроку хранения", async () => {
    const { orderId } = await apply(order());
    await apply(order({ dataVersion: "v2", status: "closed" }));
    expect((await events()).map((e) => e.type)).toContain("order.closed");
    expect(await admin.query(`select core.anonymize_customers() as n`).then((r) => r.rows[0].n)).toBe(0);
    await admin.query(`update core.orders set closed_at = now() - interval '400 days' where id = $1`, [orderId]);
    expect(await admin.query(`select core.anonymize_customers() as n`).then((r) => r.rows[0].n)).toBe(1);
    const { rows: [c] } = await admin.query(`select full_name, phone from core.customers`);
    expect(c).toEqual({ full_name: "Обезличено", phone: null });
  });
});

describe("реестр модулей", () => {
  it("регистрация не включает модуль, повторная — не сбрасывает решение администратора", async () => {
    const m = { key: "demo", title: "Демо", menu: [{ path: "/demo", title: "Демо" }], roles: ["manager"] };
    await admin.query(`select core.register_module($1::jsonb)`, [JSON.stringify(m)]);
    expect((await admin.query(`select enabled from core.app_modules where key='demo'`)).rows[0].enabled).toBe(false);
    await admin.query(`update core.app_modules set enabled = true where key='demo'`);
    await admin.query(`select core.register_module($1::jsonb)`, [JSON.stringify({ ...m, version: "1.1.0" })]);
    const { rows: [r] } = await admin.query(`select enabled, version, alive from core.api_modules where key='demo'`);
    expect(r).toEqual({ enabled: true, version: "1.1.0", alive: true });
  });
});
