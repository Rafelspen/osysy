import { NextRequest, NextResponse } from "next/server";
import { query } from "@/lib/db";
import { getAuthorizedClient } from "@/lib/google-oauth";
import { extractSheetId, validateSheetAccess } from "@/lib/sheets";
import { errorMessage } from "@/lib/error";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const origin = req.nextUrl.origin;
  const form = await req.formData();
  const sheetUrl = String(form.get("sheet_url") ?? "").trim();

  if (!sheetUrl) {
    return NextResponse.redirect(`${origin}/connect?error=missing_sheet_url`);
  }

  try {
    const sheetId = extractSheetId(sheetUrl);
    const auth = await getAuthorizedClient();
    await validateSheetAccess(auth, sheetId);

    await query(
      `UPDATE account_connection SET sheet_url = $1, sheet_id = $2, sheet_connected = TRUE, updated_at = now() WHERE id = 1`,
      [sheetUrl, sheetId]
    );

    return NextResponse.redirect(`${origin}/connect?connected=sheet`);
  } catch (err: any) {
    return NextResponse.redirect(`${origin}/connect?error=${encodeURIComponent(errorMessage(err))}`);
  }
}
