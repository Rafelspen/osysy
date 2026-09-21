import { NextRequest, NextResponse } from "next/server";
import { GmailDisconnectedError } from "@/lib/google-oauth";
import { assertSameOrigin, HttpError, loadLead } from "@/lib/lead-access";
import { isApiProvider, providerLabel, providerStatuses } from "@/lib/email-verifier";
import { describeOutcomes, MAX_EMAILS_PER_REQUEST, runVerification, sheetCellIO } from "@/lib/verify-lead";
import { errorMessage } from "@/lib/error";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// POST { rowNumber, websiteUrl, provider: "zerobounce" | "hunter", emails: string[], force?: boolean }
// Checks the given addresses of one lead with one service and saves the results.
export async function POST(req: NextRequest) {
  try {
    assertSameOrigin(req);
    const body = await req.json().catch(() => null);
    const rowNumber = Number(body?.rowNumber);
    const websiteUrl = String(body?.websiteUrl ?? "");
    const provider = String(body?.provider ?? "");
    const emails: unknown = body?.emails;

    if (!Number.isInteger(rowNumber) || rowNumber < 2) throw new HttpError(400, "Invalid request.");
    if (!isApiProvider(provider)) throw new HttpError(400, "That service can't be run automatically.");
    if (!Array.isArray(emails) || emails.length === 0 || emails.length > MAX_EMAILS_PER_REQUEST || emails.some((e) => typeof e !== "string")) {
      throw new HttpError(400, `Send between 1 and ${MAX_EMAILS_PER_REQUEST} addresses.`);
    }

    const status = providerStatuses().find((p) => p.id === provider);
    if (!status?.configured) {
      throw new HttpError(409, `${providerLabel(provider)} isn't set up yet: add ${status?.envKey} in Vercel (Environment Variables) and redeploy.`);
    }

    const { auth, sheetId, lead } = await loadLead(rowNumber, websiteUrl);
    const outcomes = await runVerification({
      lead,
      provider,
      emails: emails as string[],
      force: body?.force === true,
      io: sheetCellIO(auth, sheetId, lead.rowNumber),
    });

    const anySuccess = outcomes.some((o) => o.status !== "failed");
    return NextResponse.json({ ok: anySuccess, message: describeOutcomes(provider, outcomes), outcomes });
  } catch (err) {
    if (err instanceof HttpError) return NextResponse.json({ ok: false, message: err.message }, { status: err.status });
    if (err instanceof GmailDisconnectedError) return NextResponse.json({ ok: false, message: err.message }, { status: 409 });
    return NextResponse.json({ ok: false, message: errorMessage(err) }, { status: 500 });
  }
}
