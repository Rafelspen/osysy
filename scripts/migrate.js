// Runs every .sql file in /migrations, in filename order. The SQL is idempotent
// (CREATE TABLE IF NOT EXISTS, INSERT ... ON CONFLICT DO NOTHING), so running it
// repeatedly is safe.
//
// Usage:
//   npm run migrate          strict: exits non-zero on any problem
//   node scripts/migrate.js --soft
//                            used by `npm run build`: never fails the build.
//                            With no database configured yet it just skips, so
//                            the very first deploy (before the database is
//                            connected) still succeeds; the next deploy applies it.
//
// Connection string: DATABASE_URL, else POSTGRES_URL_NON_POOLING, else
// POSTGRES_URL (the latter two are what Vercel's Postgres storage
// integration injects — non-pooling is preferred for DDL).

const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const soft = process.argv.includes("--soft");

async function main() {
  const connectionString =
    process.env.DATABASE_URL || process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
  if (!connectionString) {
    if (soft) {
      console.log("[migrate] No database URL in the environment yet — skipping. It runs on the next deploy.");
      return;
    }
    console.error("No DATABASE_URL / POSTGRES_URL found in the environment");
    process.exit(1);
  }

  const dir = path.join(__dirname, "..", "migrations");
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const client = new Client({ connectionString, connectionTimeoutMillis: soft ? 15000 : 0 });
  await client.connect();

  try {
    for (const file of files) {
      console.log(`[migrate] Applying ${file}...`);
      const sql = fs.readFileSync(path.join(dir, file), "utf8");
      await client.query(sql);
    }
    console.log("[migrate] Migrations complete.");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  if (soft) {
    console.warn("[migrate] Skipped because of an error (the build continues):", err && err.message ? err.message : err);
    return;
  }
  console.error(err);
  process.exit(1);
});
