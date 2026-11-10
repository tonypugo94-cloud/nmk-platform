import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { db, rows, rpc } from "../lib/supabase";
import { fmtDate, fmtKg, fmtTime, slackBadge } from "../lib/format";
import { Qr } from "../components/Qr";
import { geo, takeAndUpload } from "../lib/photo";
import { newId } from "../lib/supabase";
import { useModules } from "../lib/modules";

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: string, n: number) => iso(new Date(new Date(d + "T12:00:00").getTime() + n * 86_400_000));
const monday = () => { const d = new Date(); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return iso(d); };
const dayTitle = (d: string) => new Date(d + "T12:00:00").toLocaleDateString("ru-RU", { weekday: "short", day: "numeric", month: "short" });
const confirmTitle: Record<string, [string, string]> = {
  not_sent: ["не отправлено", ""], sent: ["ждём ответ", "amber"], confirmed: ["подтверждено", "green"], call_me: ["позвонить", "red"], other_date: ["другая дата", "amber"], declined: ["отказ", "red"],
};

/* ─── Установки: календарь «направление × день» ────────────────────────────────── */
export function PlanningPage() {
  const qc = useQueryClient();
  const [week, setWeek] = useState(monday());
  const days = useMemo(() => Array.from({ length: 6 }, (_, i) => addDays(week, i)), [week]);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [err, setErr] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries();
  const { data: slots = [] } = useQuery({ queryKey: ["slots", week], queryFn: () => rows<any>(db("planning").from("api_slots").select("*").gte("day", days[0]).lte("day", days[5])) });
  const { data: asg = [] } = useQuery({ queryKey: ["asg", week], queryFn: () => rows<any>(db("planning").from("api_assignments").select("*").gte("day", days[0]).lte("day", days[5]).order("seq")) });
  const { data: ready = [] } = useQuery({ queryKey: ["ready"], queryFn: () => rows<any>(db("planning").from("api_ready_unplanned").select("*")) });
  const { data: dirs = [] } = useQuery({ queryKey: ["dirs"], queryFn: () => rows<any>(db("core").from("directions").select("*").eq("active", true).order("sort").order("name")) });
  const { data: vehicles = [] } = useQuery({ queryKey: ["vehicles"], queryFn: () => rows<any>(db("core").from("vehicles").select("*").eq("active", true).order("capacity_kg")) });
  const { data: weather = [] } = useQuery({ queryKey: ["weather", week], queryFn: () => rows<any>(db("weather").from("forecasts").select("*").gte("day", days[0]).lte("day", days[5])) });
  const { data: modules = [] } = useModules();
  const autoplanOn = modules.some((m) => m.key === "autoplanner" && m.enabled);
  const { data: lastRun } = useQuery({ queryKey: ["autoplan-last"], enabled: autoplanOn, refetchInterval: 15_000,
    queryFn: async () => (await rows<any>(db("autoplan").from("api_last_run").select("*")))[0] ?? null });
  const run = async (f: () => Promise<unknown>) => { setErr(null); try { await f(); refresh(); } catch (e) { setErr((e as Error).message); } };
  const badWx = (w: any) => w && (w.category === "heavy_rain" || (w.precip_prob ?? 0) >= 80);
  const triggerTitle: Record<string, string> = { daily: "ежедневная сборка", event: "дособрано по событию", manual: "собрано вручную" };

  const assign = (orderId: string, dirId: string | null) => run(async () => {
    const day = prompt(`Дата установки (ГГГГ-ММ-ДД)`, days[0]); if (!day) return;
    const free = vehicles.filter((v) => !slots.some((s) => s.day === day && s.vehicle_id === v.id && s.direction_id !== dirId));
    const existing = slots.find((s) => s.day === day && s.direction_id === dirId);
    let slotId = existing?.id;
    if (!slotId) {
      const v = prompt(`Машина:\n${free.map((v, i) => `${i + 1}. ${v.kind} ${v.plate} (${v.capacity_kg} кг)`).join("\n")}`, "1"); if (!v) return;
      slotId = await rpc("planning", "ensure_slot", { p_day: day, p_direction: dirId, p_vehicle: free[Number(v) - 1]?.id });
    }
    const r = await rpc("planning", "assign", { p_order: orderId, p_slot: slotId });
    if (r.overload) alert(`Перегруз: ${r.loadKg} из ${r.capacityKg} кг`);
  });

  return (
    <>
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 12 }}>
        <div><h1>Установки · неделя с {fmtDate(week)}</h1><p className="sub" style={{ margin: 0 }}>Загрузка по весу изделий. Пятница — резерв для переносов.</p></div>
        <div className="row">
          <button onClick={() => setWeek(addDays(week, -7))} aria-label="Предыдущая неделя">‹</button>
          <button onClick={() => setWeek(addDays(week, 7))} aria-label="Следующая неделя">›</button>
          <button className="primary" disabled={!sel.size} onClick={() => run(async () => { const n = await rpc("planning", "request_confirmation", { p_orders: [...sel] }); setSel(new Set()); alert(`Отправлено клиентам: ${n}`); })}>
            Отправить на подтверждение ({sel.size})</button>
        </div>
      </div>
      {err && <div className="err" style={{ marginBottom: 8 }}>{err}</div>}
      {autoplanOn && (
        <section className="card" style={{ marginBottom: 12 }}>
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div>
              <b>Автоплан</b>{" "}
              {lastRun ? <span className="muted">
                · {triggerTitle[lastRun.trigger] ?? lastRun.trigger} {fmtTime(lastRun.started_at)}
                {lastRun.target_days?.length ? ` · на ${lastRun.target_days.map(dayTitle).join(", ")}` : ""}
                {` · поставлено заказов: ${lastRun.planned}`}</span>
                : <span className="muted">· ещё не запускался</span>}
              {lastRun?.error && <div className="err">Ошибка: {lastRun.error}</div>}
            </div>
            <button onClick={() => run(async () => { await rpc("autoplan", "request_run", {}); alert("Запрос отправлен — план обновится через несколько секунд"); })}>Собрать план сейчас</button>
          </div>
          {lastRun?.skipped?.length > 0 && (
            <details style={{ marginTop: 6 }}><summary>Не поставлено: {lastRun.skipped.length}</summary>
              <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>{lastRun.skipped.map((x: any) => <li key={x.orderId}><b>{x.number}</b> — {x.reason}</li>)}</ul>
            </details>)}
          <p className="sub" style={{ margin: "6px 0 0" }}>Система каждый день собирает машины на послезавтра с учётом погоды и сроков и сама просит клиентов подтвердить дату. Утром проверьте план и позвоните тем, кто не ответил.</p>
        </section>
      )}
      <div className="wrap"><table className="table" style={{ minWidth: 980 }}>
        <thead><tr><th>Направление</th>{days.map((d) => {
          const fri = new Date(d + "T12:00:00").getDay() === 5;
          return <th key={d} style={{ background: fri ? "#EEF0F3" : undefined }}>{dayTitle(d)}{fri ? " · резерв" : ""}</th>;
        })}</tr></thead>
        <tbody>{dirs.map((dir) => (
          <tr key={dir.id}><td><b>{dir.name}</b></td>{days.map((d) => {
            const w = weather.find((x) => x.direction_id === dir.id && x.day === d);
            return (
              <td key={d} style={{ verticalAlign: "top", minWidth: 150 }}>
                {w && <div className={badWx(w) ? "err" : "muted"} style={{ fontSize: 12, color: !badWx(w) && (w.precip_prob ?? 0) >= 60 ? "var(--amber)" : undefined }} title={w.confidence ? `уверенность прогноза: ${w.confidence}` : undefined}>
                  {w.summary ?? `осадки ${w.precip_prob}%`}</div>}
                {slots.filter((s) => s.direction_id === dir.id && s.day === d).map((s) => (
                  <div key={s.id} className="card" style={{ padding: 8, marginTop: 4, borderColor: s.overload ? "var(--red)" : undefined }}>
                    <b style={{ fontSize: 13 }}>{s.vehicle}</b>
                    <div style={{ height: 6, background: "#EEF0F3", borderRadius: 3, margin: "6px 0" }}>
                      <div style={{ height: 6, borderRadius: 3, width: `${Math.min(100, (s.load_kg / s.capacity_kg) * 100)}%`, background: s.overload ? "var(--red)" : "var(--accent)" }} /></div>
                    <div style={{ fontSize: 12 }} className={s.overload ? "err" : "muted"}>{fmtKg(s.load_kg)} из {fmtKg(s.capacity_kg)}</div>
                    {asg.filter((a) => a.slot_id === s.id).map((a) => { const [t, c] = confirmTitle[a.confirm_status] ?? [a.confirm_status, ""]; return (
                      <label key={a.id} style={{ display: "flex", gap: 6, fontSize: 13, marginTop: 4 }}>
                        <input type="checkbox" style={{ minHeight: 0 }} checked={sel.has(a.order_id)} onChange={(e) => { const n = new Set(sel); e.target.checked ? n.add(a.order_id) : n.delete(a.order_id); setSel(n); }} />
                        <span>{a.number} <span className={`badge ${c}`} style={{ fontSize: 11 }}>{t}</span></span></label>); })}
                    <Link to={`/planning/waybill/${s.id}`} style={{ fontSize: 13 }}>Накладная</Link>
                  </div>
                ))}
              </td>);
          })}</tr>
        ))}</tbody>
      </table></div>
      <h2 style={{ fontSize: 18, marginTop: 20 }}>Готовы к установке, без даты · {ready.length}</h2>
      <div className="wrap"><table className="table"><tbody>{ready.map((r) => { const b = slackBadge(r.days_left); return (
        <tr key={r.order_id}><td><b>{r.number}</b></td><td>{r.customer_name}</td><td>{r.direction ?? <span className="badge amber">нет направления</span>}</td><td>{r.cemetery}</td><td>{fmtKg(r.weight_kg)}</td>
          <td><span className={`badge ${b.cls}`}>{b.text}</span></td><td><button onClick={() => assign(r.order_id, r.direction_id)} disabled={!r.direction_id}>В машину</button></td></tr>); })}</tbody></table></div>
    </>
  );
}

