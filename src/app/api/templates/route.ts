import { NextRequest, NextResponse } from "next/server";
import { listTemplates, createTemplateVersion, getActiveTemplate } from "@/lib/templates";
import { errorMessage } from "@/lib/error";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [active, all] = await Promise.all([getActiveTemplate(), listTemplates()]);
    return NextResponse.json({ active, all });
  } catch (err) {
    return NextResponse.json({ error: errorMessage(err) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const subject = String(body?.subject ?? "").trim();
  const bodyHtml = String(body?.body_html ?? "").trim();
  const name = body?.name ? String(body.name).trim() : undefined;

  if (!subject || !bodyHtml) {
    return NextResponse.json({ error: "subject and body_html are required" }, { status: 400 });
  }

  try {
    const template = await createTemplateVersion({ subject, body_html: bodyHtml, name });
    return NextResponse.json({ template });
  } catch (err) {
    return NextResponse.json({ error: errorMessage(err) }, { status: 500 });
  }
}
