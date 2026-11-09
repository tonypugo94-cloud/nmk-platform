import { z } from "zod";
import { defineEvent, uuid } from "./registry.js";

export const PieceworkEvents = {
  recorded: defineEvent("piecework.recorded", z.object({
    orderId: uuid, recordId: z.number(), operation: z.string(), qty: z.number(), amount: z.number(), userId: z.string().nullish(),
  })),
  statementReady: defineEvent("piecework.statement_ready", z.object({ month: z.string(), totalRub: z.number(), workers: z.number() })),
} as const;
