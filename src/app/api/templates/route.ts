import { NextRequest, NextResponse } from "next/server";
import { listTemplates, createTemplateVersion, getActiveTemplate, isTemplateName, isVariant } from "@/lib/templates";
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
  const bodyHtml = String(body?.body_html ?? "").trim();
  const rawName = body?.name ? String(body.name).trim() : "first_outreach";
  if (!isTemplateName(rawName)) {
    return NextResponse.json({ error: "unknown template name" }, { status: 400 });
  }
  const name = rawName;
  // Optional A/B testing (see templates.ts) — defaults to "a", the original single-template
  // behaviour, so anything that doesn't send a variant keeps working exactly as before.
  const rawVariant = body?.variant ? String(body.variant).trim().toLowerCase() : "a";
  if (!isVariant(rawVariant)) {
    return NextResponse.json({ error: "unknown variant" }, { status: 400 });
  }
  const variant = rawVariant;
  // Follow-ups are replies in the existing thread and reuse its subject.
  const subject = name === "first_outreach" ? String(body?.subject ?? "").trim() : "";

  if (!bodyHtml || (name === "first_outreach" && !subject)) {
    return NextResponse.json({ error: "subject and body_html are required" }, { status: 400 });
  }

  try {
    const template = await createTemplateVersion({ subject, body_html: bodyHtml, name, variant });
    return NextResponse.json({ template });
  } catch (err) {
    return NextResponse.json({ error: errorMessage(err) }, { status: 500 });
  }
}
