import { timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { runPipelineTick } from "@/lib/pipeline-runner";
import { errorMessage } from "@/lib/error";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function secretsMatch(provided: string | null, expected: string | undefined): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Accepts the secret either as `x-cron-secret: <secret>` (GitHub Actions or any
// external scheduler) or as `Authorization: Bearer <secret>`, which is what
// Vercel Cron sends automatically when a CRON_SECRET variable exists.
async function handle(req: NextRequest) {
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  const provided = req.headers.get("x-cron-secret") ?? bearer;
  if (!secretsMatch(provided, process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const summary = await runPipelineTick();
    return NextResponse.json(summary);
  } catch (err: any) {
    return NextResponse.json({ error: errorMessage(err) }, { status: 500 });
  }
}

// Vercel Cron calls with GET; every other scheduler here uses POST.
export const GET = handle;
export const POST = handle;
