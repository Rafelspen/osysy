import { NextRequest, NextResponse } from "next/server";
import { getAccountRow, getAuthorizedClient, GmailDisconnectedError } from "@/lib/google-oauth";
import { ensureHeaders, readLeadRows } from "@/lib/sheets";
import { draftFollowUp, type FollowUpStep } from "@/lib/followup";
import { errorMessage } from "@/lib/error";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const rowNumber = Number(body?.rowNumber);
  const step = Number(body?.step);
  const websiteUrl = String(body?.websiteUrl ?? "");

  if (!Number.isInteger(rowNumber) || rowNumber < 2 || ![1, 2, 3].includes(step)) {
    return NextResponse.json({ ok: false, message: "Invalid request." }, { status: 400 });
  }

  try {
    const account = await getAccountRow();
    if (!account?.sheet_connected || !account.sheet_id) {
      return NextResponse.json({ ok: false, message: "Connect a Google Sheet first." }, { status: 409 });
    }
    if (!account.gmail_connected) {
      return NextResponse.json({ ok: false, message: "Gmail is disconnected — click Reconnect Gmail." }, { status: 409 });
    }

    const auth = await getAuthorizedClient();
    const leads = await readLeadRows(auth, account.sheet_id);
    const lead = leads.find((l) => l.rowNumber === rowNumber);

    // Row numbers shift if the sheet was sorted or rows were inserted/deleted, so
    // confirm the row is still the lead the user clicked before drafting anything.
    if (!lead || lead.websiteUrl.trim() !== websiteUrl.trim()) {
      return NextResponse.json(
        { ok: false, message: "The sheet changed since this page loaded — refresh the dashboard and try again." },
        { status: 409 }
      );
    }

    await ensureHeaders(auth, account.sheet_id);
    const result = await draftFollowUp(auth, account.sheet_id, lead, step as FollowUpStep);
    return NextResponse.json(result, { status: result.status });
  } catch (err) {
    if (err instanceof GmailDisconnectedError) {
      return NextResponse.json({ ok: false, message: err.message }, { status: 409 });
    }
    return NextResponse.json({ ok: false, message: errorMessage(err) }, { status: 500 });
  }
}
