import { z } from "zod";
import { defineEvent, uuid } from "./registry.js";

export const PlanningEvents = {
  waybillPrinted: defineEvent("waybill.printed", z.object({
    waybillId: z.string(), date: z.string(), vehicleId: uuid.nullable(), orderIds: z.array(uuid),
  })),
  installationPlanned: defineEvent("installation.planned", z.object({ orderId: uuid, date: z.string(), slotId: uuid, directionId: uuid.nullable() })),
  installationRescheduled: defineEvent("installation.rescheduled", z.object({ orderId: uuid, from: z.string(), to: z.string(), slotId: uuid })),
  installationCancelled: defineEvent("installation.cancelled", z.object({ orderId: uuid, reason: z.string() })),
  confirmationRequested: defineEvent("confirmation.requested", z.object({ orderId: uuid, assignmentId: uuid, date: z.string() })),
} as const;
