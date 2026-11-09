/**
 * VK, сообщество НМК. Писать можно только тем, кто сам начал диалог (подключение в салоне по QR → vk.me/<группа>?ref=<код>).
 * Отправка: messages.send с inline-клавиатурой callback-кнопок. Входящие: Callback API
 * (confirmation, message_new с ref/payload, message_event — нажатие callback-кнопки).
 */
import type { Button, Inbound, Transport } from "./transport.js";

export class VkTransport implements Transport {
  readonly channel = "vk" as const;
  constructor(private cfg: { token: string; secret: string; confirmation: string; apiVersion?: string }, private fetchImpl: typeof fetch = fetch) {}

  private async call(method: string, params: Record<string, string>, signal?: AbortSignal) {
    const body = new URLSearchParams({ ...params, access_token: this.cfg.token, v: this.cfg.apiVersion ?? "5.199" });
    const res = await this.fetchImpl(`https://api.vk.com/method/${method}`, { method: "POST", body, signal });
    const data: any = await res.json();
    if (data.error) throw new Error(`VK ${data.error.error_code}: ${data.error.error_msg}`);
    return data.response;
  }

  async send(chatId: string, text: string, buttons: Button[][], signal?: AbortSignal) {
    const params: Record<string, string> = { peer_id: chatId, random_id: String(Math.floor(Math.random() * 2 ** 31)), message: text };
    if (buttons.length) params.keyboard = JSON.stringify({ inline: true, buttons: buttons.map((row) => row.map((b) => ({ action: { type: "callback", label: b.text.slice(0, 40), payload: JSON.stringify({ p: b.payload }) } }))) });
    const r = await this.call("messages.send", params, signal);
    return { externalId: r == null ? null : String(r) };
  }

  parseWebhook(body: any) {
    const updates: Inbound[] = [];
    if (!body || body.secret !== this.cfg.secret) return { updates, authorized: false };
    if (body.type === "confirmation") return { updates, authorized: true, reply: this.cfg.confirmation };
    const o = body.object ?? {};
    if (body.type === "message_new") {
      const m = o.message ?? {};
      const chat = String(m.peer_id);
      if (m.ref) updates.push({ chatId: chat, kind: "start", data: { code: m.ref } });
      else if (m.payload) updates.push({ chatId: chat, kind: "button", data: { payload: safe(m.payload) } });
      else updates.push({ chatId: chat, kind: "text", data: { text: m.text ?? "" } });
    } else if (body.type === "message_event") {
      updates.push({ chatId: String(o.peer_id), kind: "button", data: { payload: safe(o.payload), eventId: o.event_id, userId: o.user_id, peerId: o.peer_id } });
    } else if (body.type === "message_read") {
      updates.push({ chatId: String(o.peer_id ?? o.from_id), kind: "read", data: { readMessageId: o.read_message_id } });
    }
    return { updates, authorized: true, reply: "ok" };
  }

  async ackButton(raw: Record<string, unknown>, signal?: AbortSignal) {
    if (!raw.eventId) return;
    await this.call("messages.sendMessageEventAnswer", { event_id: String(raw.eventId), user_id: String(raw.userId), peer_id: String(raw.peerId) }, signal);
  }
}

function safe(p: unknown): string {
  try { const v = typeof p === "string" ? JSON.parse(p) : p; return String((v as any)?.p ?? v ?? ""); } catch { return String(p ?? ""); }
}
