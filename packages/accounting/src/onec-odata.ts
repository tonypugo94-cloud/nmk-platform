/**
 * Адаптер 1С:Управление торговлей 11 через стандартный интерфейс OData (только чтение).
 * Имена объектов и реквизитов вынесены в конфигурацию: у каждой базы они немного свои.
 */
import { guessKind } from "./kind.js";
import type { AccountingAdapter, AccountingOrder, OrderVersion, StockBalance } from "./types.js";

export type OneCConfig = {
  baseUrl: string;                 // https://host/base/odata/standard.odata
  user: string;
  password: string;
  orderEntity: string;
  counterpartyEntity: string;
  itemEntity: string;
  propertyEntity: string;          // план видов характеристик доп. реквизитов
  propertyValueEntity: string;     // значения свойств объектов
  stockBalance: string;            // регистр остатков с /Balance()
  fields: {
    dueDate: string; amount: string; status: string; closedStatuses: string[];
    counterparty: string; itemsTable: string; itemRef: string; qty: string; lineAmount?: string;
    itemSku: string; weight: string; length: string; width: string; thickness: string;
    stockItem: string; stockWarehouse: string; stockQty: string;
    counterpartyContacts: string; contactType: string; contactValue: string; phoneTypes: string[];
  };
  /** Названия дополнительных реквизитов заказа в 1С. */
  props: { stage: string; cemetery?: string; plot?: string; phone?: string };
};

export const defaultOneCConfig: Omit<OneCConfig, "baseUrl" | "user" | "password"> = {
  orderEntity: "Document_ЗаказКлиента",
  counterpartyEntity: "Catalog_Контрагенты",
  itemEntity: "Catalog_Номенклатура",
  propertyEntity: "ChartOfCharacteristicTypes_ДополнительныеРеквизитыИСведения",
  propertyValueEntity: "Catalog_ЗначенияСвойствОбъектов",
  stockBalance: "AccumulationRegister_ТоварыНаСкладах/Balance()",
  fields: {
    dueDate: "ДатаОтгрузки", amount: "СуммаДокумента", status: "Статус", closedStatuses: ["Закрыт"],
    counterparty: "Контрагент_Key", itemsTable: "Товары", itemRef: "Номенклатура_Key", qty: "Количество",
    itemSku: "Артикул", weight: "ВесЧислитель", length: "ДлинаЧислитель", width: "ШиринаЧислитель", thickness: "ВысотаЧислитель",
    stockItem: "Номенклатура_Key", stockWarehouse: "Склад_Key", stockQty: "ВНаличииBalance",
    counterpartyContacts: "КонтактнаяИнформация", contactType: "Тип", contactValue: "Представление", phoneTypes: ["Телефон"],
  },
  props: { stage: "Стадия производства", cemetery: "Кладбище", plot: "Участок", phone: "Телефон" },
};

const EMPTY_REF = "00000000-0000-0000-0000-000000000000";
const date = (v: unknown) => (typeof v === "string" && !v.startsWith("0001-") ? v.slice(0, 10) : null);
const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));

export class OneCODataAdapter implements AccountingAdapter {
  readonly name = "1С:УТ 11 (OData)";
  private propNames: Map<string, string> | null = null;
  private valueCache = new Map<string, string>();
  private itemCache = new Map<string, Record<string, unknown>>();

  constructor(private readonly cfg: OneCConfig, private readonly fetchImpl: typeof fetch = fetch) {}

  private async get(path: string, signal?: AbortSignal): Promise<any> {
    const sep = path.includes("?") ? "&" : "?";
    const url = `${this.cfg.baseUrl.replace(/\/$/, "")}/${encodeURI(path)}${sep}$format=json`;
    const res = await this.fetchImpl(url, {
      signal,
      headers: { authorization: "Basic " + Buffer.from(`${this.cfg.user}:${this.cfg.password}`).toString("base64"), accept: "application/json" },
    });
    if (!res.ok) throw new Error(`1С OData ${res.status} ${res.statusText} на ${path.split("?")[0]}`);
    return res.json();
  }

  async listOrderVersions(since: Date, signal?: AbortSignal): Promise<OrderVersion[]> {
    const iso = since.toISOString().slice(0, 19);
    const data = await this.get(`${this.cfg.orderEntity}?$select=Ref_Key,DataVersion&$filter=Date ge datetime'${iso}' and DeletionMark eq false`, signal);
    return (data.value as any[]).map((r) => ({ ref: r.Ref_Key, dataVersion: r.DataVersion }));
  }