export function WaybillPage() {
  const { slotId } = useParams();
  const [w, setW] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  return (
    <>
      <div className="noprint row" style={{ marginBottom: 12 }}>
        <Link to="/planning">← Установки</Link>
        <button className="primary" onClick={async () => { try { setW(await rpc("planning", "print_waybill", { p_slot: slotId })); setTimeout(() => window.print(), 100); } catch (e) { setErr((e as Error).message); } }}>
          Сформировать и печатать</button>
        <span className="muted">Печать накладной фиксирует состав и запускает погрузку. Накладная уходит на фаски.</span>
      </div>
      {err && <p className="err">{err}</p>}
      {w && <section>
        <h1>Накладная на экипаж {w.id}</h1>
        <p><b>{dayTitle(w.day)}</b> · {w.direction} · {w.vehicle}{w.crew ? ` · ${w.crew}` : ""} · {fmtKg(w.loadKg)} из {fmtKg(w.capacityKg)}{w.weather ? ` · ${w.weather}` : ""}</p>
        <table className="table"><thead><tr><th>#</th><th>Заказ</th><th>Клиент</th><th>Кладбище, участок</th><th>Состав</th><th>Обработка ✓</th></tr></thead>
          <tbody>{w.orders.map((o: any, i: number) => (
            <tr key={o.orderId}><td>{i + 1}</td><td><b>{o.number}</b></td><td>{o.customer}<br />{o.phone}</td><td>{o.cemetery}<br />{o.plot}</td>
              <td>{o.items?.map((it: any) => <div key={it.name}>{it.name} × {Number(it.qty)}</div>)}</td><td style={{ width: 90 }}></td></tr>))}</tbody></table>
      </section>}
    </>
  );
}

