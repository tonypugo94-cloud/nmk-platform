import { createClient } from "@supabase/supabase-js";

export const supabase = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});

/** Запрос к схеме модуля (PostgREST должен публиковать схемы: core, integration и схемы модулей). */
export const db = (schema: string) => supabase.schema(schema);

export async function rows<T>(q: PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data ?? [];
}

/** Вызов функции БД (RPC) в схеме модуля. Ошибка из БД показывается пользователю как есть — тексты там по-русски. */
export async function rpc<T = any>(schema: string, fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.schema(schema).rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

export const newId = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now());
