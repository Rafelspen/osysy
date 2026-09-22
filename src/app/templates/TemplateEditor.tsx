"use client";

import { useMemo, useState } from "react";

const SAMPLE_COMPANY = "Acme Robotics";
const SAMPLE_GREETING = "Acme Robotics";

function render(text: string) {
  return text.split("[company_name]").join(SAMPLE_COMPANY).split("[greeting_name]").join(SAMPLE_GREETING);
}

export default function TemplateEditor({
  name,
  variant = "a",
  title,
  description,
  showSubject,
  isSaved,
  initialSubject,
  initialBody,
  idleHint,
}: {
  name: string;
  variant?: "a" | "b";
  title: string;
  description?: string;
  showSubject: boolean;
  isSaved: boolean;
  initialSubject: string;
  initialBody: string;
  // Shown instead of the usual "Not saved yet" meaning when that's expected and fine
  // (an unsaved Variant B just means this slot isn't being A/B tested).
  idleHint?: string;
}) {
  const [subject, setSubject] = useState(initialSubject);
  const [bodyHtml, setBodyHtml] = useState(initialBody);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(isSaved);
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
        body: JSON.stringify({ name, variant, subject: showSubject ? subject : undefined, body_html: bodyHtml }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Failed to save template");
      }
      setSaved(true);
      setMessage("Saved as new active version.");
    } catch (err: any) {
      setMessage(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="space-y-3">
      <div className="flex items-center gap-3">
        <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
        <span
          className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
            saved ? "bg-green-100 text-green-800" : "bg-amber-100 text-amber-800"
          }`}
        >
          {saved ? "Saved" : "Not saved yet"}
        </span>
      </div>
      {description && <p className="text-sm text-slate-600">{description}</p>}
      {!saved && idleHint && <p className="text-xs text-slate-500">{idleHint}</p>}

      <div className="grid gap-6 md:grid-cols-2">
        <div className="space-y-4 rounded-lg border border-slate-200 bg-white p-6">
          {showSubject && (
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-700">Subject</label>
              <input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
                placeholder="[company_name] x Investor Interest"
              />
            </div>
          )}
          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">
              Body{" "}
              <span className="font-normal text-slate-400">
                (use [company_name], [greeting_name], and &lt;br&gt;&lt;br&gt; for paragraph breaks)
              </span>
            </label>
            <textarea
              value={bodyHtml}
              onChange={(e) => setBodyHtml(e.target.value)}
              rows={showSubject ? 12 : 9}
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
          {showSubject ? (
            <p className="text-sm font-semibold text-slate-900">{previewSubject}</p>
          ) : (
            <p className="text-sm font-semibold text-slate-900">Re: (subject of your first email)</p>
          )}
          <div
            className="prose prose-sm max-w-none text-sm text-slate-800"
            dangerouslySetInnerHTML={{ __html: previewBody }}
          />
        </div>
      </div>
    </section>
  );
}
