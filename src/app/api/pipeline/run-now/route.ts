import { NextResponse } from "next/server";
import { runPipelineTick } from "@/lib/pipeline-runner";
import { errorMessage } from "@/lib/error";

// Same-origin manual trigger for the /dashboard "Run pipeline now" button.
// Intentionally not behind CRON_SECRET: this route only ever advances leads
// through the pipeline (never destructively), and it already sits behind the
// optional dashboard login in src/middleware.ts when that's turned on.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST() {
  try {
    const summary = await runPipelineTick();
    return NextResponse.json(summary);
  } catch (err: any) {
    return NextResponse.json({ error: errorMessage(err) }, { status: 500 });
  }
}
