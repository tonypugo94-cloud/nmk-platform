import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router-dom";
import { db, rows } from "../lib/supabase";
import { fmtDate, fmtKg, fmtTime, slackBadge } from "../lib/format";

type Order = {
  id: string; number: string; order_date: string | null; due_date: string | null; days_left: number | null; status: string;
  stage_code: string; stage_title: string; stage_source: string; customer_name: string | null; customer_phone: string | null;
  cemetery: string | null; plot: string | null; direction: string | null; weight_kg: number; amount: number | null; notes: string | null; synced_at: string | null;
};

export function OrdersPage() {
  const nav = useNavigate();
  const [q, setQ] = useState(""); const [stage, setStage] = useState(""); const [onlyOpen, setOnlyOpen] = useState(true);
  const { data: stages = [] } = useQuery({ queryKey: ["stages"], queryFn: () => rows<{ code: string; title: string }>(db("core").from("stages").select("code,title").order("sort")) });
  const { data = [], isLoading, error } = useQuery({
    queryKey: ["orders", onlyOpen], refetchInterval: 30_000,
    queryFn: () => {
      let req = db("core").from("api_orders").select("*").order("due_date", { ascending: true, nullsFirst: false }).limit(1000);
      if (onlyOpen) req = req.eq("status", "open");
      return rows<Order>(req);
    },
  });
  const list = useMemo(() => data.filter((o) =>
    (!stage || o.stage_code === stage) &&
    (!q || [o.number, o.customer_name, o.cemetery, o.direction].some((v) => v?.toLowerCase().includes(q.toLowerCase())))), [data, q, stage]);
  const overdue = data.filter((o) => (o.days_left ?? 1) < 0 && o.status === "open").length;
  const hot = data.filter((o) => o.days_left !== null && o.days_left >= 0 && o.days_left <= 2).length;

  return (
    <>
      <h1>Заказы по сроку</h1>
      <p className="sub">Сверху то, что горит. Стадию меняют в 1С, сюда она приходит сама в течение пары минут.</p>
      <div className="row" style={{ marginBottom: 16 }}>
        <span className="badge red">просрочено: {overdue}</span>
        <span className="badge amber">горит (≤ 2 дней): {hot}</span>
        <input placeholder="Номер, клиент, кладбище, направление" value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 300 }} />
        <select value={stage} onChange={(e) => setStage(e.target.value)} aria-label="Стадия">
          <option value="">Все стадии</option>{stages.map((s) => <option key={s.code} value={s.code}>{s.title}</option>)}
        </select>
        <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={onlyOpen} onChange={(e) => setOnlyOpen(e.target.checked)} style={{ minHeight: 0 }} />только открытые</label>
      </div>
      {error && <div className="err">{String(error)}</div>}
      <div className="wrap"><table className="table">
        <thead><tr><th>Заказ</th><th>Клиент</th><th>Кладбище</th><th>Направление</th><th>Стадия</th><th>Срок</th><th>Запас</th><th>Вес</th></tr></thead>
        <tbody>
          {isLoading && <tr><td colSpan={8} className="muted">Загрузка…</td></tr>}
          {list.map((o) => { const b = slackBadge(o.days_left); return (
            <tr key={o.id} className="click" onClick={() => nav(`/orders/${o.id}`)}>
              <td><b>{o.number}</b></td><td>{o.customer_name ?? "—"}</td><td>{o.cemetery ?? "—"}</td><td>{o.direction ?? <span className="badge amber">не задано</span>}</td>
              <td><span className="badge">{o.stage_title}</span></td><td>{fmtDate(o.due_date)}</td>
              <td>{o.status === "open" ? <span className={`badge ${b.cls}`}>{b.text}</span> : <span className="badge">закрыт</span>}</td><td>{fmtKg(o.weight_kg)}</td>
            </tr>); })}
          {!isLoading && !list.length && <tr><td colSpan={8} className="muted">Ничего не найдено</td></tr>}
        </tbody>
      </table></div>
    </>
  );
}

const sourceTitle: Record<string, string> = { onec: "из 1С", manual: "вручную", tracking: "скан на участке" };
const eventTitle: Record<string, string> = {
  "order.upserted": "Данные заказа обновлены", "order.stage_changed": "Смена стадии", "order.ready_for_install": "Готов к установке",
  "order.closed": "Заказ закрыт", "order.cemetery_unmatched": "Кладбище не найдено в справочнике",
};

export function OrderCardPage() {
  const { id } = useParams();
  const { data: o } = useQuery({ queryKey: ["order", id], queryFn: async () => (await rows<Order>(db("core").from("api_orders").select("*").eq("id", id!)))[0] });
  const { data: items = [] } = useQuery({ queryKey: ["order-items", id], queryFn: () => rows<any>(db("core").from("api_order_items").select("*").eq("order_id", id!).order("line_no")) });
  const { data: journal = [] } = useQuery({ queryKey: ["order-events", id], refetchInterval: 30_000,
    queryFn: () => rows<any>(db("core").from("order_events").select("*").eq("order_id", id!).order("occurred_at", { ascending: false }).limit(200)) });
  if (!o) return <p className="muted">Загрузка…</p>;
  const b = slackBadge(o.days_left);
  return (
    <>
      <p className="noprint"><Link to="/orders">← Все заказы</Link></p>
      <h1>Заказ {o.number}</h1>
      <p className="sub"><span className="badge">{o.stage_title}</span> <span className="muted">({sourceTitle[o.stage_source] ?? o.stage_source})</span> · срок {fmtDate(o.due_date)} {o.status === "open" && <span className={`badge ${b.cls}`}>{b.text}</span>}</p>
      <div className="grid2">
        <section className="card"><h2 style={{ marginTop: 0, fontSize: 17 }}>Клиент и место</h2>
          <dl className="kv">
            <dt>Клиент</dt><dd>{o.customer_name ?? "—"}</dd><dt>Телефон</dt><dd>{o.customer_phone ? <a href={`tel:${o.customer_phone}`}>{o.customer_phone}</a> : "—"}</dd>
            <dt>Кладбище</dt><dd>{o.cemetery ?? "—"}</dd><dt>Участок</dt><dd>{o.plot ?? "—"}</dd><dt>Направление</dt><dd>{o.direction ?? "—"}</dd>
            <dt>Синхронизирован</dt><dd>{fmtTime(o.synced_at)}</dd>
          </dl></section>
        <section className="card"><h2 style={{ marginTop: 0, fontSize: 17 }}>Состав · {fmtKg(o.weight_kg)}</h2>
          <table className="table"><tbody>{items.map((i) => (
            <tr key={i.id}><td>{i.name}</td><td>{Number(i.qty)} шт</td><td>{fmtKg(i.weight_kg)}</td></tr>))}</tbody></table></section>
      </div>
      <section className="card" style={{ marginTop: 16 }}><h2 style={{ marginTop: 0, fontSize: 17 }}>История заказа</h2>
        <table className="table"><tbody>{journal.map((e) => (
          <tr key={e.id}><td style={{ whiteSpace: "nowrap" }}>{fmtTime(e.occurred_at)}</td>
            <td>{eventTitle[e.type] ?? e.type}{e.type === "order.stage_changed" ? `: ${e.payload.from} → ${e.payload.to} (${sourceTitle[e.payload.source] ?? e.payload.source})` : ""}</td>
            <td className="muted">{e.source}</td></tr>))}</tbody></table></section>
    </>
  );
}
