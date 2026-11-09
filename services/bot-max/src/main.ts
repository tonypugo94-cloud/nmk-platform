import { runService } from "@nmk/shared";
import { gateway, MaxTransport } from "@nmk/bots";
await runService(gateway(new MaxTransport({ token: process.env.MAX_TOKEN!, webhookSecret: process.env.MAX_WEBHOOK_SECRET! })));
