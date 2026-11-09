import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool, serviceRole, cleanData, urlFor, makeOrder } from "../../../tests/db.js";
import { runService, silentLogger } from "@nmk/shared";
import { procurement } from "../src/definition.js";

const admin = pool();
beforeAll(async () => { await serviceRole(admin, "svc_procurement"); });
afterAll(() => admin.end());
beforeEach(async () => {
  await cleanData(admin);
  await admin.query(`truncate procurement.drafts, procurement.rules, procurement.suppliers, integration.stock cascade`);
});

async function setup() {
  await makeOrder(admin, { number: "A" }); await makeOrder(admin, { number: "B" }); // спрос: 2 стелы
  const { rows: [{ id: stela }] } = await admin.query(`select id from core.catalog_items where onec_ref = 'i-stela'`);
  const { rows: [{ id: sup }] } = await admin.query(`insert into procurement.suppliers (name) values ('Гранит-поставщик') returning id`);
  await admin.query(`insert into procurement.rules (catalog_item_id, supplier_id, min_qty, safety_qty, pack_qty, lead_days) values ($1, $2, 3, 1, 2, 10)`, [stela, sup]);
  await admin.query(`insert into integration.stock (item_ref, qty) values ('i-stela', 3)`);
  return { stela, sup };
}

describe("заявки на поставку", () => {
  it("свободно 3−2=1, нужно 3+1 → дозаказ 3, округлено до упаковки 4; утверждение задаёт срок", async () => {
    await setup();
    const svc = await runService(procurement, { databaseUrl: urlFor("svc_procurement"), port: 0, autoLoop: false, logger: silentLogger });
    await svc.tick(); await svc.stop();
    const { rows: [line] } = await admin.query(`select qty::int, stock_qty::int, demand_qty::int from procurement.draft_lines`);
    expect(line).toEqual({ qty: 4, stock_qty: 3, demand_qty: 2 });
    const { rows: [d] } = await admin.query(`select id from procurement.drafts where status = 'draft'`);
    await admin.query(`select procurement.approve($1)`, [d.id]);
    const { rows: [a] } = await admin.query(`select status, eta - current_date as days from procurement.drafts where id = $1`, [d.id]);
    expect(a).toEqual({ status: "approved", days: 10 });
  });

  it("если остатка хватает — черновик исчезает; утверждённые не трогаются", async () => {
    await setup();
    await admin.query(`select procurement.recalculate()`);
    await admin.query(`update integration.stock set qty = 20`);
    await admin.query(`select procurement.recalculate()`);
    expect((await admin.query(`select count(*)::int n from procurement.drafts`)).rows[0].n).toBe(0);
  });
});
