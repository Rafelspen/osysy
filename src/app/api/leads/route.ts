import { NextResponse } from "next/server";
import { getAccountRow, getAuthorizedClient } from "@/lib/google-oauth";
import { readLeadRows, PIPELINE_STAGES } from "@/lib/sheets";
import { errorMessage } from "@/lib/error";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const account = await getAccountRow();
    if (!account?.sheet_connected || !account.sheet_id) {
      return NextResponse.json({ connected: false, leads: [], counts: {} });
    }

    const auth = await getAuthorizedClient();
    const leads = await readLeadRows(auth, account.sheet_id);

    const counts: Record<string, number> = Object.fromEntries(PIPELINE_STAGES.map((s) => [s, 0]));
    for (const lead of leads) {
      const stage = lead.stage.trim().toUpperCase();
      if (stage in counts) counts[stage] += 1;
    }

    return NextResponse.json({ connected: true, leads, counts });
  } catch (err: any) {
    return NextResponse.json({ connected: false, leads: [], counts: {}, error: errorMessage(err) }, { status: 500 });
  }
}
