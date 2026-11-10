import { CircuitBreaker, publish, type ServiceDefinition } from "@nmk/shared";
import { normalizeName, type WeatherProvider } from "./provider.js";

export function weatherService(provider: WeatherProvider, opts: { days?: number; everyMs?: number } = {}): ServiceDefinition {
  const breaker = new CircuitBreaker("meteoplan", { threshold: 3, cooldownMs: 10 * 60_000, timeoutMs: 15_000 });
  let failedBefore = false;
  return {
    name: "weather",
    module: { key: "weather", title: "Погода", version: "0.2.0", description: "Прогноз осадков по направлениям из МетеоПлана" },
    tasks: [{
      // МетеоПлан пересчитывает прогноз в 8:00, 12:00 и 16:00 МСК — забираем раз в час, это дёшево.
      name: "fetch", everyMs: opts.everyMs ?? 3_600_000, runOnStart: true,
      run: async ({ db, log }) => {
        // 1. Направления без города: пробуем сопоставить по названию.
        if (provider.cities) {
          const { rows: unmapped } = await db.query(`select id, name from core.directions where active and meteo_ref is null`);
          if (unmapped.length) {
            try {
              const cities = await breaker.call((s) => provider.cities!(s));
              for (const d of unmapped) {
                const hits = cities.filter((c) => normalizeName(c.name) === normalizeName(d.name));
                const c = hits.find((h) => h.connected) ?? hits[0];
                if (!c) { log.warn("direction has no MeteoPlan city", { direction: d.name }); continue; }
                await db.query(`update core.directions set meteo_ref = $2 where id = $1 and meteo_ref is null`, [d.id, c.id]);
                if (!c.connected) log.warn("city is not connected in NMK MeteoPlan account", { direction: d.name, city: c.name });
                log.info("direction mapped to MeteoPlan city", { direction: d.name, city: c.name });
              }
            } catch (e) {
              log.warn("cities lookup failed", { error: (e as Error).message });
            }
          }
        }

        // 2. Прогноз по каждому направлению.
        const { rows: dirs } = await db.query(`select id, name, meteo_ref from core.directions where active and meteo_ref is not null`);
        let ok = 0, failed = 0, days = 0;
        for (const d of dirs) {
          try {
            const fc = await breaker.call((s) => provider.forecast(d.meteo_ref, opts.days ?? 10, s));
            if (!fc.length) log.warn("empty forecast (city not connected or subscription inactive?)", { direction: d.name });
            for (const f of fc) {
              await db.query(
                `insert into weather.forecasts (direction_id, day, precip_prob, precip_mm, summary, category, is_snow, max_temp_c, confidence, fetched_at)
                 values ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
                 on conflict (direction_id, day) do update set precip_prob = excluded.precip_prob, precip_mm = excluded.precip_mm,
                   summary = excluded.summary, category = excluded.category, is_snow = excluded.is_snow, max_temp_c = excluded.max_temp_c,
                   confidence = excluded.confidence, fetched_at = now()`,
                [d.id, f.day, f.precipProb, f.precipMm, f.summary, f.category ?? null, f.isSnow ?? null, f.maxTempC ?? null, f.confidence ?? null]);
            }
            if (fc.length) { ok++; days = Math.max(days, fc.length); }
          } catch (e) {
            failed++; log.warn("forecast failed", { direction: d.name, error: (e as Error).message });
          }
        }
        if (ok) await publish(db, "weather.updated", null, { directions: ok, days });
        if (failed && !ok && !failedBefore) await publish(db, "weather.failed", null, { error: "МетеоПлан не отвечает" });
        failedBefore = failed > 0 && !ok;
      },
    }],
  };
}
