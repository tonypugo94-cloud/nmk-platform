import { z } from "zod";
import { defineEvent, uuid } from "./registry.js";

export const CrewEvents = {
  photoUploaded: defineEvent("photo.uploaded", z.object({ orderId: uuid, photoId: uuid, kind: z.string() })),
  installationCompleted: defineEvent("installation.completed", z.object({ orderId: uuid, photos: z.number() })),
  installationProblem: defineEvent("installation.problem", z.object({ orderId: uuid, text: z.string() })),
} as const;