/* ─── Клиенты и боты ───────────────────────────────────────────────────────────── */
export function MessagingPage() {
  const [q, setQ] = useState("");
  const [qr, setQr] = useState<{ number: string; code: string } | null>(null);
  const [ev, setEv] = useState<string | null>(null);
  const { data: settings } = useQuery({ queryKey: ["msg-settings"], queryFn: async () => (await rows<any>(db("core").from("settings").select("value").eq("key", "messaging")))[0]?.value });
  const { data = [] } = useQuery({ queryKey: ["contacts"], refetchInterval: 60_000, queryFn: () => rows<any>(db("messaging").from("api_order_contacts").select("*").order("number")) });
  const { data: calls = [] } = useQuery({ queryKey: ["callbacks"], refetchInterval: 60_000, queryFn: () => rows<any>(db("core").from("order_events").select("id, order_id, payload, occurred_at").eq("type", "callback.requested").gte("occurred_at", new Date(Date.now() - 3 * 86_400_000).toISOString()).order("occurred_at", { ascending: false })) });
  const { data: evidence = [] } = useQuery({ queryKey: ["evidence", ev], enabled: !!ev, queryFn: () => rows<any>(db("messaging").from("api_evidence").select("*").eq("order_id", ev!).order("created_at")) });
  const list = data.filter((c) => !q || c.number.includes(q) || c.customer_name?.toLowerCase().includes(q.toLowerCase()));
  const link = (code: string) => `${settings?.maxBotUrl ?? "https://max.ru/<бот>"}?start=${code}`;
  return (
    <>
      <h1>Клиенты и боты</h1>
      {calls.length > 0 && <section className="card" style={{ marginBottom: 16, borderColor: "var(--red)" }}>
        <h2 style={{ marginTop: 0, fontSize: 17 }}>Позвонить · {calls.length}</h2>
        {calls.map((c) => <div key={c.id}>{fmtTime(c.occurred_at)} — {data.find((x) => x.order_id === c.order_id)?.number ?? "заказ"}: {c.payload.reason}</div>)}
      </section>}
      <input placeholder="Номер заказа или клиент" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginBottom: 12, minWidth: 300 }} />
      <div className="wrap"><table className="table">
        <thead><tr><th>Заказ</th><th>Клиент</th><th>Бот</th><th>Последнее сообщение</th><th></th></tr></thead>
        <tbody>{list.map((c) => (
          <tr key={c.order_id}><td><b>{c.number}</b></td><td>{c.customer_name}</td>
            <td>{c.subscribed ? <span className="badge green">{c.channels}</span> : <span className="badge">не подключён</span>}{Number(c.undelivered) ? <span className="badge red"> не доставлено {c.undelivered}</span> : null}</td>
            <td>{fmtTime(c.last_message_at)}</td>
            <td className="row">
              <button onClick={async () => setQr({ number: c.number, code: await rpc("messaging", "create_link_code", { p_order: c.order_id }) })}>QR для клиента</button>
              <button onClick={() => setEv(c.order_id)}>Переписка</button></td></tr>))}</tbody>
      </table></div>
      {qr && <section className="card" style={{ marginTop: 16 }}>
        <h2 style={{ marginTop: 0, fontSize: 17 }}>Подключение к заказу № {qr.number}</h2>
        <div className="row"><Qr value={link(qr.code)} size={180} /><div>Клиент сканирует QR телефоном и нажимает «Старт».<br />VK: vk.me/{settings?.vkGroup ?? "<группа>"}?ref={qr.code}<br /><button onClick={() => window.print()}>Печать</button></div></div>
      </section>}
      {ev && <section className="card" style={{ marginTop: 16 }}>
        <h2 style={{ marginTop: 0, fontSize: 17 }}>Переписка и доказательства</h2>
        <table className="table"><thead><tr><th>Сообщение</th><th>Канал</th><th>Отправлено</th><th>Доставлено</th><th>Прочитано</th></tr></thead>
          <tbody>{evidence.map((m) => <tr key={m.message_id}><td><b>{m.title}</b><div className="muted">{m.body}</div></td><td>{m.channel}</td><td>{fmtTime(m.sent_at)}</td><td>{fmtTime(m.delivered_at)}</td><td>{fmtTime(m.read_at)}</td></tr>)}</tbody></table>
        <button onClick={() => window.print()}>Печать для претензии</button>
      </section>}
    </>
  );
}