  private async properties(signal?: AbortSignal) {
    if (!this.propNames) {
      const data = await this.get(`${this.cfg.propertyEntity}?$select=Ref_Key,Description`, signal);
      this.propNames = new Map((data.value as any[]).map((r) => [r.Ref_Key, r.Description]));
    }
    return this.propNames;
  }

  private async propertyValue(row: any, signal?: AbortSignal): Promise<string | null> {
    const v = row["Значение"];
    const type = String(row["Значение_Type"] ?? "");
    if (v === null || v === undefined || v === "" || v === EMPTY_REF) return null;
    if (!type.includes(this.cfg.propertyValueEntity)) return String(v);
    if (!this.valueCache.has(v)) {
      const d = await this.get(`${this.cfg.propertyValueEntity}(guid'${v}')?$select=Description`, signal);
      this.valueCache.set(v, d.Description);
    }
    return this.valueCache.get(v)!;
  }

  private async item(ref: string, signal?: AbortSignal) {
    if (!this.itemCache.has(ref)) this.itemCache.set(ref, await this.get(`${this.cfg.itemEntity}(guid'${ref}')`, signal));
    return this.itemCache.get(ref)!;
  }

  async getOrder(ref: string, signal?: AbortSignal): Promise<AccountingOrder> {
    const f = this.cfg.fields;
    const d = await this.get(`${this.cfg.orderEntity}(guid'${ref}')`, signal);
    const names = await this.properties(signal);
    const props: Record<string, string | null> = {};
    for (const row of (d["ДополнительныеРеквизиты"] ?? []) as any[]) {
      const name = names.get(row["Свойство_Key"]);
      if (name) props[name] = await this.propertyValue(row, signal);
    }

    let customer: AccountingOrder["customer"] = null;
    const cpRef = d[f.counterparty];
    if (cpRef && cpRef !== EMPTY_REF) {
      const cp = await this.get(`${this.cfg.counterpartyEntity}(guid'${cpRef}')`, signal);
      const phone = (this.cfg.props.phone && props[this.cfg.props.phone])
        || ((cp[f.counterpartyContacts] ?? []) as any[]).find((c) => f.phoneTypes.includes(c[f.contactType]))?.[f.contactValue]
        || null;
      customer = { ref: cpRef, fullName: cp.Description, phone };
    }

    const items = [];
    for (const line of (d[f.itemsTable] ?? []) as any[]) {
      const itemRef = line[f.itemRef] && line[f.itemRef] !== EMPTY_REF ? line[f.itemRef] : null;
      const it = itemRef ? await this.item(itemRef, signal) : {};
      const name = String((it as any).Description ?? line["Содержание"] ?? "Позиция");
      items.push({
        itemRef, sku: ((it as any)[f.itemSku] as string) || null, name, kind: guessKind(name),
        qty: Number(line[f.qty] ?? 1),
        weightKg: num((it as any)[f.weight]), lengthMm: num((it as any)[f.length]),
        widthMm: num((it as any)[f.width]), thicknessMm: num((it as any)[f.thickness]),
      });
    }

    return {
      ref: d.Ref_Key, dataVersion: d.DataVersion, number: String(d.Number).trim(),
      date: date(d.Date), dueDate: date(d[f.dueDate]),
      status: f.closedStatuses.includes(d[f.status]) || d.DeletionMark ? "closed" : "open",
      amount: num(d[f.amount]),
      stage: props[this.cfg.props.stage] ?? null,
      cemetery: this.cfg.props.cemetery ? props[this.cfg.props.cemetery] ?? null : null,
      plot: this.cfg.props.plot ? props[this.cfg.props.plot] ?? null : null,
      customer, items,
    };
  }

  async listStock(signal?: AbortSignal): Promise<StockBalance[]> {
    const f = this.cfg.fields;
    const data = await this.get(this.cfg.stockBalance, signal);
    return (data.value as any[]).map((r) => ({
      itemRef: r[f.stockItem], warehouseRef: r[f.stockWarehouse] ?? null, qty: Number(r[f.stockQty] ?? 0),
    }));
  }

  /** Сбросить кэши справочников (раз в сутки или при ошибках сопоставления). */
  resetCaches() { this.propNames = null; this.valueCache.clear(); this.itemCache.clear(); }
}
