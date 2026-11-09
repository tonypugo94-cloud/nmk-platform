import { z } from "zod";

const registry = new Map<string, z.ZodTypeAny>();

export function defineEvent<T extends z.ZodTypeAny>(type: string, schema: T) {
  if (!/^[a-z0-9_]+(\.[a-z0-9_]+)+$/.test(type)) throw new Error(`bad event type: ${type}`);
  registry.set(type, schema);
  return { type, schema } as const;
}

export function eventSchema(type: string): z.ZodTypeAny | undefined {
  return registry.get(type);
}

export const uuid = z.string().uuid();
export const orderKey = (orderId: string) => `order:${orderId}`;
