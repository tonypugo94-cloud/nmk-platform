import { runService } from "@nmk/shared";

await runService({
  name: "housekeeping",
  tasks: [
    { name: "prune-bus", everyMs: 6 * 3_600_000, run: async ({ db }) => { await db.query(`select bus.prune(30)`); } },
    { name: "anonymize", everyMs: 24 * 3_600_000, runOnStart: true, run: async ({ db, log }) => {
      const { rows } = await db.query(`select core.anonymize_customers() as n`);
      if (rows[0].n) log.info("customers anonymized", { count: rows[0].n });
    } },
  ],
});
