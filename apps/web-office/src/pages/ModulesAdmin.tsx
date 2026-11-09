import { useQueryClient } from "@tanstack/react-query";
import { useModules } from "../lib/modules";
import { db } from "../lib/supabase";
import { fmtTime } from "../lib/format";

export function ModulesAdmin() {
  const { data = [], error } = useModules();
  const qc = useQueryClient();
  const toggle = async (key: string, enabled: boolean) => {
    await db("core").from("app_modules").update({ enabled }).eq("key", key);
    qc.invalidateQueries({ queryKey: ["modules"] });
  };
  return (
    <>
      <h1>Модули системы</h1>
      <p className="sub">Сервис модуля регистрируется сам при запуске. Включённый модуль появляется в меню у ролей, которым он доступен.</p>
      {error && <div className="err">{String(error)}</div>}
      <div className="wrap"><table className="table">
        <thead><tr><th>Модуль</th><th>Версия</th><th>Сервис</th><th>Зависит от</th><th>Включён</th></tr></thead>
        <tbody>{data.map((m) => (
          <tr key={m.key}>
            <td><b>{m.title}</b><div className="muted">{m.description}</div></td>
            <td>{m.version}</td>
            <td>{m.alive ? <span className="badge green">работает</span> : <span className="badge red">нет связи с {fmtTime(m.heartbeat_at)}</span>}</td>
            <td>{m.depends_on.join(", ") || "—"}</td>
            <td><input type="checkbox" checked={m.enabled} onChange={(e) => toggle(m.key, e.target.checked)} aria-label={`Включить ${m.title}`} style={{ minHeight: 0 }} /></td>
          </tr>
        ))}</tbody>
      </table></div>
    </>
  );
}