/* ─── Закупки ──────────────────────────────────────────────────────────────────── */
export function ProcurementPage() {
  const qc = useQueryClient();
  const { data: drafts = [] } = useQuery({ queryKey: ["drafts"], queryFn: () => rows<any>(db("procurement").from("drafts").select("*, suppliers(name), draft_lines(qty, stock_qty, demand_qty, catalog_items(name))").in("status", ["draft", "approved"]).order("created_at", { ascending: false })) });
  const act = async (fn: string, args: Record<string, unknown>) => { try { await rpc("procurement", fn, args); qc.invalidateQueries({ queryKey: ["drafts"] }); } catch (e) { alert((e as Error).message); } };
  return (
    <>
      <h1>Заявки поставщикам</h1>
      <p className="sub">Система считает потребность по заказам и остаткам 1С. Без утверждения ничего не заказывается.</p>
      <div className="grid2">{drafts.map((d) => (
        <section key={d.id} className="card">
          <div className="row" style={{ justifyContent: "space-between" }}><h2 style={{ margin: 0, fontSize: 18 }}>{d.suppliers?.name}</h2>
            <span className={`badge ${d.status === "approved" ? (d.eta < new Date().toISOString().slice(0, 10) ? "red" : "blue") : "amber"}`}>{d.status === "approved" ? `ждём к ${fmtDate(d.eta)}` : "черновик"}</span></div>
          <table className="table"><tbody>{d.draft_lines.map((l: any) => (
            <tr key={l.catalog_items?.name}><td>{l.catalog_items?.name}</td><td className="muted">остаток {Number(l.stock_qty)}, спрос {Number(l.demand_qty)}</td><td><b>{Number(l.qty)}</b></td></tr>))}</tbody></table>
          <div className="row" style={{ marginTop: 10 }}>
            {d.status === "draft" && <button className="primary" onClick={() => act("approve", { p_draft: d.id })}>Утвердить</button>}
            {d.status === "approved" && <button onClick={() => act("mark_received", { p_draft: d.id })}>Поставка пришла</button>}
          </div>
        </section>))}</div>
      {!drafts.length && <p className="muted">Заявок нет — остатков хватает.</p>}
    </>
  );
}

