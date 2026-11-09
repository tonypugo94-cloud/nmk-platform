/**
 * Эмулятор OData 1С:УТ 11 для разработки и тестов без доступа к реальной базе.
 * Отвечает в том же формате, что и 1С: Ref_Key, DataVersion, табличные части, доп. реквизиты.
 *   npx tsx packages/accounting/src/emulator.ts   — запустить на :8091
 */
import http from "node:http";
import { randomUUID } from "node:crypto";

type Row = Record<string, any>;
const PV = "StandardODATA.Catalog_ЗначенияСвойствОбъектов";

export class OneCEmulator {
  orders = new Map<string, Row>();
  counterparties = new Map<string, Row>();
  items = new Map<string, Row>();
  props = new Map<string, string>();       // Ref_Key → Description
  values = new Map<string, string>();      // Ref_Key → Description
  stock: Row[] = [];
  failing = false;
  requests = 0;
  private server?: http.Server;
  constructor(readonly user = "obmen", readonly password = "secret") {}

  private ver() { return Math.random().toString(36).slice(2, 10); }
  propRef(name: string) {
    for (const [k, v] of this.props) if (v === name) return k;
    const k = randomUUID(); this.props.set(k, name); return k;
  }
  valueRef(name: string) {
    for (const [k, v] of this.values) if (v === name) return k;
    const k = randomUUID(); this.values.set(k, name); return k;
  }

  addItem(name: string, extra: Row = {}) {
    const ref = randomUUID();
    this.items.set(ref, { Ref_Key: ref, Description: name, Артикул: extra.sku ?? "", ВесЧислитель: extra.weight ?? 0,
      ДлинаЧислитель: extra.length ?? 0, ШиринаЧислитель: extra.width ?? 0, ВысотаЧислитель: extra.thickness ?? 0 });
    return ref;
  }

  addCounterparty(name: string, phone?: string) {
    const ref = randomUUID();
    this.counterparties.set(ref, { Ref_Key: ref, Description: name,
      КонтактнаяИнформация: phone ? [{ Тип: "Телефон", Представление: phone }] : [] });
    return ref;
  }

  addOrder(o: { number: string; date: string; due: string; counterparty: string; amount?: number; status?: string;
    stage?: string; cemetery?: string; plot?: string; lines: { item: string; qty: number }[] }) {
    const ref = randomUUID();
    const dop: Row[] = [];
    if (o.stage) dop.push({ Свойство_Key: this.propRef("Стадия производства"), Значение: this.valueRef(o.stage), Значение_Type: PV });
    if (o.cemetery) dop.push({ Свойство_Key: this.propRef("Кладбище"), Значение: o.cemetery, Значение_Type: "Edm.String" });
    if (o.plot) dop.push({ Свойство_Key: this.propRef("Участок"), Значение: o.plot, Значение_Type: "Edm.String" });
    this.orders.set(ref, {
      Ref_Key: ref, DataVersion: this.ver(), DeletionMark: false, Number: o.number, Date: `${o.date}T10:00:00`,
      Posted: true, ДатаОтгрузки: `${o.due}T00:00:00`, Статус: o.status ?? "КВыполнению", СуммаДокумента: o.amount ?? 0,
      Контрагент_Key: o.counterparty,
      Товары: o.lines.map((l, i) => ({ LineNumber: String(i + 1), Номенклатура_Key: l.item, Количество: l.qty })),
      ДополнительныеРеквизиты: dop,
    });
    return ref;
  }

  /** Поменять реквизит заказа, как это сделал бы менеджер в 1С (DataVersion меняется). */
  update(ref: string, change: { stage?: string; status?: string; plot?: string }) {
    const o = this.orders.get(ref)!;
    if (change.stage) {
      const pk = this.propRef("Стадия производства");
      o.ДополнительныеРеквизиты = o.ДополнительныеРеквизиты.filter((r: Row) => r.Свойство_Key !== pk);
      o.ДополнительныеРеквизиты.push({ Свойство_Key: pk, Значение: this.valueRef(change.stage), Значение_Type: PV });
    }
    if (change.plot) {
      const pk = this.propRef("Участок");
      o.ДополнительныеРеквизиты = o.ДополнительныеРеквизиты.filter((r: Row) => r.Свойство_Key !== pk);
      o.ДополнительныеРеквизиты.push({ Свойство_Key: pk, Значение: change.plot, Значение_Type: "Edm.String" });
    }
    if (change.status) o.Статус = change.status;
    o.DataVersion = this.ver();
  }

