import { createSqlClient } from "./client";
import { migrate } from "./migrate";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}
const client = await createSqlClient(url);
const ran = await migrate(client);
console.warn(ran.length > 0 ? `applied: ${ran.join(", ")}` : "database is up to date");
await client.close();
