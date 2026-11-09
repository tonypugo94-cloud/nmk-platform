/**
 * Применяет миграции из supabase/migrations по порядку и запоминает применённые.
 *   tsx packages/db/src/migrate.ts          — применить новые
 *   tsx packages/db/src/migrate.ts --reset  — ЛОКАЛЬНО: снести схемы и накатить заново (с заглушкой Supabase)
 * На сервере с self-hosted Supabase заглушка не нужна: auth и роли там уже есть.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const migrationsDir = join(root, "supabase/migrations");
const localDir = join(root, "supabase/local");

export async function migrate(opts: { url?: string; reset?: boolean; log?: (m: string) => void } = {}) {
  const log = opts.log ?? ((m: string) => console.log(m));
  const client = new pg.Client({ connectionString: opts.url ?? process.env.DATABASE_URL ?? "postgres://postgres@localhost:54329/postgres?host=/tmp" });
  await client.connect();
  try {
    if (opts.reset) {
      if (process.env.NODE_ENV === "production") throw new Error("--reset запрещён в production");
      const { rows } = await client.query(
        `select nspname from pg_namespace where nspname not in ('public','information_schema') and nspname not like 'pg_%'`);
      for (const r of rows) await client.query(`drop schema if exists "${r.nspname}" cascade`);
      await client.query(`drop table if exists public.schema_migrations`);
      const { rows: svc } = await client.query(`select rolname from pg_roles where rolname like 'svc_%'`);
      for (const r of svc) {
        await client.query(`drop owned by "${r.rolname}" cascade`);
        await client.query(`drop role "${r.rolname}"`);
      }
      for (const f of (await readdir(localDir)).filter((f) => f.endsWith(".sql")).sort()) {
        await client.query(await readFile(join(localDir, f), "utf8"));
        log(`local  ${f}`);
      }
    }
    await client.query(`create table if not exists public.schema_migrations (name text primary key, applied_at timestamptz not null default now())`);
    const done = new Set((await client.query(`select name from public.schema_migrations`)).rows.map((r) => r.name as string));
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = await readFile(join(migrationsDir, f), "utf8");
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query(`insert into public.schema_migrations (name) values ($1)`, [f]);
        await client.query("commit");
        log(`apply  ${f}`);
      } catch (e) {
        await client.query("rollback");
        throw new Error(`Миграция ${f} не применилась: ${(e as Error).message}`);
      }
    }
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate({ reset: process.argv.includes("--reset") }).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
