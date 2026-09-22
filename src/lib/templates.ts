import { query } from "./db";

export type Template = {
  id: number;
  name: string;
  subject: string;
  body_html: string;
  is_active: boolean;
  version: number;
  created_at: string;
};

export const TEMPLATE_NAMES = ["first_outreach", "follow_up_1", "follow_up_2", "follow_up_3"] as const;
export type TemplateName = (typeof TEMPLATE_NAMES)[number];

export function isTemplateName(value: unknown): value is TemplateName {
  return typeof value === "string" && (TEMPLATE_NAMES as readonly string[]).includes(value);
}

// ---- A/B testing --------------------------------------------------------------
//
// Variant A is the original template, stored under its plain name ("first_outreach",
// "follow_up_1", ...) exactly as before — so a Sheet that never touches A/B testing
// behaves identically to before this existed. Variant B is optional, stored under a
// "_b"-suffixed name, and only comes into play once someone saves one.
//
// Each lead is assigned ONE variant, once — at the first email (VERIFIED -> OUTREACH,
// see pipeline.ts's advanceVerified) — stored in the Sheet's ab_variant column, and
// every later stage (drafting, the QA re-check, and every follow-up) reuses that same
// stored value via resolveVariant rather than deciding again. That's required for
// correctness: the QA stage re-renders the template to confirm the live Gmail draft
// matches, and if it picked a different variant than what was actually drafted, it
// would see a false mismatch and bounce the lead back to OUTREACH forever.

export type Variant = "a" | "b";
export function isVariant(value: unknown): value is Variant {
  return value === "a" || value === "b";
}

// A lead's stored ab_variant cell ("", "A", "B", or anything unexpected) -> what to use.
// Defaults to "a", so a lead from before this feature existed (blank cell) drafts exactly
// as it always did.
export function resolveVariant(stored: string | null | undefined): Variant {
  return String(stored ?? "").trim().toUpperCase() === "B" ? "b" : "a";
}

function dbName(name: TemplateName, variant: Variant): string {
  return variant === "a" ? name : `${name}_b`;
}

async function getByDbName(dbNameStr: string): Promise<Template | null> {
  const rows = await query<Template>(
    "SELECT * FROM templates WHERE is_active = TRUE AND name = $1 ORDER BY version DESC LIMIT 1",
    [dbNameStr]
  );
  return rows[0] ?? null;
}

// The exact saved state of one slot+variant, with NO fallback — used by the Templates
// page so "Variant B" only ever shows what was actually saved for B, never A's content
// masquerading as B's.
export async function getActiveTemplateExact(name: TemplateName, variant: Variant = "a"): Promise<Template | null> {
  return getByDbName(dbName(name, variant));
}

export async function hasVariantB(name: TemplateName): Promise<boolean> {
  return (await getActiveTemplateExact(name, "b")) !== null;
}

// Used for drafting: Variant B falls back to Variant A if this slot's B was never saved
// (or was saved and then... there's no "unsave", so this only triggers if B never
// existed). That keeps a half-configured A/B test — or no A/B test at all — safe: a
// lead can never fail to get a template just because a B block is empty.
export async function getActiveTemplate(name: TemplateName = "first_outreach", variant: Variant = "a"): Promise<Template | null> {
  if (variant === "b") {
    const b = await getByDbName(dbName(name, "b"));
    if (b) return b;
  }
  return getByDbName(name);
}

// Called once, only when a lead has no ab_variant yet (see advanceVerified). Random only
// if this slot actually has an active Variant B to split against — otherwise every lead
// gets "a", so nothing changes for a Sheet that isn't using A/B testing.
export async function assignVariant(name: TemplateName): Promise<Variant> {
  const hasB = await hasVariantB(name);
  if (!hasB) return "a";
  return Math.random() < 0.5 ? "a" : "b";
}

export async function listTemplates(): Promise<Template[]> {
  return query<Template>("SELECT * FROM templates ORDER BY version DESC");
}

export async function createTemplateVersion(input: {
  name?: TemplateName;
  variant?: Variant;
  subject: string; // follow-ups reuse the thread's subject, so theirs is stored empty
  body_html: string;
}): Promise<Template> {
  const name = input.name ?? "first_outreach";
  const variant = input.variant ?? "a";
  const key = dbName(name, variant);
  const [{ max_version }] = await query<{ max_version: number | null }>(
    "SELECT MAX(version) as max_version FROM templates"
  );
  const nextVersion = (max_version ?? 0) + 1;

  // Only this exact slot+variant's previous version is deactivated — every other
  // slot and variant (including the other one of this same A/B pair) stays active.
  await query("UPDATE templates SET is_active = FALSE WHERE is_active = TRUE AND name = $1", [key]);

  const rows = await query<Template>(
    `INSERT INTO templates (name, subject, body_html, is_active, version)
     VALUES ($1, $2, $3, TRUE, $4)
     RETURNING *`,
    [key, input.subject, input.body_html, nextVersion]
  );
  return rows[0];
}

export function renderTemplate(
  template: Pick<Template, "subject" | "body_html">,
  companyName: string,
  greetingName: string
) {
  const apply = (text: string) =>
    text.split("[company_name]").join(companyName).split("[greeting_name]").join(greetingName);
  return {
    subject: apply(template.subject),
    bodyHtml: apply(template.body_html),
  };
}
