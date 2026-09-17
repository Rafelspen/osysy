import { query } from "./db";

const LOCK_TIMEOUT_MS = 90_000;

// Lease-fenced lock: acquires only if unlocked or the previous lease expired.
// Returns a run id to use as the lock owner, or null if another run holds it.
export async function acquireLock(runId: string): Promise<boolean> {
  const rows = await query<{ id: number }>(
    `UPDATE pipeline_lock
       SET locked_at = now(), locked_by = $1
     WHERE id = 1
       AND (locked_at IS NULL OR locked_at < now() - ($2 || ' milliseconds')::interval)
     RETURNING id`,
    [runId, LOCK_TIMEOUT_MS]
  );
  return rows.length > 0;
}

export async function releaseLock(runId: string): Promise<void> {
  await query(`UPDATE pipeline_lock SET locked_at = NULL, locked_by = NULL WHERE id = 1 AND locked_by = $1`, [runId]);
}