/* ─── Выезд бригады ────────────────────────────────────────────────────────────── */
export function CrewPage() {
  const qc = useQueryClient();
  const [day, setDay] = useState(iso(new Date()));
  const [msg, setMsg] = useState<string | null>(null);
  const { data = [] } = useQuery({ queryKey: ["route", day], queryFn: () => rpc<any[]>("crew", "my_route", { p_day: day }) });
  const photo = async (orderId: string, kind: string) => {
    try {
      const p = await takeAndUpload(`orders/${orderId}`); if (!p) return;
      const g = await geo();
      await rpc("crew", "add_photo", { p_order: orderId, p_kind: kind, p_path: p.path, p_taken_at: p.takenAt, p_lat: g?.lat ?? null, p_lon: g?.lon ?? null, p_accuracy: g?.accuracy ?? null, p_client_id: newId() });
      setMsg("Фото сохранено");
    } catch (e) { setMsg((e as Error).message); }
  };
  const act = async (fn: string, args: Record<string, unknown>, ok: string) => { try { await rpc("crew", fn, args); setMsg(ok); qc.invalidateQueries({ queryKey: ["route"] }); } catch (e) { setMsg((e as Error).message); } };
  return (
    <>
      <h1>Выезд</h1>
      <input type="date" value={day} onChange={(e) => setDay(e.target.value)} />
      {msg && <p>{msg}</p>}
      {data.map((r) => (
        <section key={r.order_id} className="card" style={{ marginTop: 12 }}>
          <div className="row" style={{ justifyContent: "space-between" }}><b>{r.seq / 10}. № {r.number} · {r.customer}</b>{r.visit_status && <span className="badge green">{r.visit_status === "installed" ? "установлено" : "проблема"}</span>}</div>
          <div>{r.cemetery}, {r.plot} {r.lat && <a href={`https://yandex.ru/maps/?rtext=~${r.lat},${r.lon}&rtt=auto`} target="_blank" rel="noreferrer">маршрут</a>}</div>
          {r.phone && <a href={`tel:${r.phone}`}>{r.phone}</a>}
          <ul>{r.items?.map((i: any) => <li key={i.name}>{i.name} × {Number(i.qty)}</li>)}</ul>
          <div className="row">
            <button onClick={() => photo(r.order_id, "before")}>Фото до</button>
            <button onClick={() => photo(r.order_id, "after")}>Фото после</button>
            <button className="primary" onClick={() => act("complete", { p_order: r.order_id }, "Отмечено: установлено")}>Установлено</button>
            <button onClick={() => { const t = prompt("Что случилось?"); if (t) void act("report_problem", { p_order: r.order_id, p_text: t }, "Проблема передана менеджеру"); }}>Проблема</button>
          </div>
        </section>
      ))}
      {!data.length && <p className="muted">На этот день выездов нет.</p>}
    </>
  );
}

