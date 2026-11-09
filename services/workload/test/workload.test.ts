import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool, serviceRole, cleanData, urlFor, makeOrder } from "../../../tests/db.js";
import { runService, silentLogger } from "@nmk/shared";
import { workload } from "../src/definition.js";

const admin = pool();
beforeAll(async () => { await serviceRole(admin, "svc_workload"); });
afterAll(() => admin.end());
beforeEach(() => cleanData(admin));

const day = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
const tagOf = async (orderId: string) => (await admin.query(
  `select g.code from tracking.tags g join tracking.cargo_units u on u.id = g.cargo_unit_id where u.order_id = $1 and u.kind = 'stela'`, [orderId])).rows[0].code;

describe("распределение работ", () => {
  it("очередь участка по запасу дней и движение по маршруту", async () => {
    const late = await makeOrder(admin, { number: "A", dueDate: day(2) });
    const early = await makeOrder(admin, { number: "B", dueDate: day(20) });
    for (const id of [late, early]) await admin.query(`select tracking.ensure_cargo_units($1)`, [id]);
    let q = (await admin.query(`select number, slack_days from workload.api_queue where station_code = 'laser'`)).rows;
    expect(q.map((r) => r.number)).toEqual(["A", "B"]);
    expect(q[0].slack_days).toBeLessThan(q[1].slack_days);

    const tag = await tagOf(late);
    await admin.query(`select tracking.record_scan($1,'laser','take','w1')`, [tag]);
    expect((await admin.query(`select in_work from workload.api_queue where number='A'`)).rows[0].in_work).toBe(true);
    await admin.query(`select tracking.record_scan($1,'laser','done','w2')`, [tag]);
    q = (await admin.query(`select station_code from workload.api_queue where number='A'`)).rows;
    expect(q).toEqual([{ station_code: "sandblast" }]);
    const load = (await admin.query(`select station_code, queued, hot from workload.api_station_load where station_code in ('laser','sandblast') order by station_code`)).rows;
    expect(load).toEqual([{ station_code: "laser", queued: "1", hot: "0" }, { station_code: "sandblast", queued: "1", hot: "1" }]);
  });

  it("риск просрочки — одно событие в день на заказ", async () => {
    const id = await makeOrder(admin, { number: "C", dueDate: day(1) });
    await admin.query(`select tracking.ensure_cargo_units($1)`, [id]);
    const svc = await runService(workload, { databaseUrl: urlFor("svc_workload"), port: 0, autoLoop: false, logger: silentLogger });
    await svc.tick(); await svc.tick();
    await svc.stop();
    expect((await admin.query(`select count(*)::int n from bus.events where type = 'workload.risk_detected'`)).rows[0].n).toBe(1);
  });
});
