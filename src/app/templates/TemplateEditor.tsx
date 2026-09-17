"use client";

import { useMemo, useState } from "react";

const SAMPLE_COMPANY = "Acme Robotics";
const SAMPLE_GREETING = "Acme Robotics";

function render(text: string) {
  return text.split("[company_name]").join(SAMPLE_COMPANY).split("[greeting_name]").join(SAMPLE_GREETING);
}

export default function TemplateEditor({
  initialSubject,
  initialBody,
}: {
  initialSubject: string;
  initialBody: string;
}) {
  const [subject, setSubject] = useState(initialSubject);
  const [bodyHtml, setBodyHtml] = useState(initialBody);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const previewSubject = useMemo(() => render(subject), [subject]);
  const previewBody = useMemo(() => render(bodyHtml), [bodyHtml]);

  async function handleSave() {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject, body_html: bodyHtml }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Failed to save template");
      }
      setMessage("Saved as new active version.");
    } catch (err: any) {
      setMessage(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="grid gap-6 md:grid-cols-2">
      <div className="space-y-4 rounded-lg border border-slate-200 bg-white p-6">
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700">Subject</label>
          <input
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
            placeholder="[company_name] x Investor Interest"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-slate-700">
            Body <span className="font-normal text-slate-400">(use [company_name], [greeting_name], and &lt;br&gt;&lt;br&gt; for paragraph breaks)</span>
          </label>
          <textarea
            value={bodyHtml}
            onChange={(e) => setBodyHtml(e.target.value)}
            rows={12}
            className="w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-sm"
          />
        </div>
        <button
          onClick={handleSave}
          disabled={saving}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {saving ? "Saving..." : "Save (new version)"}
        </button>
        {message && <p className="text-sm text-slate-600">{message}</p>}
      </div>

      <div className="space-y-2 rounded-lg border border-slate-200 bg-white p-6">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
          Preview — sample company &quot;{SAMPLE_COMPANY}&quot;
        </p>
        <p className="text-sm font-semibold text-slate-900">{previewSubject}</p>
        <div
          className="prose prose-sm max-w-none text-sm text-slate-800"
          dangerouslySetInnerHTML={{ __html: previewBody }}
        />
      </div>
    </div>
  );
}
