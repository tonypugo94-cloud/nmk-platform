/** Запись в учётную систему. Реализация для 1С — HTTP-сервис расширения конфигурации. */
export interface AccountingWriter {
  setStage(orderRef: string, stageTitle: string, signal?: AbortSignal): Promise<void>;
}

/** POST {baseUrl}/stage  {"ref": "<Ref_Key заказа>", "stage": "Готов"} → 200. Basic-аутентификация. */
export class OneCHttpWriter implements AccountingWriter {
  constructor(private cfg: { baseUrl: string; user: string; password: string }, private fetchImpl: typeof fetch = fetch) {}
  async setStage(orderRef: string, stageTitle: string, signal?: AbortSignal) {
    const res = await this.fetchImpl(`${this.cfg.baseUrl.replace(/\/$/, "")}/stage`, {
      method: "POST", signal,
      headers: { "content-type": "application/json", authorization: "Basic " + Buffer.from(`${this.cfg.user}:${this.cfg.password}`).toString("base64") },
      body: JSON.stringify({ ref: orderRef, stage: stageTitle }),
    });
    if (!res.ok) throw new Error(`1С HTTP-сервис ${res.status}`);
  }
}
