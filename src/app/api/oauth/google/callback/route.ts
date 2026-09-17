import { NextRequest, NextResponse } from "next/server";
import { handleOAuthCallback } from "@/lib/google-oauth";
import { errorMessage } from "@/lib/error";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const error = req.nextUrl.searchParams.get("error");
  const origin = req.nextUrl.origin;

  if (error) {
    return NextResponse.redirect(`${origin}/connect?error=${encodeURIComponent(error)}`);
  }
  if (!code) {
    return NextResponse.redirect(`${origin}/connect?error=missing_code`);
  }

  try {
    await handleOAuthCallback(code);
    return NextResponse.redirect(`${origin}/connect?connected=gmail`);
  } catch (err: any) {
    return NextResponse.redirect(`${origin}/connect?error=${encodeURIComponent(errorMessage(err))}`);
  }
}
