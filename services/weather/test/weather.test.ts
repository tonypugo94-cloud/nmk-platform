import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool, serviceRole, cleanData, urlFor } from "../../../tests/db.js";
import { runService, silentLogger } from "@nmk/shared";
import { weatherService } from "../src/definition.js";
import { MeteoPlanProvider, summarize, type WeatherProvider } from "../src/provider.js";

const admin = pool();
beforeAll(async () => { await serviceRole(admin, "svc_weather"); });
afterAll(() => admin.end());
beforeEach(async () => { await cleanData(admin); await admin.query(`truncate weather.forecasts`); });

/** Поддельный МетеоПлан: вход по паролю + три таблицы REST. Пишет, какие запросы пришли. */
function fakeMeteoPlan() {
  const calls: string[] = [];
  let logins = 0;
  const f = (async (url: string, init?: RequestInit) => {
    const u = String(url); calls.push(u);
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
    if (u.includes("/auth/v1/token")) {
      logins++;
      const body = JSON.parse(String(init?.body));
      return body.password === "ok" ? json({ access_token: `t${logins}`, expires_in: 3600 }) : json({ error: "invalid" }, 400);
    }
    if ((init?.headers as any)?.authorization !== `Bearer t${logins}`) return json({}, 401);
    if (u.includes("wthr_cities")) return json([{ id: "c-kst", name: "Кстово" }, { id: "c-sem", name: "Семёнов" }, { id: "c-arz", name: "Арзамас" }]);
    if (u.includes("wthr_org_cities")) return json([{ city_id: "c-kst" }, { city_id: "c-sem" }]);
    if (u.includes("wthr_forecast_aggregated")) return json([
      { forecast_date: "2026-11-12", avg_probability: "65", avg_amount_mm: "2.2", category: "light_rain", is_snow: false, avg_max_temp_c: "2.69", confidence: "medium" },
      { forecast_date: "2026-11-14", avg_probability: 99, avg_amount_mm: 8.825, category: "heavy_rain", is_snow: false, avg_max_temp_c: 10.31, confidence: "medium" },
    ]);
    return json({}, 404);
  }) as unknown as typeof fetch;
  return { f, calls, logins: () => logins };
}

describe("провайдер МетеоПлана", () => {
  it("входит под учётной записью НМК, читает агрегированный прогноз, повторно не логинится", async () => {
    const mp = fakeMeteoPlan();
    const p = new MeteoPlanProvider({ url: "https://mp.example/", key: "anon", email: "nmk@x", password: "ok" }, mp.f);
    const fc = await p.forecast("c-kst", 9);
    expect(fc).toEqual([
      { day: "2026-11-12", precipProb: 65, precipMm: 2.2, category: "light_rain", isSnow: false, maxTempC: 2.7, confidence: "medium", summary: "небольшие осадки, 65%, 2.2 мм, +2.7°" },
      { day: "2026-11-14", precipProb: 99, precipMm: 8.8, category: "heavy_rain", isSnow: false, maxTempC: 10.3, confidence: "medium", summary: "сильные осадки, 99%, 8.8 мм, +10.3°" },
    ]);
    expect(mp.calls.some((c) => c.includes("city_id=eq.c-kst") && c.includes("limit=9"))).toBe(true);
    await p.forecast("c-kst", 9);
    expect(mp.logins()).toBe(1);
  });

  it("неверный пароль — понятная ошибка", async () => {
    const p = new MeteoPlanProvider({ url: "https://mp.example", key: "anon", email: "nmk@x", password: "bad" }, fakeMeteoPlan().f);
    await expect(p.forecast("c-kst", 3)).rejects.toThrow(/вход не удался/);
  });

  it("города: отмечает подключённые в кабинете НМК", async () => {
    const p = new MeteoPlanProvider({ url: "https://mp.example", key: "anon", email: "nmk@x", password: "ok" }, fakeMeteoPlan().f);
    expect(await p.cities()).toEqual([
      { id: "c-kst", name: "Кстово", connected: true }, { id: "c-sem", name: "Семёнов", connected: true }, { id: "c-arz", name: "Арзамас", connected: false },
    ]);
  });

  it("описание дня для менеджера", () => {
    expect(summarize({ category: "clear", isSnow: false, precipProb: 8, precipMm: 0, maxTempC: -3 })).toBe("без осадков, -3°");
    expect(summarize({ category: "light_rain", isSnow: true, precipProb: 40, precipMm: 1.2, maxTempC: 0 })).toBe("небольшой снег, 40%, 1.2 мм, 0°");
  });
});

describe("сервис погоды", () => {
  it("сам сопоставляет направления с городами по названию и сохраняет прогноз с категорией", async () => {
    await admin.query(`insert into core.directions (name) values ('Кстово'), ('Семенов'), ('Арзамас'), ('Лысково')`);
    const mp = fakeMeteoPlan();
    const svc = await runService(weatherService(new MeteoPlanProvider({ url: "https://mp.example", key: "anon", email: "nmk@x", password: "ok" }, mp.f)),
      { databaseUrl: urlFor("svc_weather"), port: 0, autoLoop: false, logger: silentLogger });
    await svc.tick();
    await svc.stop();
    const { rows: dirs } = await admin.query(`select name, meteo_ref from core.directions order by name`);
    expect(dirs).toEqual([
      { name: "Арзамас", meteo_ref: "c-arz" }, { name: "Кстово", meteo_ref: "c-kst" }, { name: "Лысково", meteo_ref: null }, { name: "Семенов", meteo_ref: "c-sem" },
    ]);
    const { rows } = await admin.query(`select d.name, f.day::text, f.category, f.precip_prob from weather.forecasts f join core.directions d on d.id = f.direction_id where d.name = 'Кстово' order by f.day`);
    expect(rows).toEqual([
      { name: "Кстово", day: "2026-11-12", category: "light_rain", precip_prob: 65 },
      { name: "Кстово", day: "2026-11-14", category: "heavy_rain", precip_prob: 99 },
    ]);
  });

  it("при недоступности — одно событие об отказе, старый прогноз остаётся", async () => {
    await admin.query(`insert into core.directions (name, meteo_ref) values ('Арзамас', 'arz')`);
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
