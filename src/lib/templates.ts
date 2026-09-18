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

export async function getActiveTemplate(name: TemplateName = "first_outreach"): Promise<Template | null> {
  const rows = await query<Template>(
    "SELECT * FROM templates WHERE is_active = TRUE AND name = $1 ORDER BY version DESC LIMIT 1",
    [name]
  );
  return rows[0] ?? null;
}

export async function listTemplates(): Promise<Template[]> {
  return query<Template>("SELECT * FROM templates ORDER BY version DESC");
}

export async function createTemplateVersion(input: {
  name?: TemplateName;
  subject: string; // follow-ups reuse the thread's subject, so theirs is stored empty
  body_html: string;
}): Promise<Template> {
  const name = input.name ?? "first_outreach";
  const [{ max_version }] = await query<{ max_version: number | null }>(
    "SELECT MAX(version) as max_version FROM templates"
  );
  const nextVersion = (max_version ?? 0) + 1;

  // Only this template's previous version is deactivated — the others stay active.
  await query("UPDATE templates SET is_active = FALSE WHERE is_active = TRUE AND name = $1", [name]);

  const rows = await query<Template>(
    `INSERT INTO templates (name, subject, body_html, is_active, version)
     VALUES ($1, $2, $3, TRUE, $4)
     RETURNING *`,
    [name, input.subject, input.body_html, nextVersion]
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
