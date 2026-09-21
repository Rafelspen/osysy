import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { errorMessage } from "@/lib/error";
import { getVerifierConfig } from "@/lib/email-verifier";

export const dynamic = "force-dynamic";

// Setup check for humans and AI agents. Reports only true/false, counts and
// timestamps — never a secret value, host name or credential.
export async function GET(req: NextRequest) {
  const has = (name: string) => !!process.env[name]?.trim();

  const keyOk = (() => {
    try {
      return Buffer.from(process.env.TOKEN_ENCRYPTION_KEY ?? "", "base64").length === 32;
    } catch {
      return false;
    }
  })();

  const redirect = process.env.GOOGLE_REDIRECT_URI ?? "";
  let redirectShapeOk = false;
  let redirectMatchesThisAddress = false;
  try {
    const url = new URL(redirect);
    redirectShapeOk = url.protocol === "https:" && url.pathname === "/api/oauth/google/callback";
    redirectMatchesThisAddress = url.origin === req.nextUrl.origin;
  } catch {
    // not a valid URL
  }

  const env = {
    database_url: has("DATABASE_URL") || has("POSTGRES_URL"),
    google_client_id: has("GOOGLE_CLIENT_ID"),
    google_client_secret: has("GOOGLE_CLIENT_SECRET"),
    google_redirect_uri: has("GOOGLE_REDIRECT_URI"),
    google_redirect_uri_shape_ok: redirectShapeOk,
    google_redirect_uri_matches_this_address: redirectMatchesThisAddress,
    token_encryption_key_valid: keyOk,
    cron_secret: has("CRON_SECRET"),
  };

  let database: {
    reachable: boolean;
    tables_ready: boolean;
    error?: string;
  } = { reachable: false, tables_ready: false };
  let connection = { gmail_connected: false, sheet_connected: false };
  let lastRun: { minutes_ago: number | null; status: string | null } = { minutes_ago: null, status: null };

  try {
    const tables = await query<{ ready: boolean }>(
      `SELECT (to_regclass('account_connection') IS NOT NULL
           AND to_regclass('templates') IS NOT NULL
           AND to_regclass('pipeline_runs') IS NOT NULL
           AND to_regclass('pipeline_lock') IS NOT NULL) AS ready`
    );
    database = { reachable: true, tables_ready: !!tables[0]?.ready };

    if (database.tables_ready) {
      const [account] = await query<{ gmail_connected: boolean; sheet_connected: boolean }>(
        "SELECT gmail_connected, sheet_connected FROM account_connection WHERE id = 1"
      );
      connection = {
        gmail_connected: !!account?.gmail_connected,
        sheet_connected: !!account?.sheet_connected,
      };
      const [run] = await query<{ minutes_ago: number; status: string }>(
        "SELECT EXTRACT(EPOCH FROM (now() - started_at)) / 60 AS minutes_ago, status FROM pipeline_runs ORDER BY id DESC LIMIT 1"
      );
      if (run) lastRun = { minutes_ago: Math.round(Number(run.minutes_ago)), status: run.status };
    }
  } catch (err) {
    database = { reachable: false, tables_ready: false, error: errorMessage(err) };
  }

  const templates = { first_outreach_saved: false, follow_ups_saved: 0 };
  if (database.tables_ready) {
    try {
      const rows = await query<{ name: string }>("SELECT DISTINCT name FROM templates WHERE is_active = TRUE");
      templates.first_outreach_saved = rows.some((r) => r.name === "first_outreach");
      templates.follow_ups_saved = rows.filter((r) => r.name.startsWith("follow_up_")).length;
    } catch {
      // informational only
    }
  }

  const required =
    env.database_url &&
    env.google_client_id &&
    env.google_client_secret &&
    env.google_redirect_uri_shape_ok &&
    env.token_encryption_key_valid &&
    env.cron_secret &&
    database.reachable &&
    database.tables_ready;

  // Automatic runs come from a GitHub Actions schedule. Once Gmail and the Sheet
  // are connected, a run should appear every few minutes.
  const cronLooksAlive =
    !connection.gmail_connected || !connection.sheet_connected
      ? null
      : lastRun.minutes_ago !== null && lastRun.minutes_ago <= 15;

  return NextResponse.json({
    ok: !!required,
    ready_to_connect_gmail: !!required,
    fully_connected: !!required && connection.gmail_connected && connection.sheet_connected,
    env,
    database,
    connection,
    templates,
    last_pipeline_run: lastRun,
    cron_looks_alive: cronLooksAlive,
    email_verifier: getVerifierConfig(),
    version: (process.env.VERCEL_GIT_COMMIT_SHA ?? "").slice(0, 7) || null,
  });
}
