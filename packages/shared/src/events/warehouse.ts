import { z } from "zod";
import { defineEvent, uuid } from "./registry.js";

export const WarehouseEvents = {
  placed: defineEvent("storage.placed", z.object({ orderId: uuid, cargoUnitId: uuid, place: z.string(), depth: z.number() })),
  loadItemScanned: defineEvent("load.item_scanned", z.object({ loadId: uuid, orderId: uuid, cargoUnitId: uuid, scanned: z.number(), total: z.number() })),
  loadCompleted: defineEvent("load.completed", z.object({ loadId: uuid, missing: z.array(z.any()), reason: z.string().nullish() })),
  loadIncomplete: defineEvent("load.incomplete", z.object({ loadId: uuid, missing: z.array(z.any()), reason: z.string().nullish() })),
} as const;