/* ─── Сделка: ведомость ────────────────────────────────────────────────────────── */
export function PieceworkPage() {
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const { data = [] } = useQuery({ queryKey: ["statement", month], queryFn: () => rows<any>(db("piecework").from("api_statement").select("*").eq("month", `${month}-01`)) });
  const byWorker = Object.values(data.reduce((acc: any, r: any) => { (acc[r.user_id] ??= { worker: r.worker, rows: [], total: 0 }); acc[r.user_id].rows.push(r); acc[r.user_id].total += Number(r.amount); return acc; }, {})) as any[];
  return (
    <>
      <h1>Сдельная оплата · ведомость</h1>
      <div className="row noprint" style={{ marginBottom: 12 }}><input type="month" value={month} onChange={(e) => setMonth(e.target.value)} /><button onClick={() => window.print()}>Печать</button></div>
      {byWorker.map((w) => (
        <section key={w.worker} className="card" style={{ marginBottom: 12 }}>
          <div className="row" style={{ justifyContent: "space-between" }}><b>{w.worker}</b><b>{w.total.toLocaleString("ru-RU")} ₽</b></div>
          <table className="table"><tbody>{w.rows.map((r: any) => <tr key={r.operation}><td>{r.operation_title}</td><td>{Number(r.qty).toLocaleString("ru-RU")} {r.unit === "m" ? "п. м." : "шт"}</td><td>{Number(r.amount).toLocaleString("ru-RU")} ₽</td></tr>)}</tbody></table>
        </section>))}
      {!byWorker.length && <p className="muted">Отметок за месяц нет.</p>}
    </>
  );
}

