import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool, serviceRole, cleanData, urlFor } from "../../../tests/db.js";
import { OneCEmulator, OneCODataAdapter, defaultOneCConfig } from "@nmk/accounting";
import { CircuitBreaker, silentLogger } from "@nmk/shared";
import { syncOrders, syncStock } from "../src/sync.js";

const admin = pool();
let svc: ReturnType<typeof pool>;
let emu: OneCEmulator;
let adapter: OneCODataAdapter;
let breaker: CircuitBreaker;

beforeAll(async () => { await serviceRole(admin, "svc_accounting_sync"); svc = pool("svc_accounting_sync"); });
afterAll(async () => { await svc.end(); await admin.end(); });
beforeEach(async () => {
  await cleanData(admin);
  await admin.query(`truncate integration.sync_state, integration.runs, integration.stock`);
  await admin.query(`select bus.subscribe('postgres', array['*'])`);
  const { rows } = await admin.query(`insert into core.directions (name) values ('Кстово') returning id`);
  await admin.query(`insert into core.cemeteries (name, direction_id) values ('Новое Кстово', $1)`, [rows[0].id]);
  await emu?.close();
  emu = OneCEmulator.seeded();
  const url = await emu.listen();
  adapter = new OneCODataAdapter({ ...defaultOneCConfig, baseUrl: url, user: "obmen", password: "secret" });
  breaker = new CircuitBreaker("1c", { threshold: 2, cooldownMs: 60_000 });
});
afterAll(() => emu.close());

const types = async () => (await admin.query(`select type from bus.events order by id`)).rows.map((r) => r.type);

describe("адаптер 1С OData", () => {
  it("разбирает заказ: стадия, кладбище, участок, клиент с телефоном, состав с типами и весом", async () => {
    const [v] = await adapter.listOrderVersions(new Date("2020-01-01"));
    const o = await adapter.getOrder(v!.ref);
    expect(o).toMatchObject({ number: "НМК-004812", stage: "Готов", cemetery: "Новое Кстово", plot: "уч. 12, ряд 4",
      status: "open", dueDate: "2026-11-20", customer: { fullName: "Смирнова Елена Андреевна", phone: "+7 900 111-22-33" } });
    expect(o.items.map((i) => i.kind)).toEqual(["stela", "stand", "flowerbed", "service"]);
    expect(o.items[0]!.weightKg).toBe(110);
  });
});

describe("синхронизация заказов", () => {
  it("первый запуск загружает всё, второй ничего не трогает", async () => {
    expect(await syncOrders(svc, adapter, breaker, silentLogger)).toEqual({ changed: 3, unchanged: 0, failed: 0 });
    const { rows } = await admin.query(`select number, stage_code, direction from core.api_orders order by number`);
    expect(rows).toEqual([
      { number: "НМК-004790", stage_code: "in_production", direction: null },
      { number: "НМК-004812", stage_code: "ready", direction: "Кстово" },
      { number: "НМК-004835", stage_code: "accepted", direction: null },
    ]);
    expect(await syncOrders(svc, adapter, breaker, silentLogger)).toEqual({ changed: 0, unchanged: 3, failed: 0 });
  });

  it("менеджер сменил стадию в 1С → событие order.stage_changed", async () => {
    await syncOrders(svc, adapter, breaker, silentLogger);
    const ref = [...emu.orders.values()].find((o) => o.Number === "НМК-004790")!.Ref_Key;
    emu.update(ref, { stage: "Готов" });
    expect(await syncOrders(svc, adapter, breaker, silentLogger)).toMatchObject({ changed: 1 });
    expect(await types()).toContain("order.stage_changed");
    expect(await types()).toContain("order.ready_for_install");
  });

  it("сбой одного заказа не мешает остальным, он повторится в следующий раз", async () => {
    const orig = adapter.getOrder.bind(adapter);
    const badRef = [...emu.orders.keys()][1]!;
    adapter.getOrder = async (ref, s) => { if (ref === badRef) throw new Error("битые данные"); return orig(ref, s); };
    expect(await syncOrders(svc, adapter, breaker, silentLogger)).toMatchObject({ changed: 2, failed: 1 });
    const { rows: [st] } = await admin.query(`select failed_orders from integration.api_sync_status where kind='orders'`);
    expect(Number(st.failed_orders)).toBe(1);
    adapter.getOrder = orig;
    expect(await syncOrders(svc, adapter, breaker, silentLogger)).toMatchObject({ changed: 1, failed: 0 });
  });

  it("1С недоступна: данные остаются, одно событие об отказе, предохранитель перестаёт дёргать 1С", async () => {
    await syncOrders(svc, adapter, breaker, silentLogger);
    emu.failing = true;
    await expect(syncOrders(svc, adapter, breaker, silentLogger)).rejects.toThrow(/500/);
    await expect(syncOrders(svc, adapter, breaker, silentLogger)).rejects.toThrow(/500/);
    const before = emu.requests;
    await expect(syncOrders(svc, adapter, breaker, silentLogger)).rejects.toThrow(/open/);
    expect(emu.requests).toBe(before); // в 1С даже не ходили
    expect((await types()).filter((t) => t === "accounting.sync_failed")).toHaveLength(1);
    expect((await admin.query(`select count(*)::int n from core.orders`)).rows[0].n).toBe(3);
    const { rows: [st] } = await admin.query(`select last_ok, last_success_at from integration.api_sync_status where kind='orders'`);
    expect(st.last_ok).toBe(false);
    expect(st.last_success_at).not.toBeNull();
  });

  it("остатки", async () => {
    await syncOrders(svc, adapter, breaker, silentLogger);
    await syncStock(svc, adapter, breaker);
    const { rows } = await admin.query(`select name, qty::int from integration.api_stock order by name`);
    expect(rows.map((r) => r.qty)).toEqual([12, 9, 5]);
  });
});
