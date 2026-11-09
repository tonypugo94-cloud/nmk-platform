export const fmtDate = (d?: string | null) => (d ? new Date(d).toLocaleDateString("ru-RU") : "—");
export const fmtTime = (d?: string | null) => (d ? new Date(d).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");
export const fmtKg = (n?: number | string | null) => (n === null || n === undefined ? "—" : `${Math.round(Number(n))} кг`);
export function slackBadge(days: number | null) {
  if (days === null || days === undefined) return { cls: "", text: "без срока" };
  if (days < 0) return { cls: "red", text: `просрочен ${-days} дн.` };
  if (days <= 2) return { cls: "amber", text: `${days} дн.` };
  return { cls: "green", text: `${days} дн.` };
}
