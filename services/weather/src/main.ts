import { runService } from "@nmk/shared";
import { MeteoPlanProvider } from "./provider.js";
import { weatherService } from "./definition.js";

await runService(weatherService(new MeteoPlanProvider({
  url: process.env.METEOPLAN_URL!,
  key: process.env.METEOPLAN_KEY!,
  email: process.env.METEOPLAN_EMAIL!,
  password: process.env.METEOPLAN_PASSWORD!,
})));
