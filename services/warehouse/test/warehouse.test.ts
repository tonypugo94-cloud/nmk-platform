import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool, serviceRole, cleanData, urlFor, makeOrder } from "../../../tests/db.js";
import { publish, runService, silentLogger } from "@nmk/shared";
import { warehouse } from "../src/definition.js";

const admin = pool();
beforeAll(async () => { await serviceRole(admin, "svc_warehouse"); });
afterAll(() => admin.end());
beforeEach(async () => {
  await cleanData(admin);
  await admin.query(`truncate warehouse.loads, warehouse.placements, warehouse.places cascade`);
  await admin.query(`insert into warehouse.places (code, capacity) values ('75', 4), ('76', 2)`);
});
const tags = async (orderId: string) => (await admin.query(
  `select g.code from tracking.tags g join tracking.cargo_units u on u.id = g.cargo_unit_id where u.order_id = $1 order by u.seq`, [orderId])).rows.map((r) => r.code as string);

describe("склад и погрузка", () => {
  it("место и глубина: вторая поставленная стоит первой спереди", async () => {
    const a = await makeOrder(admin, { number: "A" }); const b = await makeOrder(admin, { number: "B" });
    for (const id of [a, b]) await admin.query(`select tracking.ensure_cargo_units($1)`, [id]);
    await admin.query(`select warehouse.place($1, '76')`, [(await tags(a))[0]]);
    const r = (await admin.query(`select warehouse.place($1, '76') as r`, [(await tags(b))[0]])).rows[0].r;
    expect(r).toMatchObject({ depth: 2, overCapacity: false });
    const pos = (await admin.query(`select number, position_from_front from warehouse.api_placements order by number`)).rows;
    expect(pos).toEqual([{ number: "A", position_from_front: "2" }, { number: "B", position_from_front: "1" }]);
  });

  it("накладная → погрузка; закрыть можно только когда всё отсканировано", async () => {
    const a = await makeOrder(admin, { number: "4812" });
    await admin.query(`select tracking.ensure_cargo_units($1)`, [a]);
    const svc = await runService(warehouse, { databaseUrl: urlFor("svc_warehouse"), port: 0, autoLoop: false, logger: silentLogger });
    await publish(admin, "waybill.printed", null, { waybillId: "W-1", date: "2026-11-20", vehicleId: null, orderIds: [a] });
    await svc.tick(); await svc.stop();
    const { rows: [{ id: load }] } = await admin.query(`select id from warehouse.loads where waybill_id = 'W-1'`);
    const [stela, kit] = await tags(a);
    await admin.query(`select warehouse.place($1, '75')`, [stela]);
    const s1 = (await admin.query(`select warehouse.scan_load($1, $2) as r`, [load, stela])).rows[0].r;
    expect(s1.text).toBe("Заказ 4812: 1 из 2");
    expect((await admin.query(`select count(*)::int n from warehouse.placements`)).rows[0].n).toBe(0);
    await expect(admin.query(`select warehouse.complete_load($1)`, [load])).rejects.toThrow(/не отсканировано/);
    const s2 = (await admin.query(`select warehouse.scan_load($1, $2) as r`, [load, kit])).rows[0].r;
    expect(s2.text).toBe("Заказ 4812: 2 из 2");
    expect((await admin.query(`select warehouse.complete_load($1) as r`, [load])).rows[0].r.status).toBe("completed");
  });

  it("чужое место в машину не пройдёт", async () => {
    const a = await makeOrder(admin, { number: "A" }); const b = await makeOrder(admin, { number: "B" });
    for (const id of [a, b]) await admin.query(`select tracking.ensure_cargo_units($1)`, [id]);
    const load = (await admin.query(`select warehouse.create_load('W-2', '2026-11-20', null, $1::uuid[]) as id`, [[a]])).rows[0].id;
    await expect(admin.query(`select warehouse.scan_load($1, $2)`, [load, (await tags(b))[0]])).rejects.toThrow(/нет в этой машине/);
  });
});
