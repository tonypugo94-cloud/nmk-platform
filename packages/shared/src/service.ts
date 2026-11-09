/**
 * Общий каркас сервиса. Каждый сервис описывает себя манифестом и получает:
 *  - регистрацию модуля в core.app_modules и heartbeat;
 *  - подписку на события и цикл обработки с повторами;
 *  - периодические задачи (опрос 1С, расписания) с защитой от наложения;
 *  - HTTP /health (жив ли процесс) и /ready (есть ли связь с БД);
 *  - корректную остановку по SIGTERM.
 * Падение задачи или обработчика логируется и не роняет процесс.
 */
import http from "node:http";
import pg from "pg";
import { createLogger, type Logger } from "./logger.js";
import { processBatch, subscribe, type Handler } from "./bus.js";

export type ModuleManifest = {
  key: string;
  title: string;
  description?: string;
  version?: string;
  dependsOn?: string[];
  roles?: string[];
  menu?: { path: string; title: string; roles?: string[] }[];
};

export type ServiceDefinition = {
  name: string;                      // имя сервиса, совпадает с ролью БД svc_<name>
  module?: ModuleManifest;
  subscriptions?: Record<string, Handler>;
  tasks?: { name: string; everyMs: number; runOnStart?: boolean; run: (ctx: ServiceContext) => Promise<void> }[];
  routes?: Record<string, (req: http.IncomingMessage, res: http.ServerResponse, ctx: ServiceContext) => Promise<void>>;
};

export type ServiceContext = { db: pg.Pool; log: Logger; subscriber: string; status: Record<string, unknown> };

export type RunningService = { ctx: ServiceContext; stop: () => Promise<void>; tick: () => Promise<void>; port: number };

export async function runService(def: ServiceDefinition, opts: {
  databaseUrl?: string; port?: number; pollMs?: number; subscriber?: string; logger?: Logger; autoLoop?: boolean;
} = {}): Promise<RunningService> {
  const log = opts.logger ?? createLogger({ service: def.name });
  const db = new pg.Pool({
    connectionString: opts.databaseUrl ?? process.env.DATABASE_URL,
    max: 5,
    application_name: def.name,
    options: `-c app.service=${def.name}`,
  });
  db.on("error", (e) => log.error("db pool error", { error: e.message }));
  const subscriber = opts.subscriber ?? process.env.BUS_SUBSCRIBER ?? `svc_${def.name.replace(/-/g, "_")}`;
  const status: Record<string, unknown> = { startedAt: new Date().toISOString() };
  const ctx: ServiceContext = { db, log, subscriber, status };
  const timers: NodeJS.Timeout[] = [];
  const running = new Set<string>();
  let stopping = false;

  const guarded = async (name: string, fn: () => Promise<unknown>) => {
    if (running.has(name) || stopping) return;
    running.add(name);
    try { await fn(); status[name] = { ok: true, at: new Date().toISOString() }; }
    catch (e) {
      status[name] = { ok: false, at: new Date().toISOString(), error: (e as Error).message };
      log.error(`${name} failed`, { error: (e as Error).message });
    } finally { running.delete(name); }
  };

  // Регистрация модуля и подписки — с повторами: БД может подняться позже сервиса.
  const register = async () => {
    if (def.module) await db.query(`select core.register_module($1::jsonb)`, [JSON.stringify({ ...def.module, service: def.name })]);
    if (def.subscriptions) await subscribe(db, subscriber, Object.keys(def.subscriptions));
  };
  for (let i = 0; ; i++) {
    try { await register(); break; }
    catch (e) {
      if (i >= 30) throw e;
      log.warn("register failed, retrying", { error: (e as Error).message });
      await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** i, 15_000)));
    }
  }

  const consume = async () => {
    if (!def.subscriptions) return;
    while (!stopping) {
      const n = await processBatch({ db, subscriber, handlers: def.subscriptions, log });
      if (n === 0) break;
    }
  };

  const tick = async () => {
    await guarded("consume", consume);
    for (const t of def.tasks ?? []) await guarded(t.name, () => t.run(ctx));
  };

  if (opts.autoLoop !== false) {
    timers.push(setInterval(() => void guarded("consume", consume), opts.pollMs ?? 1000));
    for (const t of def.tasks ?? []) {
      if (t.runOnStart) void guarded(t.name, () => t.run(ctx));
      timers.push(setInterval(() => void guarded(t.name, () => t.run(ctx)), t.everyMs));
    }
    if (def.module) timers.push(setInterval(() => void guarded("heartbeat", () => db.query(`select core.module_heartbeat($1)`, [def.module!.key])), 30_000));
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (req.url === "/health") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, service: def.name, status })); return; }
      if (req.url === "/ready") {
        await db.query("select 1");
        res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true })); return;
      }
      const route = def.routes?.[`${req.method} ${req.url?.split("?")[0]}`];
      if (route) return await route(req, res, ctx);
      res.writeHead(404); res.end();
    } catch (e) {
      res.writeHead(503, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: false, error: (e as Error).message }));
    }
  });
  const port = await new Promise<number>((resolve) => server.listen(opts.port ?? Number(process.env.PORT ?? 8080), () => resolve((server.address() as any).port)));
  log.info("service started", { port, subscriber });

  const stop = async () => {
    stopping = true;
    timers.forEach(clearInterval);
    for (let i = 0; i < 50 && running.size; i++) await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => server.close(() => r(null)));
    await db.end();
    log.info("service stopped");
  };
  if (opts.autoLoop !== false) {
    process.once("SIGTERM", () => void stop().then(() => process.exit(0)));
    process.once("SIGINT", () => void stop().then(() => process.exit(0)));
  }
  return { ctx, stop, tick, port };
}
