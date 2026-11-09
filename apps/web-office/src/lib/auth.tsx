import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { db, supabase } from "./supabase";

type Me = { session: Session | null; fullName: string; roles: string[]; loading: boolean };
const Ctx = createContext<Me>({ session: null, fullName: "", roles: [], loading: true });

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me>({ session: null, fullName: "", roles: [], loading: true });

  useEffect(() => {
    const load = async (session: Session | null) => {
      if (!session) return setMe({ session: null, fullName: "", roles: [], loading: false });
      const uid = session.user.id;
      const [{ data: p }, { data: r }] = await Promise.all([
        db("core").from("profiles").select("full_name").eq("user_id", uid).maybeSingle(),
        db("core").from("user_roles").select("role_code").eq("user_id", uid),
      ]);
      setMe({ session, fullName: p?.full_name ?? session.user.email ?? "", roles: (r ?? []).map((x) => x.role_code), loading: false });
    };
    supabase.auth.getSession().then(({ data }) => load(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => void load(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  return <Ctx.Provider value={me}>{children}</Ctx.Provider>;
}

export const useMe = () => useContext(Ctx);
export const hasAny = (roles: string[], need?: string[]) => !need?.length || roles.includes("admin") || need.some((r) => roles.includes(r));
