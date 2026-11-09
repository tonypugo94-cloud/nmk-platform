import { useQuery } from "@tanstack/react-query";
import { db, rows } from "../lib/supabase";
import { fmtTime } from "../lib/format";

type S = { kind: string; last_success_at: string | null; last_ok: boolean | null; last_error: string | null; failed_orders: number };

/** Честная деградация: если обмен с 1С отстал или упал — пользователь видит, на какой момент данные. */
export function SyncBanner() {
  const { data } = useQuery({
    queryKey: ["sync-status"], refetchInterval: 30_000,
    queryFn: () => rows<S>(db("integration").from("api_sync_status").select("*").eq("kind", "orders")),
  });
  const s = data?.[0];
  if (!s) return null;
  const stale = !s.last_success_at || Date.now() - new Date(s.last_success_at).getTime() > 10 * 60_000;
  if (s.last_ok !== false && !stale && !Number(s.failed_orders)) return null;
  if (s.last_ok === false || stale)
    return <div className="banner warn">Нет связи с 1С. Данные заказов на {fmtTime(s.last_success_at)}. Работать можно, новые заказы появятся после восстановления связи.</div>;
  return <div className="banner warn">{s.failed_orders} заказ(ов) из 1С не загрузились, повторим автоматически. Подробности — у администратора.</div>;
}
