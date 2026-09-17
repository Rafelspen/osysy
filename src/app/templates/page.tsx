import { getActiveTemplate } from "@/lib/templates";
import { errorMessage } from "@/lib/error";
import TemplateEditor from "./TemplateEditor";

export const dynamic = "force-dynamic";

const DEFAULT_SUBJECT = "[company_name] x Investor Interest";
const DEFAULT_BODY =
  "Dear team,<br><br>" +
  "I came across [company_name] and wanted to reach out directly.<br><br>" +
  "I'd love to learn more about what you're building and see if there's a fit to connect.<br><br>" +
  "Best,<br>" +
  "Rafael";

export default async function TemplatesPage() {
  let active: Awaited<ReturnType<typeof getActiveTemplate>> = null;
  let dbError: string | null = null;
  try {
    active = await getActiveTemplate();
  } catch (err) {
    dbError = errorMessage(err);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Templates</h1>
        <p className="text-sm text-slate-600">
          One active template at a time. Saving creates a new version and deactivates the previous one.
        </p>
      </div>
      {dbError && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          Database not reachable: {dbError}. Showing an unsaved default below — saving will fail until the DB is up.
        </div>
      )}
      <TemplateEditor initialSubject={active?.subject ?? DEFAULT_SUBJECT} initialBody={active?.body_html ?? DEFAULT_BODY} />
    </div>
  );
}
