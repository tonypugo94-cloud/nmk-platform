/**
 * Шлюз мессенджера: забирает очередь своего канала и отправляет, принимает вебхук и
 * передаёт входящие в messaging. Падение одного шлюза не влияет на другой канал.
 */
import { CircuitBreaker, type ServiceDefinition } from "@nmk/shared";
import type { Transport } from "./transport.js";

export function gateway(transport: Transport): ServiceDefinition {
  const breaker = new CircuitBreaker(transport.channel, { threshold: 5, cooldownMs: 60_000, timeoutMs: 15_000 });
  const name = `bot-${transport.channel}`;
  return {
    name,
    tasks: [{
      name: "send", everyMs: 2000, runOnStart: true,
      run: async ({ db, log }) => {
        if (breaker.state === "open") return;
        const { rows } = await db.query(`select * from messaging.claim_outgoing($1, 20)`, [transport.channel]);
        for (const m of rows) {
          try {
            const r = await breaker.call((s) => transport.send(m.chat_id, m.body, m.buttons ?? [], s));
            await db.query(`select messaging.mark($1, 'sent', $2)`, [m.id, r.externalId]);
          } catch (e) {
            log.warn("send failed", { id: m.id, error: (e as Error).message });
            await db.query(`select messaging.mark($1, 'retry', null, $2)`, [m.id, (e as Error).message]);
          }
        }
      },
    }],
    routes: {
      "POST /webhook": async (req, res, { db, log }) => {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        let body: any = null;
        try { body = JSON.parse(raw || "{}"); } catch { /* пусто */ }
        const parsed = transport.parseWebhook(body, req.headers);
        if (!parsed.authorized) { res.writeHead(403); res.end(); return; }
        for (const u of parsed.updates) {
          await db.query(`select messaging.record_inbound($1, $2, $3, $4::jsonb)`, [transport.channel, u.chatId, u.kind, JSON.stringify(u.data)]);
          if (u.kind === "button" && transport.ackButton) transport.ackButton(u.data).catch((e) => log.warn("ack failed", { error: e.message }));
        }
        res.writeHead(200, { "content-type": "text/plain" }); res.end(parsed.reply ?? "ok");
      },
    },
  };
}
