import { NextRequest, NextResponse } from "next/server";
import { disconnectGmail } from "@/lib/google-oauth";
import { errorMessage } from "@/lib/error";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  // Browsers attach Origin to cross-site POSTs; refuse those so another site
  // can't disconnect the account with a hidden form.
  const origin = req.headers.get("origin");
  if (origin && origin !== req.nextUrl.origin) {
    return NextResponse.json({ ok: false, message: "Cross-site request refused." }, { status: 403 });
  }

  try {
    const { revoked } = await disconnectGmail();
    return NextResponse.json({ ok: true, revoked });
  } catch (err) {
    return NextResponse.json({ ok: false, message: errorMessage(err) }, { status: 500 });
  }
}
