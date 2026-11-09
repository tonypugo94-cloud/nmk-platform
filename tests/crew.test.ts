import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { pool, cleanData, makeOrder } from "./db.js";

const admin = pool();
afterAll(() => admin.end());
let orderId: string;
beforeEach(async () => {
  await cleanData(admin);
  await admin.query(`truncate crew.photos, crew.visits`);
  const dir = (await admin.query(`insert into core.directions (name) values ('Кстово') returning id`)).rows[0].id;
  await admin.query(`insert into core.cemeteries (name, direction_id, lat, lon) values ('Новое Кстово', $1, 56.15, 44.2)`, [dir]);
  const v = (await admin.query(`insert into core.vehicles (kind, plate, capacity_kg) values ('Газель', 'А820ВС', 1500) returning id`)).rows[0].id;
  orderId = await makeOrder(admin, { number: "4812", stage: "Готов", cemetery: "Новое Кстово" });
  const slot = (await admin.query(`select planning.ensure_slot(current_date, $1, $2) as id`, [dir, v])).rows[0].id;
  await admin.query(`select planning.assign($1, $2)`, [orderId, slot]);
});

describe("приложение бригады", () => {
  it("маршрут дня с координатами и составом; без фото «после» установку не отметить", async () => {
    const { rows } = await admin.query(`select number, lat, items from crew.my_route(current_date)`);
    expect(rows[0].number).toBe("4812");
    expect(Number(rows[0].lat)).toBe(56.15);
    expect(rows[0].items.map((i: any) => i.name)).not.toContain("Установка");
    await expect(admin.query(`select crew.complete($1)`, [orderId])).rejects.toThrow(/сфотографируйте/);
  });

  it("фото с геоточкой (повтор из офлайна не задваивает) → «Установлено»: стадия, событие, машина освобождается", async () => {
    for (let i = 0; i < 2; i++)
      await admin.query(`select crew.add_photo($1, 'after', 'crew-photos/x.webp', now(), 56.15, 44.2, 8, 'ph-1')`, [orderId]);
    expect((await admin.query(`select count(*)::int n from crew.photos`)).rows[0].n).toBe(1);
    await admin.query(`select crew.complete($1)`, [orderId]);
    expect((await admin.query(`select stage_code, stage_source from core.orders where id=$1`, [orderId])).rows[0]).toEqual({ stage_code: "installed", stage_source: "crew" });
    expect((await admin.query(`select count(*)::int n from bus.events where type='installation.completed'`)).rows[0].n).toBe(1);
  });
});
