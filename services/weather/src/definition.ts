import { CircuitBreaker, publish, type ServiceDefinition } from "@nmk/shared";
import type { WeatherProvider } from "./provider.js";

export function weatherService(provider: WeatherProvider, opts: { days?: number; everyMs?: number } = {}): ServiceDefinition {
  const breaker = new CircuitBreaker("meteoplan", { threshold: 3, cooldownMs: 10 * 60_000, timeoutMs: 15_000 });
  let failedBefore = false;
  return {
    name: "weather",
    module: { key: "weather", title: "Погода", version: "0.1.0", description: "Прогноз осадков по направлениям из МетеоПлана" },
    tasks: [{
      name: "fetch", everyMs: opts.everyMs ?? 3 * 3_600_000, runOnStart: true,
      run: async ({ db, log }) => {
        const { rows: dirs } = await db.query(`select id, meteo_ref from core.directions where active and meteo_ref is not null`);
        let ok = 0, failed = 0, days = 0;
        for (const d of dirs) {
          try {
            const fc = await breaker.call((s) => provider.forecast(d.meteo_ref, opts.days ?? 10, s));
            for (const f of fc) {
              await db.query(
                `insert into weather.forecasts (direction_id, day, precip_prob, precip_mm, summary, fetched_at) values ($1,$2,$3,$4,$5, now())
                 on conflict (direction_id, day) do update set precip_prob = excluded.precip_prob, precip_mm = excluded.precip_mm,
                   summary = excluded.summary, fetched_at = now()`, [d.id, f.day, f.precipProb, f.precipMm, f.summary]);
            }
            ok++; days = Math.max(days, fc.length);
          } catch (e) {
            failed++; log.warn("forecast failed", { direction: d.id, error: (e as Error).message });
          }
        }
        if (ok) await publish(db, "weather.updated", null, { directions: ok, days });
        if (failed && !ok && !failedBefore) await publish(db, "weather.failed", null, { error: "МетеоПлан не отвечает" });
        failedBefore = failed > 0 && !ok;
      },
    }],
  };
}
