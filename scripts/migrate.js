// Runs every .sql file in /migrations, in filename order.
// Usage: npm run migrate
//
// Connection string: DATABASE_URL, else POSTGRES_URL_NON_POOLING, else
// POSTGRES_URL (the latter two are what Vercel's Postgres storage
// integration injects — non-pooling is preferred for DDL).

const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

async function main() {
  const connectionString =
    process.env.DATABASE_URL || process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
  if (!connectionString) {
    console.error("No DATABASE_URL / POSTGRES_URL found in the environment");
    process.exit(1);
  }

  const dir = path.join(__dirname, "..", "migrations");
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const client = new Client({ connectionString });
  await client.connect();

  try {
    for (const file of files) {
      console.log(`Applying ${file}...`);
      const sql = fs.readFileSync(path.join(dir, file), "utf8");
      await client.query(sql);
    }
    console.log("Migrations complete.");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
