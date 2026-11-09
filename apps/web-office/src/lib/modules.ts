import { useQuery } from "@tanstack/react-query";
import { db, rows } from "./supabase";
import { hasAny, useMe } from "./auth";

export type ModuleRow = {
  key: string; title: string; description: string | null; version: string; enabled: boolean; alive: boolean;
  roles: string[]; depends_on: string[]; menu: { path: string; title: string; roles?: string[] }[]; heartbeat_at: string | null;
};

export function useModules() {
  return useQuery({ queryKey: ["modules"], queryFn: () => rows<ModuleRow>(db("core").from("api_modules").select("*").order("key")), refetchInterval: 60_000 });
}

/** Пункты меню из включённых модулей, доступных роли пользователя. */
export function useMenu() {
  const { roles } = useMe();
  const { data = [] } = useModules();
  return data
    .filter((m) => m.enabled && hasAny(roles, m.roles))
    .flatMap((m) => m.menu.filter((i) => hasAny(roles, i.roles ?? m.roles)).map((i) => ({ ...i, module: m.key, alive: m.alive })));
}
