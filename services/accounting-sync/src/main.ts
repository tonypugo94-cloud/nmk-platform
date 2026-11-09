import { CircuitBreaker, runService } from "@nmk/shared";
import { OneCODataAdapter, defaultOneCConfig, type OneCConfig } from "@nmk/accounting";
import { syncOrders, syncStock } from "./sync.js";

const overrides = process.env.ONEC_FIELDS ? (JSON.parse(process.env.ONEC_FIELDS) as Partial<OneCConfig>) : {};
const adapter = new OneCODataAdapter({
  ...defaultOneCConfig, ...overrides,
  fields: { ...defaultOneCConfig.fields, ...(overrides.fields ?? {}) },
  props: { ...defaultOneCConfig.props, ...(overrides.props ?? {}) },
  baseUrl: process.env.ONEC_ODATA_URL!, user: process.env.ONEC_USER!, password: process.env.ONEC_PASSWORD!,
});
const breaker = new CircuitBreaker("1c", { threshold: 3, cooldownMs: 60_000, timeoutMs: 20_000 });

await runService({
  name: "accounting-sync",
  module: {
    key: "orders", title: "Заказы", version: "0.1.0",
    description: "Заказы, клиенты, номенклатура и остатки из учётной системы (только чтение)",
    roles: ["admin", "manager", "production_head", "production_deputy", "owner"],
    menu: [{ path: "/orders", title: "Заказы" }],
  },
  tasks: [
    { name: "orders", everyMs: Number(process.env.SYNC_EVERY_MS ?? 120_000), runOnStart: true, run: ({ db, log }) => syncOrders(db, adapter, breaker, log).then(() => {}) },
    { name: "stock", everyMs: Number(process.env.STOCK_EVERY_MS ?? 900_000), runOnStart: true, run: ({ db }) => syncStock(db, adapter, breaker) },
    { name: "caches", everyMs: 86_400_000, run: async () => adapter.resetCaches() },
  ],
});
