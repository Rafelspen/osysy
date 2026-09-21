import { NextRequest, NextResponse } from "next/server";
import { GmailDisconnectedError } from "@/lib/google-oauth";
import { assertSameOrigin, HttpError, loadLead } from "@/lib/lead-access";
import { recordResult, sheetCellIO, type RecordAction } from "@/lib/verify-lead";
import { PROVIDER_IDS, type ProviderId } from "@/lib/verification-store";
import { errorMessage } from "@/lib/error";

export const dynamic = "force-dynamic";

// POST { rowNumber, websiteUrl, action: "set" | "clear" | "reset", email, provider?, verdict? }
//   set    — record a result typed in by hand (Clay only)
//   clear  — remove one service's result for an address (Clay only)
//   reset  — forget every result for an address so it can be verified again
export async function POST(req: NextRequest) {
  try {
    assertSameOrigin(req);
    const body = await req.json().catch(() => null);
    const rowNumber = Number(body?.rowNumber);
    const websiteUrl = String(body?.websiteUrl ?? "");
    const action = String(body?.action ?? "");
    const email = String(body?.email ?? "");
    const provider = String(body?.provider ?? "");

    if (!Number.isInteger(rowNumber) || rowNumber < 2 || !email) throw new HttpError(400, "Invalid request.");

    let input: RecordAction;
    if (action === "set") {
      if (!(PROVIDER_IDS as readonly string[]).includes(provider)) throw new HttpError(400, "Unknown service.");
      input = { action: "set", email, provider: provider as ProviderId, verdict: String(body?.verdict ?? "") };
    } else if (action === "clear") {
      if (!(PROVIDER_IDS as readonly string[]).includes(provider)) throw new HttpError(400, "Unknown service.");
      input = { action: "clear", email, provider: provider as ProviderId };
    } else if (action === "reset") {
      input = { action: "reset", email };
    } else {
      throw new HttpError(400, "Unknown action.");
    }

    const { auth, sheetId, lead } = await loadLead(rowNumber, websiteUrl);
    await recordResult({ lead, input, io: sheetCellIO(auth, sheetId, lead.rowNumber) });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof HttpError) return NextResponse.json({ ok: false, message: err.message }, { status: err.status });
    if (err instanceof GmailDisconnectedError) return NextResponse.json({ ok: false, message: err.message }, { status: 409 });
    return NextResponse.json({ ok: false, message: errorMessage(err) }, { status: 500 });
  }
}
