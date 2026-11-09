import { runService } from "@nmk/shared";
import { OneCHttpWriter } from "@nmk/accounting";
import { writeback } from "./definition.js";
await runService(writeback(new OneCHttpWriter({ baseUrl: process.env.ONEC_HS_URL!, user: process.env.ONEC_USER!, password: process.env.ONEC_PASSWORD! })));
