/**
 * MAX Bot API. Формат сверить с документацией dev.max.ru при подключении бота НМК:
 * отправка POST {base}/messages?chat_id=…, кнопки — вложение inline_keyboard с callback-кнопками,
 * входящие — вебхук с update_type: bot_started (deep-link payload), message_created, message_callback.
 */
import type { Button, Inbound, Transport } from "./transport.js";

export class MaxTransport implements Transport {
  readonly channel = "max" as const;
  constructor(private cfg: { token: string; webhookSecret: string; baseUrl?: string }, private fetchImpl: typeof fetch = fetch) {}

  async send(chatId: string, text: string, buttons: Button[][], signal?: AbortSignal) {
    const body: any = { text };
    if (buttons.length) body.attachments = [{ type: "inline_keyboard", payload: { buttons: buttons.map((row) => row.map((b) => ({ type: "callback", text: b.text, payload: b.payload }))) } }];
    const res = await this.fetchImpl(`${this.cfg.baseUrl ?? "https://platform-api.max.ru"}/messages?chat_id=${encodeURIComponent(chatId)}`, {
      method: "POST", signal, headers: { authorization: this.cfg.token, "content-type": "application/json" }, body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`MAX ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data: any = await res.json();
    return { externalId: data?.message?.body?.mid ?? null };
  }

  parseWebhook(body: any, headers: Record<string, string | string[] | undefined>) {
    const authorized = headers["x-max-bot-api-secret"] === this.cfg.webhookSecret;
    const updates: Inbound[] = [];
    if (!authorized) return { updates, authorized };
    const u = body ?? {};
    const chat = String(u.chat_id ?? u.message?.recipient?.chat_id ?? u.callback?.user?.user_id ?? u.user?.user_id ?? "");
    if (u.update_type === "bot_started") updates.push({ chatId: chat, kind: "start", data: { code: u.payload ?? "" } });
    else if (u.update_type === "message_callback") updates.push({ chatId: chat, kind: "button", data: { payload: u.callback?.payload, callbackId: u.callback?.callback_id } });
    else if (u.update_type === "message_created") {
      const t = String(u.message?.body?.text ?? "");
      const m = t.match(/^\/start\s+(\S+)/);
      updates.push(m ? { chatId: chat, kind: "start", data: { code: m[1] } } : { chatId: chat, kind: "text", data: { text: t } });
    }
    return { updates, authorized };
  }
}
