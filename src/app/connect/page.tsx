import { getAccountRow, getAuthorizedClient } from "@/lib/google-oauth";
import { getConnectedEmail } from "@/lib/gmail";
import { errorMessage } from "@/lib/error";
import DisconnectGmailButton from "./DisconnectGmailButton";

export const dynamic = "force-dynamic";

function StatusBadge({ connected }: { connected: boolean }) {
  return (
    <span
      className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
        connected ? "bg-green-100 text-green-800" : "bg-slate-100 text-slate-600"
      }`}
    >
      {connected ? "Connected" : "Not connected"}
    </span>
  );
}

export default async function ConnectPage({
  searchParams,
}: {
  searchParams: { connected?: string; error?: string; disconnected?: string };
}) {
  let account: Awaited<ReturnType<typeof getAccountRow>> = null;
  let dbError: string | null = null;
  try {
    account = await getAccountRow();
  } catch (err) {
    dbError = errorMessage(err);
  }

  // Show which Google account is connected so it's clear what you'd be switching from.
  let connectedEmail: string | null = null;
  if (account?.gmail_connected) {
    try {
      connectedEmail = await getConnectedEmail(await getAuthorizedClient());
    } catch {
      // Purely informational — the page works without it.
    }
  }

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold text-slate-900">Connect</h1>

      {dbError && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          Database not reachable: {dbError}. Check <code>DATABASE_URL</code> and that migrations have run (see
          README).
        </div>
      )}
      {searchParams.error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {decodeURIComponent(searchParams.error)}
        </div>
      )}
      {searchParams.connected && (
        <div className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          {searchParams.connected === "gmail" ? "Gmail connected." : "Sheet connected."}
        </div>
      )}
      {searchParams.disconnected && (
        <div className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
          Gmail disconnected. Click Connect Gmail below and choose the account you want to use.
        </div>
      )}

      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-medium text-slate-900">Gmail</h2>
          <StatusBadge connected={!!account?.gmail_connected} />
        </div>
        {account?.gmail_connected && connectedEmail && (
          <p className="mb-3 text-sm text-slate-800">
            Connected as <strong>{connectedEmail}</strong>
          </p>
        )}
        <p className="mb-4 text-sm text-slate-600">
          Grants access to create and update drafts (<code>gmail.compose</code>), to read the headers of the outreach
          threads it created so follow-ups stay in the same thread (<code>gmail.readonly</code>), and to read/write the
          lead Sheet (<code>spreadsheets</code>).
        </p>
        <div className="flex flex-wrap items-start gap-3">
          <a
            href="/api/oauth/google"
            className="inline-block rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
          >
            {account?.gmail_connected ? "Reconnect Gmail" : "Connect Gmail"}
          </a>
          {account?.gmail_connected && (
            <div>
              <DisconnectGmailButton />
            </div>
          )}
        </div>
        <p className="mt-3 text-xs text-slate-500">
          To switch accounts: Disconnect Gmail, then Connect Gmail and pick the other account. Your Sheet link is kept,
          so the account you connect next must be able to open that Sheet.
        </p>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-medium text-slate-900">Google Sheet</h2>
          <StatusBadge connected={!!account?.sheet_connected} />
        </div>
        <p className="mb-4 text-sm text-slate-600">
          Paste the URL of the Google Sheet that holds your leads. Requires Gmail to be connected first (same
          OAuth grant covers Sheets access). Validates read/write access on submit.
        </p>
        <form action="/api/sheet/connect" method="POST" className="flex gap-2">
          <input
            type="url"
            name="sheet_url"
            required
            defaultValue={account?.sheet_url ?? ""}
            placeholder="https://docs.google.com/spreadsheets/d/..."
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          />
          <button
            type="submit"
            className="whitespace-nowrap rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
          >
            Save & Validate
          </button>
        </form>
      </section>
    </div>
  );
}