  static seeded() {
    const e = new OneCEmulator();
    const stela = e.addItem("Стела 100×50×8 габбро-диабаз", { sku: "ПВ-1", weight: 110, length: 1000, width: 500, thickness: 80 });
    const stand = e.addItem("Подставка 60×20×15", { weight: 45, length: 600, width: 200, thickness: 150 });
    const flower = e.addItem("Цветник 100×50 гранит", { weight: 30 });
    const tile = e.addItem("Плитка тротуарная 30×30, м²", { weight: 40 });
    const install = e.addItem("Установка памятника");
    const c1 = e.addCounterparty("Смирнова Елена Андреевна", "+7 900 111-22-33");
    const c2 = e.addCounterparty("Кузнецов Игорь Петрович", "+7 900 444-55-66");
    const c3 = e.addCounterparty("Петрова Наталья Викторовна");
    e.addOrder({ number: "НМК-004812", date: "2026-10-02", due: "2026-11-20", counterparty: c1, amount: 98500, stage: "Готов",
      cemetery: "Новое Кстово", plot: "уч. 12, ряд 4", lines: [{ item: stela, qty: 1 }, { item: stand, qty: 1 }, { item: flower, qty: 1 }, { item: install, qty: 1 }] });
    e.addOrder({ number: "НМК-004790", date: "2026-09-28", due: "2026-11-25", counterparty: c2, amount: 120000, stage: "В производстве",
      cemetery: "Арзамасское городское", lines: [{ item: stela, qty: 1 }, { item: tile, qty: 4 }] });
    e.addOrder({ number: "НМК-004835", date: "2026-10-10", due: "2026-12-05", counterparty: c3, amount: 76000, stage: "Принят",
      lines: [{ item: stela, qty: 1 }, { item: stand, qty: 1 }] });
    e.stock = [
      { Номенклатура_Key: stela, Склад_Key: randomUUID(), ВНаличииBalance: 9 },
      { Номенклатура_Key: stand, Склад_Key: randomUUID(), ВНаличииBalance: 12 },
      { Номенклатура_Key: flower, Склад_Key: randomUUID(), ВНаличииBalance: 5 },
    ];
    return e;
  }

  handle = (req: http.IncomingMessage, res: http.ServerResponse) => {
    this.requests++;
    const send = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json; charset=utf-8" }); res.end(JSON.stringify(body)); };
    const auth = Buffer.from(String(req.headers.authorization ?? "").replace("Basic ", ""), "base64").toString();
    if (auth !== `${this.user}:${this.password}`) return send(401, { error: "unauthorized" });
    if (this.failing) return send(500, { error: "1С недоступна" });
    const url = decodeURIComponent((req.url ?? "").split("?")[0]!.replace(/^.*standard\.odata\//, ""));
    const byKey = url.match(/^([^(/]+)\(guid'([0-9a-f-]+)'\)$/);
    const pick = (map: Map<string, Row>) => {
      const row = byKey && map.get(byKey[2]!);
      return row ? send(200, row) : send(404, { error: "not found" });
    };
    if (url === "Document_ЗаказКлиента") return send(200, { value: [...this.orders.values()].map((o) => ({ Ref_Key: o.Ref_Key, DataVersion: o.DataVersion })) });
    if (byKey?.[1] === "Document_ЗаказКлиента") return pick(this.orders);
    if (byKey?.[1] === "Catalog_Контрагенты") return pick(this.counterparties);
    if (byKey?.[1] === "Catalog_Номенклатура") return pick(this.items);
    if (byKey?.[1] === "Catalog_ЗначенияСвойствОбъектов") {
      const d = this.values.get(byKey[2]!); return d ? send(200, { Ref_Key: byKey[2], Description: d }) : send(404, {});
    }
    if (url === "ChartOfCharacteristicTypes_ДополнительныеРеквизитыИСведения")
      return send(200, { value: [...this.props].map(([Ref_Key, Description]) => ({ Ref_Key, Description })) });
    if (url === "AccumulationRegister_ТоварыНаСкладах/Balance()") return send(200, { value: this.stock });
    return send(404, { error: `unknown ${url}` });
  };

  async listen(port = 0): Promise<string> {
    this.server = http.createServer(this.handle);
    await new Promise<void>((r) => this.server!.listen(port, r));
    return `http://localhost:${(this.server.address() as any).port}/base/odata/standard.odata`;
  }
  async close() { await new Promise((r) => this.server?.close(r)); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  OneCEmulator.seeded().listen(Number(process.env.PORT ?? 8091)).then((u) => console.log(`эмулятор 1С: ${u} (obmen/secret)`));
}
