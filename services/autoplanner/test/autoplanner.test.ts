import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool, serviceRole, cleanData, urlFor, makeOrder } from "../../../tests/db.js";
import { plan, workDays, type Inputs } from "../src/algorithm.js";
import { runAutoplan } from "../src/definition.js";

const base: Inputs = {
  settings: { horizonDays: 5, rainSkipProb: 70, base: { lat: 56.15, lon: 44.2 } },
  planning: { workDays: [1, 2, 3, 4, 5, 6], reserveDays: [5] },
  orders: [], slots: [], vehicles: [{ id: "gazel", capacityKg: 1500 }, { id: "gazon", capacityKg: 3000 }], weather: [], unordered: [],
};
const MON = "2026-05-11";
const o = (id: string, dir: string, w: number, due: string, lat = 56.2, lon = 44.2) => ({ id, number: id, directionId: dir, weightKg: w, dueDate: due, lat, lon });

describe("алгоритм автоплана", () => {
  it("рабочие дни без резервной пятницы", () => {
    expect(workDays(MON, base)).toEqual(["2026-05-11", "2026-05-12", "2026-05-13", "2026-05-14", "2026-05-16"]);
  });

  it("сначала ближайший срок; одно направление — в одну машину, пока хватает тоннажа", () => {
    const p = plan({ ...base, orders: [o("late", "K", 900, "2026-06-01"), o("urgent", "K", 500, "2026-05-12"), o("third", "K", 400, "2026-05-20")] }, MON);
    const byId = Object.fromEntries(p.assignments.map((a) => [a.orderId, a]));
    expect(byId.urgent!.day).toBe(MON);
    expect(byId.third!.day).toBe(MON);
    expect(byId.urgent!.vehicleId).toBe(byId.third!.vehicleId);
    expect(byId.late!.vehicleId).not.toBe(byId.urgent!.vehicleId); // 500+400+900 > 1500 у Газели
  });

  it("дождливый день направления пропускается; нет направления — в список «не спланировано»", () => {
    const p = plan({ ...base, orders: [o("a", "ARZ", 300, "2026-05-12")], weather: [{ directionId: "ARZ", day: MON, precipProb: 90 }],
      unordered: [{ id: "x", number: "X" }] }, MON);
    expect(p.assignments[0]!.day).toBe("2026-05-12");
    expect(p.skipped[0]!.reason).toMatch(/направление/);
  });

  it("порядок объезда — ближайший следующий от базы", () => {
    const p = plan({ ...base, orders: [o("far", "K", 100, "2026-05-12", 56.5, 44.2), o("near", "K", 100, "2026-05-13", 56.16, 44.2)] }, MON);
    expect(p.sequences[0]!.orderIds).toEqual(["near", "far"]);
  });
});

describe("автоплан в базе", () => {
  const admin = pool();
  let svc: ReturnType<typeof pool>;
  beforeAll(async () => { await serviceRole(admin, "svc_autoplanner"); svc = pool("svc_autoplanner"); });
  afterAll(async () => { await svc.end(); await admin.end(); });
  beforeEach(async () => {
    await cleanData(admin);
    await admin.query(`select core.register_module('{"key":"autoplanner","title":"Автоплан"}')`);
  });

  it("выключен — ничего не делает; включён — ставит машины и просит клиентов подтвердить ближайшие", async () => {
    const dir = (await admin.query(`insert into core.directions (name) values ('Кстово') returning id`)).rows[0].id;
    await admin.query(`insert into core.cemeteries (name, direction_id, lat, lon) values ('Новое Кстово', $1, 56.15, 44.2)`, [dir]);
    await admin.query(`insert into core.vehicles (kind, plate, capacity_kg) values ('Газель', 'А820ВС', 1500)`);
    await makeOrder(admin, { number: "A", stage: "Готов", cemetery: "Новое Кстово" });
    expect(await runAutoplan(svc)).toBeNull();
    await admin.query(`update core.app_modules set enabled = true where key = 'autoplanner'`);
    const p = await runAutoplan(svc);
    expect(p!.assignments).toHaveLength(1);
    const { rows: [a] } = await admin.query(`select confirm_status from planning.api_assignments`);
    expect(a.confirm_status).toBe("sent");
    expect((await admin.query(`select count(*)::int n from bus.events where type = 'confirmation.requested'`)).rows[0].n).toBe(1);
    expect((await runAutoplan(svc))!.assignments).toHaveLength(0); // повторный запуск ничего не дублирует
  });
});
