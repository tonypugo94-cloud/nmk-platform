import { migrate } from "../packages/db/src/migrate.js";
export default async function () {
  await migrate({ reset: true, log: () => {} });
}
