"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Lead = {
  rowNumber: number;
  companyName: string;
  websiteUrl: string;
  officialEmail: string;
  stage: string;
  lastError: string;
  mxStatus: string;
  followup1DraftId: string;
  followup2DraftId: string;
  followup3DraftId: string;
};

const FOLLOW_UPS = [
  { step: 1, label: "Follow-up 1", key: "followup1DraftId" },
  { step: 2, label: "Follow-up 2", key: "followup2DraftId" },
  { step: 3, label: "Final follow-up", key: "followup3DraftId" },
] as const;

const STAGE_COLORS: Record<string, string> = {
  SOURCED: "bg-slate-100 text-slate-700",
  ENRICHED: "bg-blue-100 text-blue-800",
  VERIFIED: "bg-indigo-100 text-indigo-800",
  OUTREACH: "bg-amber-100 text-amber-800",
  QA: "bg-purple-100 text-purple-800",
  DRAFTED: "bg-green-100 text-green-800",
};

// mxStatus is stored as "X/Y valid" — X of the Y found addresses (Official/
// Secondary/Another) have a domain confirmed able to receive mail.
function mxBadge(mxStatus: string): { label: string; className: string } | null {
  const match = mxStatus.match(/^(\d+)\/(\d+) valid$/);
  if (!match) return null;
  const valid = Number(match[1]);
  const total = Number(match[2]);
  if (total === 0) return null;
  if (valid === total) return { label: mxStatus, className: "bg-green-100 text-green-800" };
  if (valid === 0) return { label: mxStatus, className: "bg-red-100 text-red-800" };
  return { label: mxStatus, className: "bg-amber-100 text-amber-800" };
}

const STAGE_ORDER = ["SOURCED", "ENRICHED", "VERIFIED", "OUTREACH", "QA", "DRAFTED"];

