import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { db, newId, rows, rpc } from "../lib/supabase";
import { fmtDate, slackBadge } from "../lib/format";
import { Scanner } from "../components/Scanner";
import { Qr } from "../components/Qr";
import { useModules } from "../lib/modules";
import { takeAndUpload } from "../lib/photo";

/* ─── Бирки: печать QR на стелы и ярлыков на паллет-комплекты ─────────────────── */
export function LabelsPage() {
  const qc = useQueryClient();
  const [onlyNew, setOnlyNew] = useState(true);
  const { data = [] } = useQuery({ queryKey: ["labels", onlyNew], queryFn: () => {
    let q = db("tracking").from("api_labels").select("*").order("number").order("seq").limit(300);
    if (onlyNew) q = q.is("printed_at", null);
    return rows<any>(q);
  } });
  const markPrinted = async () => {
    await db("tracking").from("tags").update({ printed_at: new Date().toISOString() }).in("code", data.map((l) => l.tag_code));
    qc.invalidateQueries({ queryKey: ["labels"] });
  };
  return (
    <>
      <div className="noprint">
        <h1>Бирки и ярлыки</h1>
        <p className="sub">Один QR на стелу и один ярлык на паллет-комплект. Номер заказа на камне по-прежнему пишется маркером.</p>
        <div className="row" style={{ marginBottom: 16 }}>
          <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={onlyNew} onChange={(e) => setOnlyNew(e.target.checked)} style={{ minHeight: 0 }} />только ненапечатанные</label>
          <button className="primary" onClick={() => window.print()} disabled={!data.length}>Печать ({data.length})</button>
          <button onClick={markPrinted} disabled={!data.length}>Отметить напечатанными</button>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 12 }}>
        {data.map((l) => (
          <div key={l.tag_code} className="card" style={{ display: "flex", gap: 12, breakInside: "avoid" }}>
            <Qr value={l.tag_code} size={120} />
            <div>
              <div style={{ fontSize: 22, fontWeight: 700 }}>№ {l.number}</div>
              <div>{l.kind === "stela" ? "Стела" : "Комплект"} · место {l.seq} из {l.units_total}</div>
              <div className="muted">{l.direction ?? "—"} · срок {fmtDate(l.due_date)}</div>
              {l.kind === "kit" && <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>{l.contents.map((c: any) => <li key={c.orderItemId}>{c.name} × {Number(c.qty)}</li>)}</ul>}
              <div className="muted" style={{ fontFamily: "monospace" }}>{l.tag_code}</div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

/* ─── Участок: «Взял / Готово», для обработчиков — отметка операций сделки ───── */
export function StationPage() {
  const { data: stations = [] } = useQuery({ queryKey: ["stations"], queryFn: () => rows<any>(db("tracking").from("stations").select("*").eq("active", true).order("sort")) });
  const { data: modules = [] } = useModules();
  const piecework = modules.some((m) => m.key === "piecework" && m.enabled);
  const [station, setStation] = useState<string>(() => localStorage.getItem("station") ?? "");
  const [tag, setTag] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [opts, setOpts] = useState<any>(null);
  const { data: my } = useQuery({ queryKey: ["my-month", msg], enabled: piecework, queryFn: async () => (await rows<any>(db("piecework").from("api_my_month").select("*")))[0] });

  const act = async (action: "take" | "done") => {
    try {
      const r = await rpc("tracking", "record_scan", { p_tag: tag, p_station: station, p_action: action, p_client_scan_id: newId(), p_scanned_at: new Date().toISOString() });
      setMsg({ ok: true, text: `Заказ ${r.number}, место ${r.unit}: ${action === "take" ? "взял в работу" : "готово"}` });
      if (!(action === "done" && piecework)) setTag(null);
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
  };
  const loadOps = async (code: string) => { if (piecework) setOpts(await rpc("piecework", "options", { p_tag: code }).catch(() => null)); };
  const recordOp = async (item: any, op: any) => {
    let qty = op.qty;
    if (op.unit === "pcs" || qty == null) { const v = prompt(`${op.title}: количество`, "1"); if (!v) return; qty = Number(v.replace(",", ".")); }
    try {
      const photo = op.needsPhoto ? await takeAndUpload(`edges/${tag}`) : null;
      if (op.needsPhoto && !photo) return;
      const r = await rpc("piecework", "record", { p_tag: tag, p_order_item: item.orderItemId, p_operation: op.code, p_qty: qty, p_photo: photo?.path ?? null, p_client_id: newId() });
      setMsg({ ok: true, text: `${item.name}: ${op.title} — ${r.qty} ${op.unit === "m" ? "п. м." : "шт"}, ${r.amount} ₽` });
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
  };

  return (
    <>
      <h1>Участок</h1>
      <div className="row" style={{ marginBottom: 12 }}>
        <select value={station} onChange={(e) => { setStation(e.target.value); localStorage.setItem("station", e.target.value); }} aria-label="Участок">
          <option value="">Выберите участок</option>{stations.map((s) => <option key={s.code} value={s.code}>{s.title}</option>)}
        </select>
        {piecework && my && <span className="badge blue">За месяц: {Number(my.amount).toLocaleString("ru-RU")} ₽</span>}
      </div>
      {station && <Scanner onCode={(c) => { setTag(c); setMsg(null); void loadOps(c); }} />}
      {tag && (
        <div className="card" style={{ marginTop: 12 }}>
          <div className="row"><b style={{ fontFamily: "monospace", fontSize: 18 }}>{tag}</b>
            <button className="primary" onClick={() => act("take")}>Взял</button>
            <button className="primary" onClick={() => act("done")}>Готово</button>
            <button onClick={() => { setTag(null); setOpts(null); }}>Отмена</button></div>
          {opts?.items?.map((it: any) => (
            <div key={it.orderItemId} style={{ marginTop: 12 }}>
              <b>{it.name}</b>
              <div className="row" style={{ marginTop: 6 }}>{it.operations.map((op: any) => (
                <button key={op.code} onClick={() => recordOp(it, op)}>{op.title}{op.qty ? ` · ${op.qty} м` : ""}</button>))}</div>
            </div>
          ))}
        </div>
      )}
      {msg && <div className={`banner ${msg.ok ? "" : "err"}`} style={{ marginTop: 12, background: msg.ok ? "var(--green-bg)" : undefined, color: msg.ok ? "var(--green)" : undefined, borderRadius: 10 }}>{msg.text}</div>}
    </>
  );
}

/* ─── Участки: загрузка и очереди ─────────────────────────────────────────────── */
export function WorkloadPage() {
  const { data: load = [] } = useQuery({ queryKey: ["station-load"], refetchInterval: 60_000, queryFn: () => rows<any>(db("workload").from("api_station_load").select("*")) });
  const [st, setSt] = useState<string | null>(null);
  const { data: queue = [] } = useQuery({ queryKey: ["queue", st], enabled: !!st, queryFn: () => rows<any>(db("workload").from("api_queue").select("*").eq("station_code", st!)) });
  const { data: waiting = [] } = useQuery({ queryKey: ["ready-waiting"], queryFn: () => rows<any>(db("workload").from("api_ready_waiting").select("*").order("days_waiting", { ascending: false }).limit(20)) });
  return (
    <>
      <h1>Участки · сегодня</h1>
      <p className="sub">Очередь каждого участка — по запасу дней до установки. Красным — где заказы уже горят.</p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 12, marginBottom: 20 }}>
        {load.map((s) => {
          const pct = Math.round((Number(s.queue_hours) / Number(s.hours_per_day)) * 100);
          return (
            <button key={s.station_code} className="card" onClick={() => setSt(s.station_code)} style={{ textAlign: "left", borderColor: Number(s.hot) ? "var(--red)" : undefined, outline: st === s.station_code ? "2px solid var(--accent)" : undefined }}>
              <b>{s.title}</b>
              <div className="row" style={{ marginTop: 8 }}><span>в работе {s.in_work}</span><span>очередь {s.queued}</span><span className={Number(s.hot) ? "err" : ""}>горит {s.hot}</span></div>
              <div className="muted">{Number(s.queue_hours).toFixed(1)} ч очереди · {pct}% дневной мощности</div>
            </button>
          );
        })}
      </div>
      {st && (
        <div className="wrap" style={{ marginBottom: 20 }}><table className="table">
          <thead><tr><th>Заказ</th><th>Срок</th><th>Запас</th><th>Статус</th></tr></thead>
          <tbody>{queue.map((q) => { const b = slackBadge(q.slack_days); return (
            <tr key={q.cargo_unit_id}><td><b>{q.number}</b></td><td>{fmtDate(q.due_date)}</td><td><span className={`badge ${b.cls}`}>{b.text}</span></td><td>{q.in_work ? "в работе" : "ждёт"}</td></tr>); })}</tbody>
        </table></div>
      )}
      <h2 style={{ fontSize: 18 }}>Готово, но не установлено</h2>
      <div className="wrap"><table className="table">
        <thead><tr><th>Заказ</th><th>Клиент</th><th>Направление</th><th>Стоит дней</th></tr></thead>
        <tbody>{waiting.map((w) => <tr key={w.order_id}><td><b>{w.number}</b></td><td>{w.customer_name}</td><td>{w.direction ?? "—"}</td><td><span className={`badge ${w.days_waiting > 30 ? "red" : w.days_waiting > 14 ? "amber" : ""}`}>{w.days_waiting}</span></td></tr>)}</tbody>
      </table></div>
    </>
  );
}

/* ─── Склад: места и поиск ─────────────────────────────────────────────────────── */
export function WarehousePage() {
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [placeTag, setPlaceTag] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const { data: places = [] } = useQuery({ queryKey: ["places"], queryFn: () => rows<any>(db("warehouse").from("api_places").select("*")) });
  const { data: found = [] } = useQuery({ queryKey: ["placement", q], enabled: q.length >= 2, queryFn: () => rows<any>(db("warehouse").from("api_placements").select("*").ilike("number", `%${q}%`)) });
  const place = async (code: string) => {
    try { const r = await rpc("warehouse", "place", { p_tag: placeTag, p_place: code }); setMsg(`Поставлено на место ${code}, ${r.depth}-я в глубину${r.overCapacity ? " — место переполнено!" : ""}`); setPlaceTag(null); qc.invalidateQueries(); }
    catch (e) { setMsg((e as Error).message); }
  };
  return (
    <>
      <h1>Склад и места хранения</h1>
      <div className="grid2">
        <section className="card">
          <h2 style={{ marginTop: 0, fontSize: 17 }}>Найти стелу</h2>
          <input placeholder="Номер заказа" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: "100%" }} />
          {found.map((f) => <p key={f.cargo_unit_id}>№ {f.number}, {f.kind === "stela" ? "стела" : "комплект"} — место <b>{f.place_code}</b>, {Number(f.position_from_front) === 1 ? "стоит первой" : `перед ней ещё ${Number(f.position_from_front) - 1}`}</p>)}
          {q.length >= 2 && !found.length && <p className="muted">Не найдено под навесом</p>}
        </section>
        <section className="card">
          <h2 style={{ marginTop: 0, fontSize: 17 }}>Поставить на место</h2>
          {!placeTag ? <Scanner onCode={setPlaceTag} label="QR стелы" /> : <p>Бирка <b>{placeTag}</b> — нажмите место ниже</p>}
          {msg && <p>{msg}</p>}
        </section>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(64px, 1fr))", gap: 6, marginTop: 16 }}>
        {places.map((p) => {
          const r = Number(p.occupied) / p.capacity;
          return <button key={p.code} onClick={() => placeTag && place(p.code)} disabled={!placeTag}
            style={{ minHeight: 52, background: r === 0 ? "#F4F5F7" : r < 0.5 ? "#C7DCEC" : r < 1 ? "#6E9CC0" : "#1B3F5C", color: r >= 0.5 ? "#fff" : undefined }}>
            <b>{p.code}</b><br /><small>{p.occupied}/{p.capacity}</small></button>;
        })}
      </div>
    </>
  );
}

