/**
 * Источник прогноза. МетеоПлан — наш же сервис; формат ответа уточняется при подключении,
 * поэтому разбор вынесен сюда и покрыт тестом. Сменить источник = написать новый провайдер.
 */
export type DayForecast = { day: string; precipProb: number | null; precipMm: number | null; summary: string | null };

export interface WeatherProvider {
  forecast(pointRef: string, days: number, signal?: AbortSignal): Promise<DayForecast[]>;
}

/** Ожидаемый ответ: GET {base}/api/forecast?point=<ref>&days=N → { days: [{ date, precipitationProbability, precipitationMm, summary }] } */
export class MeteoPlanProvider implements WeatherProvider {
  constructor(private base: string, private token: string, private fetchImpl: typeof fetch = fetch) {}
  async forecast(pointRef: string, days: number, signal?: AbortSignal): Promise<DayForecast[]> {
    const res = await this.fetchImpl(`${this.base.replace(/\/$/, "")}/api/forecast?point=${encodeURIComponent(pointRef)}&days=${days}`,
      { signal, headers: { authorization: `Bearer ${this.token}` } });
    if (!res.ok) throw new Error(`МетеоПлан ${res.status}`);
    const data = (await res.json()) as { days: any[] };
    return data.days.map((d) => ({
      day: String(d.date).slice(0, 10),
      precipProb: d.precipitationProbability ?? null,
      precipMm: d.precipitationMm ?? null,
      summary: d.summary ?? null,
    }));
  }
}
