import { z } from "zod";
import { defineEvent, uuid } from "./registry.js";

export const ProcurementEvents = {
  draftCreated: defineEvent("procurement.draft_created", z.object({ draftId: uuid, supplierId: uuid })),
  approved: defineEvent("procurement.approved", z.object({ draftId: uuid })),
  supplyLate: defineEvent("supply.late", z.object({ draftId: uuid, supplierId: uuid, eta: z.string() })),
} as const;