/* ─── Погрузка: «Заказ 4812: 2 из 2» ───────────────────────────────────────────── */
export function LoadingPage() {
  const qc = useQueryClient();
  const [load, setLoad] = useState<string>("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const { data: loads = [] } = useQuery({ queryKey: ["loads"], queryFn: () => rows<any>(db("warehouse").from("loads").select("*").eq("status", "open").order("load_date")) });
  const { data: progress = [] } = useQuery({ queryKey: ["load-progress", load, msg], enabled: !!load, queryFn: () => rows<any>(db("warehouse").from("api_load_progress").select("*").eq("load_id", load)) });
  const scan = async (code: string) => {
    try { const r = await rpc("warehouse", "scan_load", { p_load: load, p_tag: code }); setMsg({ ok: true, text: `${r.text} · машина ${r.loadScanned} из ${r.loadTotal}` }); }
    catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
  };
  const complete = async (force?: string) => {
    try { await rpc("warehouse", "complete_load", { p_load: load, p_force_reason: force ?? null }); setMsg({ ok: true, text: "Погрузка закрыта" }); setLoad(""); qc.invalidateQueries({ queryKey: ["loads"] }); }
    catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
  };
  return (
    <>
      <h1>Погрузка</h1>
      <select value={load} onChange={(e) => setLoad(e.target.value)} aria-label="Машина">
        <option value="">Выберите машину (накладную)</option>{loads.map((l) => <option key={l.id} value={l.id}>{l.waybill_id} · {fmtDate(l.load_date)}</option>)}
      </select>
      {load && <>
        <div style={{ margin: "12px 0" }}><Scanner onCode={scan} label="QR грузового места" /></div>
        <div className="wrap"><table className="table"><tbody>{progress.map((p) => (
          <tr key={p.order_id}><td><b>Заказ {p.number}</b></td><td><span className={`badge ${p.units_scanned === p.units_total ? "green" : "amber"}`}>{p.units_scanned} из {p.units_total}</span></td></tr>))}</tbody></table></div>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="primary" onClick={() => complete()}>Закрыть погрузку</button>
          <button onClick={() => { const r = prompt("Почему уезжаете без всех мест? (только начальник)"); if (r) void complete(r); }}>Закрыть неполную</button>
        </div>
      </>}
      {msg && <p className={msg.ok ? "" : "err"} style={{ fontSize: 18 }}>{msg.text}</p>}
    </>
  );
}
