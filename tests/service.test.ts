import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool, serviceRole, cleanData, urlFor } from "./db.js";
import { runService, publish, silentLogger } from "../packages/shared/src/index.js";

const admin = pool();
beforeAll(() => serviceRole(admin, "svc_demo"));
beforeEach(() => cleanData(admin));
afterAll(() => admin.end());

describe("каркас сервиса", () => {
  it("регистрирует модуль, обрабатывает события, сбой одного события не блокирует другие", async () => {
    const seen: string[] = [];
    let failOnce = true;
    const svc = await runService({
      name: "demo",
      module: { key: "demo", title: "Демо" },
      subscriptions: {
        "demo.*": async (ev) => {
          if (ev.type === "demo.bad" && failOnce) { failOnce = false; throw new Error("временный сбой"); }
          seen.push(ev.type);
        },
      },
    }, { databaseUrl: urlFor("svc_demo"), port: 0, autoLoop: false, logger: silentLogger });

    await publish(admin, "demo.bad", null, {});
    await publish(admin, "demo.good", null, {});
    await svc.tick();
    expect(seen).toEqual(["demo.good"]);
    await admin.query(`update bus.deliveries set available_at = now()`);
    await svc.tick();
    expect(seen).toEqual(["demo.good", "demo.bad"]);

    const res = await fetch(`http://localhost:${svc.port}/ready`);
    expect(res.status).toBe(200);
    await svc.stop();
    expect((await admin.query(`select count(*)::int n from core.app_modules where key='demo'`)).rows[0].n).toBe(1);
  });

  it("пока сервис лежал, события копились и обработались после старта", async () => {
    await admin.query(`select bus.subscribe('svc_demo', array['demo.*'])`);
    await publish(admin, "demo.while_down", null, {});
    const seen: string[] = [];
    const svc = await runService({ name: "demo", subscriptions: { "demo.*": async (ev) => { seen.push(ev.type); } } },
      { databaseUrl: urlFor("svc_demo"), port: 0, autoLoop: false, logger: silentLogger });
    await svc.tick();
    expect(seen).toEqual(["demo.while_down"]);
    await svc.stop();
  });
});
