import { z } from "zod";
import { defineEvent } from "./registry.js";

export const WeatherEvents = {
  updated: defineEvent("weather.updated", z.object({ directions: z.number(), days: z.number() })),
  failed: defineEvent("weather.failed", z.object({ error: z.string() })),
} as const;
