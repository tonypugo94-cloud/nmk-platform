export type Button = { text: string; payload: string };
export type Inbound = { chatId: string; kind: "start" | "text" | "button" | "delivered" | "read"; data: Record<string, unknown> };

/** Транспорт мессенджера: только отправка и разбор входящих. Никакой логики заказов. */
export interface Transport {
  readonly channel: "max" | "vk";
  send(chatId: string, text: string, buttons: Button[][], signal?: AbortSignal): Promise<{ externalId: string | null }>;
  /** Разобрать тело вебхука. reply — что ответить платформе (VK ждёт строку подтверждения). */
  parseWebhook(body: any, headers: Record<string, string | string[] | undefined>): { updates: Inbound[]; reply?: string; authorized: boolean };
  /** Ответ на нажатие кнопки, если платформа этого требует. */
  ackButton?(raw: Record<string, unknown>, signal?: AbortSignal): Promise<void>;
}