/* ─── Сводка собственника ──────────────────────────────────────────────────────── */
export function OwnerPage() {
  const { data: s } = useQuery({ queryKey: ["summary"], refetchInterval: 300_000, queryFn: () => rpc<any>("analytics", "summary") });
  const { data: risk = [] } = useQuery({ queryKey: ["risk"], queryFn: () => rows<any>(db("analytics").from("api_risk").select("*").limit(15)) });
  const { data: weeks = [] } = useQuery({ queryKey: ["weeks"], queryFn: () => rows<any>(db("analytics").from("api_week_installs").select("*")) });
  const { data: reasons = [] } = useQuery({ queryKey: ["reasons"], queryFn: () => rows<any>(db("analytics").from("api_reschedule_reasons").select("*")) });
  if (!s) return <p className="muted">Загрузка…</p>;
  const max = Math.max(1, ...weeks.map((w) => Math.max(w.planned, w.installed)));
  const rub = (n: number) => `${Number(n).toLocaleString("ru-RU")} ₽`;
  const tiles = [
    ["Под риском неустойки", rub(s.riskRub), `${s.riskOrders} заказ(ов)`, s.riskOrders > 0],
    ["Готово, не установлено", `${s.readyWaiting} шт`, `в среднем ${s.readyWaitingAvgDays ?? 0} дн. · ${rub(s.readyWaitingRub)}`, false],
    ["Установки, прошлая неделя", `${s.week?.installed ?? 0} из ${s.week?.planned ?? 0}`, `текущая: ${s.currentWeek?.installed ?? 0} из ${s.currentWeek?.planned ?? 0}`, false],
    ["Клиенты в ботах", `${s.botShare ?? 0}%`, `подтверждают за ${s.confirmHoursMedian ?? "—"} ч`, false],
  ] as const;
  return (
    <>
      <h1>Сводка</h1>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12, marginBottom: 16 }}>
        {tiles.map(([t, v, n, red]) => <div key={t} className="card" style={{ borderColor: red ? "var(--red)" : undefined }}><div className="muted">{t}</div><div style={{ fontSize: 28, fontWeight: 700 }} className={red ? "err" : ""}>{v}</div><div className="muted">{n}</div></div>)}
      </div>
      <div className="grid2">
        <section className="card"><h2 style={{ marginTop: 0, fontSize: 17 }}>Установки по неделям: план и факт</h2>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 10, height: 160 }}>{weeks.map((w) => (
            <div key={w.week} style={{ flex: 1, textAlign: "center" }}>
              <div style={{ display: "flex", gap: 2, alignItems: "flex-end", height: 130, justifyContent: "center" }}>
                <div title={`план ${w.planned}`} style={{ width: 12, height: `${(w.planned / max) * 100}%`, background: "#C9CDD6", borderRadius: "3px 3px 0 0" }} />
                <div title={`факт ${w.installed}`} style={{ width: 12, height: `${(w.installed / max) * 100}%`, background: "var(--accent)", borderRadius: "3px 3px 0 0" }} /></div>
              <div className="muted" style={{ fontSize: 11 }}>{fmtDate(w.week).slice(0, 5)}</div></div>))}</div></section>
        <section className="card"><h2 style={{ marginTop: 0, fontSize: 17 }}>Почему переносили</h2>
          {reasons.map((r) => <div key={r.reason} className="row" style={{ justifyContent: "space-between" }}><span>{r.reason}</span><b>{r.cnt}</b></div>)}
          {!reasons.length && <p className="muted">Переносов не было</p>}
          <h2 style={{ fontSize: 17 }}>Узкие места</h2>
          {s.hotStations.map((h: any) => <div key={h.station}>{h.station}: горит {h.hot}, в очереди {h.queued}</div>)}
          <p className="muted">Машины загружены на {s.vehicleLoadPct ?? 0}% · ниже минимума на складе: {s.stockBelowMin} · опаздывают поставки: {s.lateSupplies} · сделка за месяц: {rub(s.pieceworkMonthRub)}</p></section>
      </div>
      <section className="card" style={{ marginTop: 16 }}><h2 style={{ marginTop: 0, fontSize: 17 }}>Под риском неустойки</h2>
        <table className="table"><tbody>{risk.map((r) => <tr key={r.order_id}><td><b>{r.number}</b> · {r.direction ?? "—"}</td><td>{r.stage_title}{r.waiting_at ? `, ждёт: ${r.waiting_at}` : ""}</td><td>срок {fmtDate(r.due_date)}</td><td className="err"><b>{rub(r.penalty_rub)}</b></td></tr>)}</tbody></table></section>
    </>
  );
}
