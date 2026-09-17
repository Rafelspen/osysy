"use client";

import { useCallback, useEffect, useState } from "react";

type Lead = {
  rowNumber: number;
  companyName: string;
  websiteUrl: string;
  officialEmail: string;
  stage: string;
  lastError: string;
};

const STAGE_COLORS: Record<string, string> = {
  SOURCED: "bg-slate-100 text-slate-700",
  ENRICHED: "bg-blue-100 text-blue-800",
  VERIFIED: "bg-indigo-100 text-indigo-800",
  OUTREACH: "bg-amber-100 text-amber-800",
  QA: "bg-purple-100 text-purple-800",
  DRAFTED: "bg-green-100 text-green-800",
};

const STAGE_ORDER = ["SOURCED", "ENRICHED", "VERIFIED", "OUTREACH", "QA", "DRAFTED"];

export default function DashboardPage() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [connected, setConnected] = useState(true);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [runMessage, setRunMessage] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch("/api/leads", { cache: "no-store" });
      const text = await res.text();
      const data = text ? JSON.parse(text) : {};
      if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
      setLeads(data.leads ?? []);
      setCounts(data.counts ?? {});
      setConnected(data.connected ?? false);
    } catch (err: any) {
      setLoadError(err.message ?? "Failed to load leads");
      setLeads([]);
      setCounts({});
      setConnected(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function runNow() {
    setRunning(true);
    setRunMessage(null);
    try {
      const res = await fetch("/api/pipeline/run-now", { method: "POST" });
      const data = await res.json();
      if (data.skipped) setRunMessage(`Skipped: ${data.skipped}`);
      else if (data.error) setRunMessage(`Error: ${data.error}`);
      else setRunMessage(`Processed ${data.leadsProcessed} lead(s).${data.errors?.length ? ` ${data.errors.length} warning(s)/error(s).` : ""}`);
      await load();
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-900">Dashboard</h1>
        <button
          onClick={runNow}
          disabled={running}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {running ? "Running..." : "Run pipeline now"}
        </button>
      </div>

      {runMessage && <div className="rounded-md border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700">{runMessage}</div>}

      {loadError && !loading && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          Failed to load leads: {loadError}
        </div>
      )}

      {!loadError && !connected && !loading && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          No Sheet connected yet. Go to <a href="/connect" className="underline">Connect</a> to get started.
        </div>
      )}

      <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
        {STAGE_ORDER.map((stage) => (
          <div key={stage} className="rounded-lg border border-slate-200 bg-white p-3 text-center">
            <p className="text-xs font-medium uppercase tracking-wide text-slate-400">{stage}</p>
            <p className="text-xl font-semibold text-slate-900">{counts[stage] ?? 0}</p>
          </div>
        ))}
      </div>

      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-2">Company</th>
              <th className="px-4 py-2">Website</th>
              <th className="px-4 py-2">Stage</th>
              <th className="px-4 py-2">Error</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-slate-400">
                  Loading...
                </td>
              </tr>
            )}
            {!loading && leads.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-slate-400">
                  No leads yet.
                </td>
              </tr>
            )}
            {leads.map((lead) => (
              <tr key={lead.rowNumber} className="border-t border-slate-100">
                <td className="px-4 py-2 font-medium text-slate-900">{lead.companyName || "—"}</td>
                <td className="px-4 py-2 text-slate-600">{lead.websiteUrl}</td>
                <td className="px-4 py-2">
                  <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STAGE_COLORS[lead.stage] ?? "bg-slate-100 text-slate-600"}`}>
                    {lead.stage || "—"}
                  </span>
                </td>
                <td className="px-4 py-2 text-red-700">{lead.lastError}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
