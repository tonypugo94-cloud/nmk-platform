import { z } from "zod";
import { defineEvent, uuid } from "./registry.js";

export const TrackingEvents = {
  cargoCreated: defineEvent("tracking.cargo_created", z.object({ orderId: uuid, units: z.number() })),
  scanned: defineEvent("tracking.scanned", z.object({
    orderId: uuid, cargoUnitId: uuid, station: z.string(), action: z.enum(["take", "done"]), by: z.string().nullish(),
  })),
} as const;
