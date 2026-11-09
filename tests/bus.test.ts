import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool, serviceRole, cleanData } from "./db.js";
import { publish, subscribe, claim, ack, nack, matches } from "../packages/shared/src/index.js";

const admin = pool();
let a: ReturnType<typeof pool>, b: ReturnType<typeof pool>;

beforeAll(async () => {
  await serviceRole(admin, "svc_test_a");
  await serviceRole(admin, "svc_test_b");
  a = pool("svc_test_a"); b = pool("svc_test_b");
});
afterAll(async () => { await a.end(); await b.end(); await admin.end(); });
beforeEach(() => cleanData(admin));

describe("шина событий", () => {
  it("раскладывает событие по подписчикам по шаблону", async () => {
    await subscribe(a, "svc_test_a", ["demo.*"]);
    await subscribe(b, "svc_test_b", ["other.*"]);
    await publish(admin, "demo.created", "demo:1", { x: 1 });
    expect(await claim(a, "svc_test_a")).toHaveLength(1);
    expect(await claim(b, "svc_test_b")).toHaveLength(0);
  });

  it("событие, опубликованное до подписки, подписчику не приходит, после — приходит даже если он лежал", async () => {
    await publish(admin, "demo.early", null, {});
    await subscribe(a, "svc_test_a", ["demo.*"]);
    await publish(admin, "demo.late", null, {});
    const got = await claim(a, "svc_test_a");
    expect(got.map((e) => e.type)).toEqual(["demo.late"]);
  });

  it("ключ идемпотентности не даёт задвоить событие", async () => {
    await subscribe(a, "svc_test_a", ["demo.*"]);
    const id1 = await publish(admin, "demo.x", null, {}, "k1");
    const id2 = await publish(admin, "demo.x", null, {}, "k1");
    expect(id1).toBe(id2);
    expect(await claim(a, "svc_test_a")).toHaveLength(1);
  });

  it("ack закрывает доставку, nack — откладывает с паузой, после лимита — dead", async () => {
    await subscribe(a, "svc_test_a", ["demo.*"]);
    await publish(admin, "demo.fail", null, {});
    const [ev] = await claim(a, "svc_test_a");
    expect(await nack(a, ev!.deliveryId, "boom", 2)).toBe("pending");
    expect(await claim(a, "svc_test_a")).toHaveLength(0); // ещё на паузе
    await admin.query(`update bus.deliveries set available_at = now()`);
    const [again] = await claim(a, "svc_test_a");
    expect(again!.attempts).toBe(2);
    expect(await nack(a, again!.deliveryId, "boom", 2)).toBe("dead");
    const { rows } = await admin.query(`select dead from bus.api_stats where subscriber = 'svc_test_a'`);
    expect(Number(rows[0].dead)).toBe(1);
    await publish(admin, "demo.ok", null, {});
    const [ok] = await claim(a, "svc_test_a");
    await ack(a, ok!.deliveryId);
    expect(await claim(a, "svc_test_a")).toHaveLength(0);
  });

  it("зависшая доставка возвращается после истечения аренды", async () => {
    await subscribe(a, "svc_test_a", ["demo.*"]);
    await publish(admin, "demo.x", null, {});
    await claim(a, "svc_test_a", 10, 60);
    expect(await claim(a, "svc_test_a")).toHaveLength(0);
    await admin.query(`update bus.deliveries set locked_until = now() - interval '1 second'`);
    expect(await claim(a, "svc_test_a")).toHaveLength(1);
  });

  it("сервис не может забрать чужие доставки", async () => {
    await subscribe(a, "svc_test_a", ["demo.*"]);
    await expect(claim(b, "svc_test_a")).rejects.toThrow(/does not match/);
    await expect(subscribe(b, "svc_test_a", ["*"])).rejects.toThrow(/does not match/);
  });

  it("сервисная роль не видит чужие таблицы напрямую", async () => {
    await expect(a.query(`select * from bus.deliveries`)).rejects.toThrow(/permission denied/);
    await expect(a.query(`select * from core.orders`)).rejects.toThrow(/permission denied/);
  });

  it("шаблоны подписок", () => {
    expect(matches("order.*", "order.stage_changed")).toBe(true);
    expect(matches("order.*", "orders.x")).toBe(false);
    expect(matches("*", "a.b")).toBe(true);
    expect(matches("order.stage_changed", "order.stage_changed")).toBe(true);
  });
});
