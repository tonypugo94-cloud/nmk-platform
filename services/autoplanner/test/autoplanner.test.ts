import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool, serviceRole, cleanData, urlFor, makeOrder } from "../../../tests/db.js";
import { badWeather, plan, workDays, type Inputs } from "../src/algorithm.js";
import { dailyDue, mskDate, runAutoplan } from "../src/definition.js";

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

  it("сегодня на послезавтра: один рабочий день, воскресенье и резервная пятница пропускаются", () => {
    const one = { ...base, settings: { ...base.settings, horizonDays: 1 } };
    expect(workDays("2026-05-13", one)).toEqual(["2026-05-13"]); // послезавтра — обычная среда
    expect(workDays("2026-05-15", one)).toEqual(["2026-05-16"]); // послезавтра пятница-резерв → суббота
    expect(workDays("2026-05-17", one)).toEqual(["2026-05-18"]); // воскресенье → понедельник
  });

  it("погода из МетеоПлана: сильный дождь и порог вероятности; снег — по настройке", () => {
    const s = { ...base.settings, rainSkipProb: 80, skipCategories: ["heavy_rain"], skipSnow: false };
    expect(badWeather({ directionId: "K", day: MON, precipProb: 99, category: "heavy_rain" }, s)).toBe("сильные осадки 99%");
    expect(badWeather({ directionId: "K", day: MON, precipProb: 65, category: "light_rain" }, s)).toBeNull();
    expect(badWeather({ directionId: "K", day: MON, precipProb: 85, category: "light_rain" }, s)).toBe("осадки 85%");
    expect(badWeather({ directionId: "K", day: MON, precipProb: 10, category: "clear", isSnow: true }, s)).toBeNull();
    expect(badWeather({ directionId: "K", day: MON, precipProb: 10, category: "clear", isSnow: true }, { ...s, skipSnow: true })).toBe("снег");
  });

  it("непогода на целевой день — заказ ждёт следующего запуска, причина видна менеджеру", () => {
    const p = plan({ ...base, settings: { ...base.settings, horizonDays: 1, rainSkipProb: 80, skipCategories: ["heavy_rain"] },
      orders: [o("a", "K", 300, "2026-05-20")], weather: [{ directionId: "K", day: MON, precipProb: 99, category: "heavy_rain" }] }, MON);
    expect(p.assignments).toHaveLength(0);
    expect(p.skipped[0]!.reason).toBe("Непогода — 2026-05-11: сильные осадки 99%");
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
    await admin.query(`truncate autoplan.runs`);
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
    const { rows: [slot] } = await admin.query(`select day::text from planning.api_slots`);
    expect(slot.day >= mskDate(new Date(Date.now() + 2 * 86_400_000))).toBe(true); // не раньше послезавтра
  });

  it("ежедневный запуск — один раз в день, не раньше времени из настроек", async () => {
    await admin.query(`update core.app_modules set enabled = true where key = 'autoplanner'`);
    await admin.query(`update core.settings set value = value || '{"runAt": "16:30"}' where key = 'autoplan'`);
    const at = (hhmm: string) => new Date(`${mskDate()}T${hhmm}:00+03:00`);
    expect(await dailyDue(svc, at("15:00"))).toBe(false);
    expect(await dailyDue(svc, at("16:45"))).toBe(true);
    await runAutoplan(svc, { trigger: "daily" });
    expect(await dailyDue(svc, at("17:00"))).toBe(false);
  });
});
