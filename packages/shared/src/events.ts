/**
 * Каталог событий. У каждого модуля свой файл в events/: defineEvent регистрирует Zod-схему,
 * по которой проверяются и публикация, и обработка. Новый модуль — новый файл + строка здесь.
 */
export * from "./events/registry.js";
export * from "./events/core.js";
export * from "./events/tracking.js";
export * from "./events/workload.js";
export * from "./events/warehouse.js";
export * from "./events/planning.js";
export * from "./events/procurement.js";
export * from "./events/messaging.js";
export * from "./events/weather.js";
export * from "./events/crew.js";
export * from "./events/piecework.js";
