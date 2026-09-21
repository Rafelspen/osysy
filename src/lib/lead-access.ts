import type { NextRequest } from "next/server";
import type { OAuth2Client } from "google-auth-library";
import { getAccountRow, getAuthorizedClient } from "./google-oauth";
import { readLeadRows, type LeadRow } from "./sheets";

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

// Browsers attach Origin to cross-site POSTs; refuse those so another website
// can't make this page's buttons spend your verification credits.
export function assertSameOrigin(req: NextRequest): void {
  const origin = req.headers.get("origin");
  if (origin && origin !== req.nextUrl.origin) throw new HttpError(403, "Cross-site request refused.");
}

// Finds the lead the user clicked. Row numbers shift if the Sheet is sorted or
// rows are inserted, so the website is checked too — nothing is done to a row
// that isn't the one the page showed.
export async function loadLead(
  rowNumber: number,
  websiteUrl: string
): Promise<{ auth: OAuth2Client; sheetId: string; lead: LeadRow }> {
  const account = await getAccountRow();
  if (!account?.sheet_connected || !account.sheet_id) throw new HttpError(409, "Connect a Google Sheet first.");
  if (!account.gmail_connected) throw new HttpError(409, "Gmail is disconnected — click Reconnect Gmail.");

  const auth = await getAuthorizedClient();
  const leads = await readLeadRows(auth, account.sheet_id);
  const lead = leads.find((l) => l.rowNumber === rowNumber);
  if (!lead || lead.websiteUrl.trim() !== websiteUrl.trim()) {
    throw new HttpError(409, "The sheet changed since this page loaded — refresh the dashboard and try again.");
  }
  return { auth, sheetId: account.sheet_id, lead };
}
