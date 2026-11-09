/**
 * Автопланировщик, первая версия: понятные правила, а не оптимизация маршрутов.
 *  1. Заказы по сроку: сначала те, у кого ближе срок (риск неустойки).
 *  2. Дни — ближайшие рабочие в горизонте, резервный день (пятница) не занимаем.
 *  3. День с прогнозом осадков выше порога для направления пропускаем.
 *  4. Сначала догружаем машину того же направления в этот день, если хватает тоннажа;
 *     иначе берём свободную машину с наименьшей подходящей грузоподъёмностью.
 *  5. Внутри машины — объезд «ближайший следующий» от базы по координатам кладбищ.
 * Чистая функция: на вход данные, на выход действия. Тестируется без БД.
 */
export type Inputs = {
  settings: { horizonDays: number; rainSkipProb: number; base: { lat: number; lon: number } };
  planning: { workDays: number[]; reserveDays: number[] };
  orders: { id: string; number: string; directionId: string; weightKg: number; dueDate: string | null; lat: number | null; lon: number | null }[];
  slots: { id: string; day: string; directionId: string; vehicleId: string; loadKg: number; capacityKg: number; status: string }[];
  vehicles: { id: string; capacityKg: number }[];
  weather: { directionId: string; day: string; precipProb: number | null }[];
  unordered: { id: string; number: string }[];
};

export type Plan = {
  assignments: { orderId: string; day: string; directionId: string; vehicleId: string; slotId: string | null }[];
  sequences: { day: string; vehicleId: string; orderIds: string[] }[];
  skipped: { orderId: string; number: string; reason: string }[];
};

const isoDow = (d: string) => { const x = new Date(d + "T12:00:00Z").getUTCDay(); return x === 0 ? 7 : x; };
const addDays = (d: string, n: number) => new Date(new Date(d + "T12:00:00Z").getTime() + n * 86_400_000).toISOString().slice(0, 10);

export function workDays(from: string, inp: Inputs): string[] {
  const out: string[] = [];
  for (let i = 0; out.length < inp.settings.horizonDays && i < 31; i++) {
    const d = addDays(from, i), dow = isoDow(d);
    if (inp.planning.workDays.includes(dow) && !inp.planning.reserveDays.includes(dow)) out.push(d);
  }
  return out;
}

function dist(a: { lat: number | null; lon: number | null }, b: { lat: number | null; lon: number | null }) {
  if (a.lat == null || a.lon == null || b.lat == null || b.lon == null) return 1e6;
  const dx = (a.lon - b.lon) * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180), dy = a.lat - b.lat;
  return Math.sqrt(dx * dx + dy * dy);
}

export function plan(inp: Inputs, from: string): Plan {
  const days = workDays(from, inp);
  // «машина в день»: существующие слоты + создаваемые
  type Truck = { key: string; day: string; directionId: string; vehicleId: string; slotId: string | null; loadKg: number; capacityKg: number; orders: Inputs["orders"] };
  const trucks: Truck[] = inp.slots.filter((s) => s.status === "draft" || s.status === "approved")
    .map((s) => ({ key: `${s.day}|${s.vehicleId}`, day: s.day, directionId: s.directionId, vehicleId: s.vehicleId, slotId: s.id,
      loadKg: Number(s.loadKg), capacityKg: Number(s.capacityKg), orders: [] }));
  const busy = new Set(inp.slots.map((s) => `${s.day}|${s.vehicleId}`));
  const rain = new Map(inp.weather.map((w) => [`${w.directionId}|${w.day}`, w.precipProb ?? 0]));
  const res: Plan = { assignments: [], sequences: [], skipped: inp.unordered.map((o) => ({ orderId: o.id, number: o.number, reason: "Не задано направление (кладбище не сопоставлено)" })) };
  const orders = [...inp.orders].sort((a, b) => (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999"));

  for (const o of orders) {
    const w = Number(o.weightKg) || 0;
    let placed = false, rainy = false;
    for (const day of days) {
      if ((rain.get(`${o.directionId}|${day}`) ?? 0) >= inp.settings.rainSkipProb) { rainy = true; continue; }
      let t = trucks.filter((x) => x.day === day && x.directionId === o.directionId && x.loadKg + w <= x.capacityKg)
        .sort((a, b) => (b.loadKg / b.capacityKg) - (a.loadKg / a.capacityKg))[0];
      if (!t) {
        const v = inp.vehicles.filter((v) => !busy.has(`${day}|${v.id}`) && v.capacityKg >= w).sort((a, b) => a.capacityKg - b.capacityKg)[0];
        if (!v) continue;
        t = { key: `${day}|${v.id}`, day, directionId: o.directionId, vehicleId: v.id, slotId: null, loadKg: 0, capacityKg: v.capacityKg, orders: [] };
        trucks.push(t); busy.add(t.key);
      }
      t.loadKg += w; t.orders.push(o);
      res.assignments.push({ orderId: o.id, day, directionId: o.directionId, vehicleId: t.vehicleId, slotId: t.slotId });
      placed = true; break;
    }
    if (!placed) res.skipped.push({ orderId: o.id, number: o.number, reason: rainy ? "Дожди на всех свободных днях" : "Нет свободной машины или тоннажа в горизонте" });
  }

  for (const t of trucks.filter((t) => t.orders.length)) {
    const left = [...t.orders]; const seq: string[] = []; let cur: { lat: number | null; lon: number | null } = inp.settings.base;
    while (left.length) {
      left.sort((a, b) => dist(cur, a) - dist(cur, b));
      const n = left.shift()!; seq.push(n.id); cur = n;
    }
    res.sequences.push({ day: t.day, vehicleId: t.vehicleId, orderIds: seq });
  }
  return res;
}
