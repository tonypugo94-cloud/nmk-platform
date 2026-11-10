/**
 * Источник прогноза. Сменить источник = написать новый провайдер с тем же интерфейсом.
 */
export type DayForecast = {
  day: string;
  precipProb: number | null;
  precipMm: number | null;
  summary: string | null;
  category?: string | null;     // clear | low_chance | light_rain | heavy_rain
  isSnow?: boolean | null;
  maxTempC?: number | null;
  confidence?: string | null;   // high | medium | low
};

export type City = { id: string; name: string; connected: boolean };

export interface WeatherProvider {
  forecast(pointRef: string, days: number, signal?: AbortSignal): Promise<DayForecast[]>;
  /** Города источника; connected — подключён ли город в кабинете НМК (только по ним есть прогноз). */
  cities?(signal?: AbortSignal): Promise<City[]>;
}

export type MeteoPlanConfig = {
  url: string;        // https://<project>.supabase.co — адрес МетеоПлана
  key: string;        // публичный ключ проекта (anon / publishable)
  email: string;      // учётная запись НМК в МетеоПлане
  password: string;
};

const CATEGORY_TITLE: Record<string, string> = {
  clear: "без осадков", low_chance: "возможны осадки", light_rain: "небольшие осадки", heavy_rain: "сильные осадки",
};
const SNOW_TITLE: Record<string, string> = { low_chance: "возможен снег", light_rain: "небольшой снег", heavy_rain: "сильный снег" };

export function summarize(f: { category: string | null; isSnow: boolean | null; precipProb: number | null; precipMm: number | null; maxTempC: number | null }) {
  const parts: string[] = [];
  const cat = f.category ?? "";
  parts.push((f.isSnow && SNOW_TITLE[cat]) || CATEGORY_TITLE[cat] || "прогноз");
  if (f.precipProb != null && f.category !== "clear") parts.push(`${f.precipProb}%`);
  if (f.precipMm != null && f.precipMm >= 0.5) parts.push(`${f.precipMm} мм`);
  if (f.maxTempC != null) parts.push(`${f.maxTempC > 0 ? "+" : ""}${f.maxTempC}°`);
  return parts.join(", ");
}

const round1 = (x: unknown) => (x == null ? null : Math.round(Number(x) * 10) / 10);
const mskToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow" }).format(new Date());

/**
 * МетеоПлан — Supabase-проект. Входим под учётной записью НМК (как пользователь кабинета) и читаем
 * агрегированный прогноз: RLS МетеоПлана отдаёт только города НМК и только при активной подписке.
 * Из НМК в МетеоПлан ничего не уходит, персональных данных в запросах нет.
 */
export class MeteoPlanProvider implements WeatherProvider {
  private token: { value: string; until: number } | null = null;

  constructor(private cfg: MeteoPlanConfig, private fetchImpl: typeof fetch = fetch, private now: () => number = Date.now) {}

  private base() { return this.cfg.url.replace(/\/$/, ""); }

  private async login(signal?: AbortSignal): Promise<string> {
    if (this.token && this.token.until > this.now() + 60_000) return this.token.value;
    const res = await this.fetchImpl(`${this.base()}/auth/v1/token?grant_type=password`, {
      method: "POST", signal,
      headers: { apikey: this.cfg.key, "content-type": "application/json" },
      body: JSON.stringify({ email: this.cfg.email, password: this.cfg.password }),
    });
    if (!res.ok) throw new Error(`МетеоПлан: вход не удался (${res.status})`);
    const data = (await res.json()) as { access_token: string; expires_in?: number };
    this.token = { value: data.access_token, until: this.now() + (data.expires_in ?? 3600) * 1000 };
    return data.access_token;
  }

  private async get<T>(path: string, signal?: AbortSignal, retry = true): Promise<T> {
    const token = await this.login(signal);
    const res = await this.fetchImpl(`${this.base()}/rest/v1/${path}`, { signal, headers: { apikey: this.cfg.key, authorization: `Bearer ${token}` } });
    if (res.status === 401 && retry) { this.token = null; return this.get<T>(path, signal, false); }
    if (!res.ok) throw new Error(`МетеоПлан ${res.status}`);
    return (await res.json()) as T;
  }

  async cities(signal?: AbortSignal): Promise<City[]> {
    const [all, mine] = await Promise.all([
      this.get<{ id: string; name: string }[]>(`wthr_cities?select=id,name&is_active=eq.true`, signal),
      this.get<{ city_id: string }[]>(`wthr_org_cities?select=city_id`, signal),
    ]);
    const connected = new Set(mine.map((c) => c.city_id));
    return all.map((c) => ({ id: c.id, name: c.name, connected: connected.has(c.id) }));
  }

  async forecast(cityId: string, days: number, signal?: AbortSignal): Promise<DayForecast[]> {
    const q = `wthr_forecast_aggregated?select=forecast_date,avg_probability,avg_amount_mm,category,is_snow,avg_max_temp_c,confidence`
      + `&city_id=eq.${encodeURIComponent(cityId)}&forecast_date=gte.${mskToday()}&order=forecast_date&limit=${days}`;
    const rows = await this.get<any[]>(q, signal);
    return rows.map((r) => {
      const f = {
        day: String(r.forecast_date).slice(0, 10),
        precipProb: r.avg_probability == null ? null : Math.round(Number(r.avg_probability)),
        precipMm: round1(r.avg_amount_mm),
        category: r.category ?? null,
        isSnow: r.is_snow ?? null,
        maxTempC: round1(r.avg_max_temp_c),
        confidence: r.confidence ?? null,
      };
      return { ...f, summary: summarize(f) };
    });
  }
}

/** Сопоставление «направление НМК → город МетеоПлана» по названию (регистр и «ё» не важны). */
export const normalizeName = (s: string) => s.toLowerCase().replace(/ё/g, "е").replace(/[^a-zа-я0-9]+/g, " ").trim();
