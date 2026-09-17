import { NextRequest, NextResponse } from "next/server";
import { getAccountRow, getAuthorizedClient } from "@/lib/google-oauth";
import { appendLeadRow } from "@/lib/sheets";
import { errorMessage } from "@/lib/error";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const origin = req.nextUrl.origin;
  const form = await req.formData();
  const websiteUrl = String(form.get("website_url") ?? "").trim();
  const source = String(form.get("source") ?? "").trim() || websiteUrl;

  if (!websiteUrl) {
    return NextResponse.redirect(`${origin}/add-lead?error=missing_website_url`);
  }

  try {
    const account = await getAccountRow();
    if (!account?.sheet_connected || !account.sheet_id) {
      throw new Error("Connect a Google Sheet first");
    }
    const auth = await getAuthorizedClient();
    await appendLeadRow(auth, account.sheet_id, { source, websiteUrl });
    return NextResponse.redirect(`${origin}/add-lead?added=1`);
  } catch (err: any) {
    return NextResponse.redirect(`${origin}/add-lead?error=${encodeURIComponent(errorMessage(err))}`);
  }
}