// "Run until done" safety limits. A lead needs at most 5 runs to reach DRAFTED and
// each run handles 10 leads, so 40 rounds covers roughly 80 leads in one click.
const MAX_ROUNDS = 40;
const MAX_LOCK_RETRIES = 5;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export default function DashboardPage() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [connected, setConnected] = useState(true);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [runMessage, setRunMessage] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [gmailDisconnected, setGmailDisconnected] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [looping, setLooping] = useState(false);
  const [loopStatus, setLoopStatus] = useState<string | null>(null);
  const stopRef = useRef(false);

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
      setGmailDisconnected(!!data.gmailDisconnected);
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

  async function draftFollowUp(lead: Lead, step: number, label: string) {
    setBusyKey(`${lead.rowNumber}-${step}`);
    setActionMessage(null);
    try {
      const res = await fetch("/api/leads/followup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rowNumber: lead.rowNumber, step, websiteUrl: lead.websiteUrl }),
      });
      const text = await res.text();
      const data = text ? JSON.parse(text) : {};
      setActionMessage({
        ok: !!data.ok,
        text: `${lead.companyName || lead.websiteUrl} — ${label}: ${data.message ?? `Request failed (${res.status})`}`,
      });
      if (data.ok) await load();
    } catch (err: any) {
      setActionMessage({ ok: false, text: `${lead.companyName || lead.websiteUrl} — ${label}: ${err.message}` });
    } finally {
      setBusyKey(null);
    }
  }

  // Reads the lead list without touching the "Loading..." state, so the table
  // updates in place while the loop runs.
  async function fetchLeadsData(): Promise<{ leads: Lead[]; counts: Record<string, number> }> {
    const res = await fetch("/api/leads", { cache: "no-store" });
    const text = await res.text();
    const data = text ? JSON.parse(text) : {};
    if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
    setLeads(data.leads ?? []);
    setCounts(data.counts ?? {});
    setConnected(data.connected ?? false);
    setGmailDisconnected(!!data.gmailDisconnected);
    return { leads: data.leads ?? [], counts: data.counts ?? {} };
  }

  // One pipeline run moves each waiting lead a single stage, so this repeats runs
  // until every lead is DRAFTED, or until a round changes nothing (the remaining
  // leads are stuck — their Error column says why), or the user presses Stop.
  async function runUntilDone() {
    stopRef.current = false;
    setLooping(true);
    setRunMessage(null);
    setActionMessage(null);
    let summary = "";
    try {
      let current = await fetchLeadsData();
      const isPending = (l: Lead) => l.stage.trim().toUpperCase() !== "DRAFTED";
      if (current.leads.filter(isPending).length === 0) {
        summary = "Nothing to run — every lead is already drafted.";
      } else {
        const signature = (ls: Lead[]) => ls.map((l) => `${l.rowNumber}:${l.stage}:${l.lastError}`).join("|");
        let before = signature(current.leads);
        let round = 0;
        let lockRetries = 0;
        while (true) {
          if (stopRef.current) {
            summary = "Stopped. Click Run until done to continue.";
            break;
          }
          if (round >= MAX_ROUNDS) {
            summary = `Paused after ${MAX_ROUNDS} rounds. Click Run until done to continue.`;
            break;
          }
          setLoopStatus(`Round ${round + 1} — ${current.leads.filter(isPending).length} lead(s) still in progress...`);
          const res = await fetch("/api/pipeline/run-now", { method: "POST" });
          const text = await res.text();
          const data = text ? JSON.parse(text) : {};
          if (data.error) {
            summary = `Stopped: ${data.error}`;
            break;
          }
          if (data.skipped) {
            // Another run (for example a scheduler) holds the lock — wait and retry a few times.
            if (/lock/i.test(data.skipped) && lockRetries < MAX_LOCK_RETRIES) {
              lockRetries += 1;
              await sleep(3000);
              continue;
            }
            summary = `Stopped: ${data.skipped}`;
            break;
          }
          lockRetries = 0;
          round += 1;
          current = await fetchLeadsData();
          const pending = current.leads.filter(isPending);
          if (pending.length === 0) {
            summary = `Done — all leads are drafted (${round} round${round === 1 ? "" : "s"}).`;
            break;
          }
          const after = signature(current.leads);
          if (after === before) {
            summary = `Stopped after ${round} round(s): ${pending.length} lead(s) can't move further — check their Error column.`;
            break;
          }
          before = after;
          await sleep(400);
        }
      }
    } catch (err: any) {
      summary = `Stopped: ${err.message ?? "unexpected error"}`;
    } finally {
      setLooping(false);
      setLoopStatus(null);
      setRunMessage(summary);
    }
  }

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
        <div className="flex flex-wrap gap-2">
          <button
            onClick={runNow}
            disabled={running || looping}
            className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50"
            title="One pipeline step for every waiting lead"
          >
            {running ? "Running..." : "Run pipeline now"}
          </button>
          <button
            onClick={runUntilDone}
            disabled={running || looping}
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
            title="Repeat the pipeline until every lead is drafted"
          >
            {looping ? "Running until done..." : "Run until done"}
          </button>
        </div>
      </div>

      {looping && loopStatus && (
        <div className="flex items-center justify-between gap-4 rounded-md border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">
          <span>{loopStatus}</span>
          <button
            onClick={() => {
              stopRef.current = true;
              setLoopStatus("Stopping after this round...");
            }}
            className="whitespace-nowrap rounded-md border border-blue-300 bg-white px-3 py-1 font-medium text-blue-900 hover:bg-blue-100"
          >
            Stop
          </button>
        </div>
      )}

      {runMessage &&<div className="rounded-md border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700">{runMessage}</div>}

      {actionMessage && (
        <div
          className={`rounded-md border px-4 py-3 text-sm ${
            actionMessage.ok ? "border-green-200 bg-green-50 text-green-800" : "border-amber-200 bg-amber-50 text-amber-900"
          }`}
        >
          {actionMessage.text}
        </div>
      )}

      {gmailDisconnected && !loading && (
        <div className="flex items-center justify-between gap-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          <span>Gmail is disconnected (it expired, was revoked, or was disconnected on purpose). The pipeline is paused until you connect an account.</span>
          <a href="/api/oauth/google" className="whitespace-nowrap rounded-md bg-red-700 px-3 py-1.5 font-medium text-white hover:bg-red-800">
            Reconnect Gmail
          </a>
        </div>
      )}

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

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-2">Company</th>
              <th className="px-4 py-2">Website</th>
              <th className="px-4 py-2">Stage</th>
              <th className="min-w-[110px] whitespace-nowrap px-4 py-2">MX/Domain</th>
              <th className="px-4 py-2">Error</th>
              <th className="min-w-[190px] px-4 py-2">Action</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-slate-400">
                  Loading...
                </td>
              </tr>
            )}
            {!loading && leads.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-slate-400">
                  No leads yet.
                </td>
              </tr>
            )}
            {leads.map((lead) => {
              const mx = mxBadge(lead.mxStatus);
              return (
                <tr key={lead.rowNumber} className="border-t border-slate-100">
                  <td className="px-4 py-2 font-medium text-slate-900">{lead.companyName || "—"}</td>
                  <td className="px-4 py-2 text-slate-600">{lead.websiteUrl}</td>
                  <td className="px-4 py-2">
                    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STAGE_COLORS[lead.stage] ?? "bg-slate-100 text-slate-600"}`}>
                      {lead.stage || "—"}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-4 py-2">
                    {mx ? (
                      <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${mx.className}`}>{mx.label}</span>
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-red-700">{lead.lastError}</td>
                  <td className="px-4 py-2">
                    {lead.stage.trim().toUpperCase() === "DRAFTED" ? (
                      <div className="flex flex-wrap gap-1.5">
                        {FOLLOW_UPS.map(({ step, label, key }) => {
                          const done = !!lead[key]?.trim();
                          const previousDone = step === 1 || !!lead[FOLLOW_UPS[step - 2].key]?.trim();
                          const busy = busyKey === `${lead.rowNumber}-${step}`;
                          return (
                            <button
                              key={step}
                              onClick={() => draftFollowUp(lead, step, label)}
                              disabled={busyKey !== null || looping || (!done && !previousDone)}
                              title={
                                done ? `${label} was drafted — click to re-check its status` : !previousDone ? "Draft the previous follow-up first" : `Draft ${label} in the same Gmail thread`
                              }
                              className={`whitespace-nowrap rounded-md border px-2 py-1 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-40 ${
                                done
                                  ? "border-green-300 bg-green-50 text-green-800"
                                  : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                              }`}
                            >
                              {busy ? "Drafting..." : done ? `${label} ✓` : label}
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
