/**
 * Нормализованные данные учётной системы. Остальная система знает только эти типы,
 * а не 1С. При уходе с 1С пишется новый адаптер под тот же интерфейс.
 */
export type ItemKind = "stela" | "stand" | "flowerbed" | "tile" | "concrete" | "cross" | "service" | "other";

export type AccountingOrderLine = {
  itemRef: string | null;
  sku?: string | null;
  name: string;
  kind: ItemKind;
  qty: number;
  weightKg?: number | null;
  lengthMm?: number | null;
  widthMm?: number | null;
  thicknessMm?: number | null;
};

export type AccountingOrder = {
  ref: string;
  dataVersion: string;
  number: string;
  date: string | null;        // YYYY-MM-DD
  dueDate: string | null;     // срок установки
  status: "open" | "closed";
  amount: number | null;
  stage: string | null;       // сырое значение реквизита «Стадия производства»
  cemetery: string | null;
  plot: string | null;
  customer: { ref: string; fullName: string; phone: string | null } | null;
  items: AccountingOrderLine[];
};

export type OrderVersion = { ref: string; dataVersion: string };

export type StockBalance = { itemRef: string; warehouseRef: string | null; qty: number };

export interface AccountingAdapter {
  readonly name: string;
  /** Лёгкий список: ссылка + версия, чтобы понять, что поменялось. */
  listOrderVersions(since: Date, signal?: AbortSignal): Promise<OrderVersion[]>;
  getOrder(ref: string, signal?: AbortSignal): Promise<AccountingOrder>;
  listStock(signal?: AbortSignal): Promise<StockBalance[]>;
}
