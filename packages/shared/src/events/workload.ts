import { z } from "zod";
import { defineEvent, uuid } from "./registry.js";

export const WorkloadEvents = {
  riskDetected: defineEvent("workload.risk_detected", z.object({ orderId: uuid, number: z.string(), slackDays: z.number() })),
} as const;
