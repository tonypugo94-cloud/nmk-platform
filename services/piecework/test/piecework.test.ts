import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool, cleanData, makeOrder } from "../../../tests/db.js";

const admin = pool();
afterAll(() => admin.end());
let kitTag: string, standId: string;
beforeEach(async () => {
  await cleanData(admin);
  await admin.query(`truncate piecework.records`);
  await admin.query(`update piecework.operations set rate = case code when 'chamfer_tech' then 150 when 'chamfer_pol_top' then 400 when 'drilling' then 100 else 0 end`);
  const id = await makeOrder(admin);
  await admin.query(`select tracking.ensure_cargo_units($1)`, [id]);
  kitTag = (await admin.query(`select g.code from tracking.tags g join tracking.cargo_units u on u.id = g.cargo_unit_id where u.order_id=$1 and u.kind='kit'`, [id])).rows[0].code;
  standId = (await admin.query(`select id from core.order_items where order_id=$1 and name like 'Подставка%'`, [id])).rows[0].id;
});
const rec = (op: string, qty: number | null, photo: string | null, cid: string) =>
  admin.query(`select piecework.record($1, $2, $3, $4, $5, $6) as r`, [kitTag, standId, op, qty, photo, cid]).then((r) => r.rows[0].r);

describe("сдельная оплата", () => {
  it("по QR комплекта видны детали и погонные метры из размеров: подставка 600×200 → периметр 1,6 м", async () => {
    const o = (await admin.query(`select piecework.options($1) as o`, [kitTag])).rows[0].o;
    const stand = o.items.find((i: any) => i.name.startsWith("Подставка"));
    expect(stand.operations.find((x: any) => x.code === "chamfer_tech").qty).toBe(1.6);
    expect(o.items.map((i: any) => i.name)).not.toContain("Стела 100×50×8"); // стела — отдельное место
  });

  it("начисление по ставке, фото для полированной фаски, повтор из офлайна, ведомость, отмена", async () => {
    expect(await rec("chamfer_tech", null, null, "p1")).toMatchObject({ qty: 1.6, amount: 240 });
    expect((await rec("chamfer_tech", null, null, "p1")).duplicate).toBe(true);
    await expect(rec("chamfer_pol_top", null, null, "p2")).rejects.toThrow(/фото кромки/);
    expect((await rec("chamfer_pol_top", null, "edge.webp", "p3")).amount).toBe(640);
    expect((await rec("drilling", 2, null, "p4")).amount).toBe(200);
    const total = async () => Number((await admin.query(`select sum(amount) s from piecework.api_statement`)).rows[0].s);
    expect(await total()).toBe(1080);
    const { rows: [r] } = await admin.query(`select id from piecework.records where client_id = 'p4'`);
    await admin.query(`select piecework.void($1, 'ошибка')`, [r.id]);
    expect(await total()).toBe(880);
  });
});
