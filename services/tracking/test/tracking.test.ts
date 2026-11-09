import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool, serviceRole, cleanData, urlFor, makeOrder } from "../../../tests/db.js";
import { runService, silentLogger, type RunningService } from "@nmk/shared";
import { tracking } from "../src/definition.js";

const admin = pool();
let svc: RunningService;
beforeAll(async () => { await serviceRole(admin, "svc_tracking"); });
afterAll(() => admin.end());
beforeEach(async () => {
  await cleanData(admin);
  svc = await runService(tracking, { databaseUrl: urlFor("svc_tracking"), port: 0, autoLoop: false, logger: silentLogger });
});
const stop = () => svc.stop();

const scan = (tag: string, station: string, action: string, id: string) =>
  admin.query(`select tracking.record_scan($1, $2, $3, $4) as r`, [tag, station, action, id]).then((r) => r.rows[0].r);
const labels = async (orderId: string) => (await admin.query(`select kind, seq, units_total, tag_code, contents from tracking.api_labels where order_id = $1 order by seq`, [orderId])).rows;

describe("QR и участки", () => {
  it("заказ → стела со своей биркой + один паллет-комплект; услуги не маркируются", async () => {
    const id = await makeOrder(admin);
    await svc.tick();
    const l = await labels(id);
    expect(l.map((x) => x.kind)).toEqual(["stela", "kit"]);
    expect(l[1].contents.map((c: any) => c.name)).toEqual(["Подставка 60×20×15", "Цветник 100×50"]);
    expect(Number(l[0].units_total)).toBe(2);
    await stop();
  });

  it("сервис лежал — грузовые места создаются после запуска", async () => {
    await stop();
    const id = await makeOrder(admin);
    expect(await labels(id)).toHaveLength(0);
    svc = await runService(tracking, { databaseUrl: urlFor("svc_tracking"), port: 0, autoLoop: false, logger: silentLogger });
    await svc.tick();
    expect(await labels(id)).toHaveLength(2);
    await stop();
  });

  it("сканы двигают стадию только вперёд; повторная отправка из офлайна не задваивает", async () => {
    const id = await makeOrder(admin);
    await svc.tick(); await stop();
    const [stela, kit] = await labels(id);
    await scan(stela.tag_code, "laser", "take", "s1");
    expect((await admin.query(`select stage_code, stage_source from core.orders where id=$1`, [id])).rows[0]).toEqual({ stage_code: "in_production", stage_source: "tracking" });
    await scan(stela.tag_code, "sandblast", "done", "s2");
    expect((await scan(stela.tag_code, "sandblast", "done", "s2")).duplicate).toBe(true);
    expect((await admin.query(`select count(*)::int n from tracking.scans`)).rows[0].n).toBe(2);
    await scan(stela.tag_code, "laser", "take", "s3"); // повторная гравировка не откатывает «Готов»
    expect((await admin.query(`select stage_code from core.orders where id=$1`, [id])).rows[0].stage_code).toBe("ready");
    await expect(scan(kit.tag_code, "laser", "take", "s4")).rejects.toThrow(/комплект/);
    await expect(scan("NOPE", "laser", "take", "s5")).rejects.toThrow(/Неизвестный QR/);
  });

  it("закрытый заказ — бирки больше не принимаются", async () => {
    const id = await makeOrder(admin, { ref: "closed-1" });
    await svc.tick();
    await makeOrder(admin, { ref: "closed-1", dataVersion: "v2", status: "closed" });
    await svc.tick(); await stop();
    const [stela] = (await admin.query(`select g.code from tracking.tags g join tracking.cargo_units u on u.id=g.cargo_unit_id where u.order_id=$1 order by u.seq`, [id])).rows;
    await expect(scan(stela.code, "laser", "take", "x1")).rejects.toThrow(/не действует/);
  });
});
