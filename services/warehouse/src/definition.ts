import type { ServiceDefinition } from "@nmk/shared";

/** Размещение и сканы погрузки идут с телефонов прямо в БД. Сервис готовит погрузку по напечатанной накладной. */
export const warehouse: ServiceDefinition = {
  name: "warehouse",
  module: {
    key: "warehouse", title: "Склад", version: "0.1.0", dependsOn: ["orders", "tracking"],
    description: "Места хранения под навесом, поиск стелы, погрузка по грузовым местам «N из N»",
    roles: ["admin", "production_head", "production_deputy", "storekeeper", "manager"],
    menu: [{ path: "/warehouse", title: "Склад" }, { path: "/warehouse/loading", title: "Погрузка", roles: ["admin", "storekeeper", "production_head", "production_deputy"] }],
  },
  subscriptions: {
    "waybill.printed": async (ev, { db }) => {
      await db.query(`select warehouse.create_load($1, $2::date, $3, $4::uuid[])`, [ev.payload.waybillId, ev.payload.date, ev.payload.vehicleId, ev.payload.orderIds]);
    },
  },
};
