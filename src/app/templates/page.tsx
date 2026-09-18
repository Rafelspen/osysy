import { getActiveTemplate, TEMPLATE_NAMES, type Template, type TemplateName } from "@/lib/templates";
import { errorMessage } from "@/lib/error";
import TemplateEditor from "./TemplateEditor";

export const dynamic = "force-dynamic";

const DEFAULT_SUBJECT = "[company_name] x Investor Interest";

const BLOCKS: Record<
  TemplateName,
  { title: string; description: string; showSubject: boolean; defaultBody: string }
> = {
  first_outreach: {
    title: "First outreach",
    description: "The first email, drafted automatically by the pipeline.",
    showSubject: true,
    defaultBody:
      "Dear team,<br><br>" +
      "I came across [company_name] and wanted to reach out directly.<br><br>" +
      "I'd love to learn more about what you're building and see if there's a fit to connect.<br><br>" +
      "Best,<br>" +
      "Rafael",
  },
  follow_up_1: {
    title: "Follow-up 1",
    description:
      "Drafted as a reply in the same Gmail thread when you click Follow-up 1 on the dashboard. The subject is kept from your first email.",
    showSubject: false,
    defaultBody:
      "Dear team,<br><br>" +
      "I wanted to follow up on my earlier note about [company_name]. Would you be open to a short conversation?<br><br>" +
      "Best,<br>" +
      "Rafael",
  },
  follow_up_2: {
    title: "Follow-up 2",
    description: "Drafted in the same thread when you click Follow-up 2. Only available after Follow-up 1 was sent.",
    showSubject: false,
    defaultBody:
      "Dear team,<br><br>" +
      "Just checking in again in case my previous messages got buried. Happy to work around your schedule.<br><br>" +
      "Best,<br>" +
      "Rafael",
  },
  follow_up_3: {
    title: "Final follow-up",
    description: "Drafted in the same thread when you click Final follow-up. Only available after Follow-up 2 was sent.",
    showSubject: false,
    defaultBody:
      "Dear team,<br><br>" +
      "I'll close the loop here so I don't crowd your inbox. If the timing ever makes sense, I'd be glad to reconnect.<br><br>" +
      "Best,<br>" +
      "Rafael",
  },
};

export default async function TemplatesPage() {
  const active: Partial<Record<TemplateName, Template | null>> = {};
  let dbError: string | null = null;
  try {
    for (const name of TEMPLATE_NAMES) {
      active[name] = await getActiveTemplate(name);
    }
  } catch (err) {
    dbError = errorMessage(err);
  }

  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Templates</h1>
        <p className="text-sm text-slate-600">
          Each template is saved on its own. Saving creates a new version and deactivates only that template&rsquo;s previous
          version. A follow-up template must be saved before its button on the dashboard will work.
        </p>
      </div>
      {dbError && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          Database not reachable: {dbError}. Showing unsaved defaults below — saving will fail until the DB is up.
        </div>
      )}
      {TEMPLATE_NAMES.map((name) => {
        const block = BLOCKS[name];
        const saved = active[name];
        return (
          <TemplateEditor
            key={name}
            name={name}
            title={block.title}
            description={block.description}
            showSubject={block.showSubject}
            isSaved={!!saved}
            initialSubject={saved?.subject ?? DEFAULT_SUBJECT}
            initialBody={saved?.body_html ?? block.defaultBody}
          />
        );
      })}
    </div>
  );
}
