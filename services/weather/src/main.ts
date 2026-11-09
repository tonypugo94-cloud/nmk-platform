import { runService } from "@nmk/shared";
import { MeteoPlanProvider } from "./provider.js";
import { weatherService } from "./definition.js";
await runService(weatherService(new MeteoPlanProvider(process.env.METEOPLAN_URL!, process.env.METEOPLAN_TOKEN ?? "")));
