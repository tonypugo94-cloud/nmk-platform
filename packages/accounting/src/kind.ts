import type { ItemKind } from "./types.js";

/** Тип изделия по названию номенклатуры, если в учётной системе нет отдельного признака. */
export function guessKind(name: string): ItemKind {
  const n = name.toLowerCase();
  if (/услуг|установк|демонтаж|гравир|доставк/.test(n)) return "service";
  if (/стел|памятник/.test(n)) return "stela";
  if (/подстав|тумб/.test(n)) return "stand";
  if (/цветник/.test(n)) return "flowerbed";
  if (/плитк|плит[аы]? мощ|брусчат/.test(n)) return "tile";
  if (/бетон|отмостк|фундамент/.test(n)) return "concrete";
  if (/крест/.test(n)) return "cross";
  return "other";
}
