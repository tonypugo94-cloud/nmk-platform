import { z } from "zod";
import { defineEvent, uuid } from "./registry.js";

export const MessagingEvents = {
  confirmationAnswered: defineEvent("confirmation.answered", z.object({
    orderId: uuid, answer: z.enum(["confirmed", "other_date", "call_me", "declined"]), date: z.string().nullish(), channel: z.string(),
  })),
  callbackRequested: defineEvent("callback.requested", z.object({ orderId: uuid, reason: z.string() })),
  viewingInviteRequested: defineEvent("viewing.invite_requested", z.object({ orderId: uuid, until: z.string().nullish() })),
  messageSent: defineEvent("message.sent", z.object({ messageId: uuid, orderId: uuid.nullable(), channel: z.string(), template: z.string() })),
  messageDelivered: defineEvent("message.delivered", z.object({ messageId: uuid, orderId: uuid.nullable() })),
  messageRead: defineEvent("message.read", z.object({ messageId: uuid, orderId: uuid.nullable() })),
  messageFailed: defineEvent("message.failed", z.object({ messageId: uuid, orderId: uuid.nullable(), error: z.string() })),
  digestReady: defineEvent("analytics.digest_ready", z.object({ text: z.string(), week: z.string() })),
} as const;
