import { NextRequest, NextResponse } from "next/server";
import { runPipelineTick } from "@/lib/pipeline-runner";
import { errorMessage } from "@/lib/error";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const secret = req.headers.get("x-cron-secret");
  if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const summary = await runPipelineTick();
    return NextResponse.json(summary);
  } catch (err: any) {
    return NextResponse.json({ error: errorMessage(err) }, { status: 500 });
  }
}
