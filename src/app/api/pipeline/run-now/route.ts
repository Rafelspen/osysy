import { NextResponse } from "next/server";
import { runPipelineTick } from "@/lib/pipeline-runner";
import { errorMessage } from "@/lib/error";

// Same-origin manual trigger for the /dashboard "Run pipeline now" button.
// Intentionally not behind CRON_SECRET: this app has no login system by
// design (single-user side project), and this route only ever advances
// leads through the pipeline — it can't be used destructively.
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
