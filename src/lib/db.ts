import { Pool } from "pg";

declare global {
  // eslint-disable-next-line no-var
  var __pgPool: Pool | undefined;
}

// Accepts either DATABASE_URL (this project's own convention, see .env.example)
// or POSTGRES_URL (what Vercel's Postgres storage integration injects
// automatically) so connecting that integration works with no renaming.
function resolveConnectionString(): string | undefined {
  return process.env.DATABASE_URL || process.env.POSTGRES_URL;
}

export function getPool(): Pool {
  if (!global.__pgPool) {
    global.__pgPool = new Pool({
      connectionString: resolveConnectionString(),
      max: 5,
    });
  }
  return global.__pgPool;
}

export async function query<T = any>(text: string, params?: any[]): Promise<T[]> {
  const pool = getPool();
  const result = await pool.query(text, params);
  return result.rows as T[];
}
