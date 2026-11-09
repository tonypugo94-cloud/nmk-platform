import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool, serviceRole, cleanData, urlFor } from "../../../tests/db.js";
import { runService, silentLogger } from "@nmk/shared";
import { weatherService } from "../src/definition.js";
import { MeteoPlanProvider, type WeatherProvider } from "../src/provider.js";

const admin = pool();
beforeAll(async () => { await serviceRole(admin, "svc_weather"); });
afterAll(() => admin.end());
beforeEach(async () => { await cleanData(admin); await admin.query(`truncate weather.forecasts`); await admin.query(`insert into core.directions (name, meteo_ref) values ('Арзамас', 'arz')`); });

describe("погода", () => {
  it("разбор ответа МетеоПлана", async () => {
    const fake = (async () => new Response(JSON.stringify({ days: [{ date: "2026-05-14T00:00:00", precipitationProbability: 80, precipitationMm: 6.5, summary: "дождь" }] }))) as typeof fetch;
    expect(await new MeteoPlanProvider("http://x", "t", fake).forecast("arz", 1)).toEqual([{ day: "2026-05-14", precipProb: 80, precipMm: 6.5, summary: "дождь" }]);
  });

  it("сохраняет прогноз; при недоступности — одно событие об отказе, старый прогноз остаётся", async () => {
    let down = false;
    const provider: WeatherProvider = { forecast: async () => { if (down) throw new Error("timeout"); return [{ day: "2026-05-14", precipProb: 80, precipMm: 5, summary: "дождь" }]; } };
    const svc = await runService(weatherService(provider), { databaseUrl: urlFor("svc_weather"), port: 0, autoLoop: false, logger: silentLogger });
    await svc.tick();
    down = true; await svc.tick(); await svc.tick();
    await svc.stop();
    expect((await admin.query(`select precip_prob from weather.forecasts`)).rows).toEqual([{ precip_prob: 80 }]);
    expect((await admin.query(`select count(*)::int n from bus.events where type='weather.failed'`)).rows[0].n).toBe(1);
  });
});
