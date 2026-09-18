import { randomUUID } from "crypto";
import { query } from "./db";
import { acquireLock, releaseLock } from "./lock";
import { getAccountRow, getAuthorizedClient } from "./google-oauth";
import { readLeadRows, updateLeadRow } from "./sheets";
import { advanceLead } from "./pipeline";
import { errorMessage } from "./error";

const LEADS_PER_TICK = 10;

export type TickSummary = {
  skipped?: string;
  runId?: string;
  leadsProcessed: number;
  errors: string[];
};

export async function runPipelineTick(): Promise<TickSummary> {
  const runId = randomUUID();

  const account = await getAccountRow();
  if (!account?.gmail_connected || !account?.sheet_connected || !account.sheet_id) {
    const reason = !account?.gmail_connected
      ? "Gmail disconnected — reconnect on /connect"
      : "Sheet not connected";
    return { skipped: reason, leadsProcessed: 0, errors: [] };
  }

  const locked = await acquireLock(runId);
  if (!locked) {
    return { skipped: "another run holds the lock", leadsProcessed: 0, errors: [] };
  }

  const [{ id: runRowId }] = await query<{ id: number }>(
    `INSERT INTO pipeline_runs (status) VALUES ('running') RETURNING id`
  );

  const errors: string[] = [];
  let leadsProcessed = 0;

  try {
    const auth = await getAuthorizedClient();
    const leads = await readLeadRows(auth, account.sheet_id);
    const pending = leads.filter((l) => l.stage.trim().toUpperCase() !== "DRAFTED").slice(0, LEADS_PER_TICK);

    for (const lead of pending) {
      try {
        const result = await advanceLead(auth, lead);
        if (Object.keys(result.updates).length > 0) {
          await updateLeadRow(auth, account.sheet_id, lead.rowNumber, result.updates);
        }
        leadsProcessed += 1;
        if (result.updates.lastError) {
          errors.push(`Row ${lead.rowNumber} (${lead.companyName || lead.websiteUrl}): ${result.updates.lastError}`);
        }
      } catch (err: any) {
        const msg = errorMessage(err);
        errors.push(`Row ${lead.rowNumber}: ${msg}`);
        try {
          await updateLeadRow(auth, account.sheet_id, lead.rowNumber, { lastError: msg });
        } catch {
          // best-effort; don't let a write failure mask the original error
        }
      }
    }

    await query(
      `UPDATE pipeline_runs SET finished_at = now(), leads_processed = $1, errors = $2, status = 'completed' WHERE id = $3`,
      [leadsProcessed, JSON.stringify(errors), runRowId]
    );

    return { runId, leadsProcessed, errors };
  } catch (err: any) {
    await query(
      `UPDATE pipeline_runs SET finished_at = now(), leads_processed = $1, errors = $2, status = 'failed' WHERE id = $3`,
      [leadsProcessed, JSON.stringify([...errors, errorMessage(err)]), runRowId]
    );
    throw err;
  } finally {
    await releaseLock(runId);
  }
}
