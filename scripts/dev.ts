/**
 * Локальный запуск для проверки: эмулятор 1С + все сервисы, каждый под своей ролью БД.
 *
 *   pnpm dev                     — всё, кроме ботов и погоды (им нужны токены)
 *   pnpm dev planning messaging  — только перечисленные сервисы (+ эмулятор 1С)
 *
 * База по умолчанию — локальный Supabase из `supabase start` (порт 54322, пароль postgres).
 * Свою можно указать: DEV_DATABASE_URL=postgres://postgres:...@host:port/postgres pnpm dev
 *
 * Скрипт выдаёт ролям svc_* вход с паролем "dev". Только для разработки, не для сервера.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { OneCEmulator } from "../packages/accounting/src/emulator.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const adminUrl = process.env.DEV_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const DEV_PASSWORD = "dev";

const ALL = [
  "accounting-sync", "accounting-writeback", "housekeeping", "tracking", "workload", "warehouse",
  "procurement", "planning", "weather", "messaging", "bot-max", "bot-vk", "autoplanner", "piecework", "analytics",
];
const needs: Record<string, string[]> = {
  weather: ["METEOPLAN_URL", "METEOPLAN_KEY", "METEOPLAN_EMAIL", "METEOPLAN_PASSWORD"],
  "bot-max": ["MAX_TOKEN", "MAX_WEBHOOK_SECRET"],
  "bot-vk": ["VK_TOKEN", "VK_SECRET", "VK_CONFIRMATION"],
};

const asked = process.argv.slice(2);
const unknown = asked.filter((s) => !ALL.includes(s));
if (unknown.length) {
  console.error(`Нет таких сервисов: ${unknown.join(", ")}. Есть: ${ALL.join(", ")}`);
  process.exit(1);
}
const wanted = (asked.length ? asked : ALL).filter((s) => {
  const missing = (needs[s] ?? []).filter((v) => !process.env[v]);
  if (missing.length) console.log(`пропускаю ${s}: не заданы ${missing.join(", ")}`);
  return missing.length === 0;
});

// 1. Роли сервисов: вход с паролем dev.
const admin = new pg.Client({ connectionString: adminUrl });
try {
  await admin.connect();
} catch (e) {
  console.error(`Не подключиться к базе ${adminUrl.replace(/:[^:@/]+@/, ":***@")}: ${(e as Error).message}`);
  console.error("Запущен ли Supabase (`npx supabase start`)? Или задайте DEV_DATABASE_URL.");
  process.exit(1);
}
const roles = (await admin.query(`select rolname from pg_roles where rolname like 'svc\\_%' order by 1`)).rows.map((r) => r.rolname as string);
if (!roles.length) {
  console.error("В базе нет ролей svc_* — миграции не применены. Выполните `npx supabase db reset`.");
  process.exit(1);
}
for (const r of roles) await admin.query(`alter role ${r} login password '${DEV_PASSWORD}'`);
await admin.end();
console.log(`роли сервисов: ${roles.length} шт., пароль "${DEV_PASSWORD}"`);

// 2. Эмулятор 1С с тремя демо-заказами.
const emulator = OneCEmulator.seeded();
const odataUrl = await emulator.listen(Number(process.env.ONEC_EMULATOR_PORT ?? 8091));
const hsUrl = odataUrl.replace(/\/odata\/standard\.odata$/, "/hs/nmk");
console.log(`эмулятор 1С: ${odataUrl}`);

// 3. Сервисы.
const children: ChildProcess[] = [];
const colors = [31, 32, 33, 34, 35, 36, 91, 92, 93, 94, 95, 96];
wanted.forEach((name, i) => {
  const role = `svc_${name.replace(/-/g, "_")}`;
  const url = new URL(adminUrl);
  url.username = role;
  url.password = DEV_PASSWORD;
  const port = 8101 + ALL.indexOf(name);
  const env = {
    ...process.env,
    DATABASE_URL: url.toString(),
    PORT: String(port),
    ONEC_ODATA_URL: process.env.ONEC_ODATA_URL ?? odataUrl,
    ONEC_HS_URL: process.env.ONEC_HS_URL ?? hsUrl,
    ONEC_USER: process.env.ONEC_USER ?? "obmen",
    ONEC_PASSWORD: process.env.ONEC_PASSWORD ?? "secret",
    SYNC_EVERY_MS: process.env.SYNC_EVERY_MS ?? "15000",
  };
  const cwd = join(root, "services", name);
  const child = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  const tag = `\x1b[${colors[i % colors.length]}m${name.padEnd(20)}\x1b[0m`;
  const pipe = (s: NodeJS.ReadableStream) => {
    let buf = "";
    s.on("data", (d) => {
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop()!;
      for (const l of lines) if (l.trim()) console.log(`${tag} ${l}`);
    });
  };
  pipe(child.stdout!);
  pipe(child.stderr!);
  child.on("exit", (code) => console.log(`${tag} остановлен (код ${code})`));
  children.push(child);
  console.log(`${tag} http://127.0.0.1:${port}/health`);
});

const stop = () => {
  for (const c of children) c.kill();
  void emulator.close();
  setTimeout(() => process.exit(0), 500);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
console.log("\nОстановить: Ctrl+C\n");
