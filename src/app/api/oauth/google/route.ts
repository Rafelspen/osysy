import { NextRequest, NextResponse } from "next/server";
import { getAuthUrl } from "@/lib/google-oauth";
import { errorMessage } from "@/lib/error";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const url = getAuthUrl();
    return NextResponse.redirect(url);
  } catch (err) {
    return NextResponse.redirect(`${req.nextUrl.origin}/connect?error=${encodeURIComponent(errorMessage(err))}`);
  }
}
