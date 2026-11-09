import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool, serviceRole, cleanData, urlFor } from "../../../tests/db.js";
import { runService, silentLogger } from "@nmk/shared";
import { OneCEmulator, OneCHttpWriter, OneCODataAdapter, defaultOneCConfig } from "@nmk/accounting";
import { writeback } from "../src/definition.js";

const admin = pool();
let emu: OneCEmulator, url: string;
beforeAll(async () => { await serviceRole(admin, "svc_accounting_writeback"); });
afterAll(async () => { await emu.close(); await admin.end(); });
beforeEach(async () => {
  await cleanData(admin);
  await emu?.close();
  emu = OneCEmulator.seeded(); url = await emu.listen();
  await admin.query(`select core.register_module('{"key":"accounting_writeback","title":"Запись в 1С"}')`);
});

describe("запись стадий в 1С", () => {
  it("выключен — молчит; включён — пишет стадии с производства, стадии из 1С обратно не пишет", async () => {
    const ad = new OneCODataAdapter({ ...defaultOneCConfig, baseUrl: url, user: "obmen", password: "secret" });
    const ref = [...emu.orders.keys()][2]!;
    await admin.query(`select core.apply_accounting_order($1::jsonb)`, [JSON.stringify(await ad.getOrder(ref))]);
    const { rows: [{ id }] } = await admin.query(`select id from core.orders where onec_ref = $1`, [ref]);
    const svc = await runService(writeback(new OneCHttpWriter({ baseUrl: url.replace("/odata/standard.odata", "/hs/nmk"), user: "obmen", password: "secret" })),
      { databaseUrl: urlFor("svc_accounting_writeback"), port: 0, autoLoop: false, logger: silentLogger });
    await admin.query(`select core.set_order_stage($1, 'in_production', 'tracking')`, [id]);
    await svc.tick();
    expect(emu.written).toEqual([]);
    await admin.query(`update core.app_modules set enabled = true where key = 'accounting_writeback'`);
    await admin.query(`select core.set_order_stage($1, 'ready', 'tracking')`, [id]);
    await svc.tick();
    expect(emu.written).toEqual([{ ref, stage: "Готов" }]);
    expect((await ad.getOrder(ref)).stage).toBe("Готов");
    await svc.stop();
  });
});
