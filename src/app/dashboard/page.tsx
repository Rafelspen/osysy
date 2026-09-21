"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ProviderStatus } from "@/lib/email-verifier";
import { leadEmails, parseStore, summarizeLead, type ProviderId, type Tone, type Verdict } from "@/lib/verification-store";
import { EmailPopover, SelectedEmailsPanel, useSelection, VerifyButtons } from "./verification";

type Lead = {
  rowNumber: number;
  companyName: string;
  websiteUrl: string;
  officialEmail: string;
  secondaryEmail: string;
  anotherEmail: string;
  stage: string;
  lastError: string;
  mxStatus: string;
  emailVerified: string;
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

// Badge colours for the Email Verified column (see summarizeLead in verification-store.ts).
const TONE_CLASS: Record<Tone, string> = {
  none: "bg-slate-100 text-slate-500",
  green: "bg-green-100 text-green-800",
  amber: "bg-amber-100 text-amber-800",
  red: "bg-red-100 text-red-800",
};

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
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [verifyBusy, setVerifyBusy] = useState<string | null>(null);
  const [popover, setPopover] = useState<{ rowNumber: number; left: number; bottom: number } | null>(null);
  const closeTimer = useRef<number | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [looping, setLooping] = useState(false);
  const [loopStatus, setLoopStatus] = useState<string | null>(null);
  const stopRef = useRef(false);

  // Selection is only reconciled against the Sheet once a real, successful load happened.
  const selection = useSelection(leads, !loading && !loadError && connected && !gmailDisconnected);

  function cancelClose() {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }
  function scheduleClose() {
    cancelClose();
    closeTimer.current = window.setTimeout(() => setPopover(null), 220);
  }
  function openPopover(lead: Lead, el: HTMLElement) {
    cancelClose();
    const r = el.getBoundingClientRect();
    setPopover({ rowNumber: lead.rowNumber, left: r.left, bottom: r.bottom });
  }

  // The popup is positioned from the badge, so close it when the page moves; also
  // close on Escape or a click anywhere else.
  useEffect(() => {
    if (!popover) return;
    const close = () => setPopover(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target?.closest("[data-email-popover]") && !target?.closest("[data-email-badge]")) close();
    };
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [popover]);

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
      setProviders(data.verifiers ?? []);
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
    setProviders(data.verifiers ?? []);
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

  async function postJson(url: string, body: unknown): Promise<{ status: number; data: any }> {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const text = await res.text();
    let data: any = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = {};
    }
    return { status: res.status, data };
  }

  // Refreshing is best-effort: a failed refresh must never hide the result message.
  async function refreshQuietly() {
    try {
      await fetchLeadsData();
    } catch {
      // the next load will catch up
    }
  }

  // Checks the lead's selected addresses with ZeroBounce or Hunter.
  async function verifySelected(lead: Lead, provider: ProviderId) {
    const emails = selection.forLead(lead);
    if (emails.length === 0) return;
    setVerifyBusy(`${lead.rowNumber}-${provider}`);
    setActionMessage(null);
    const name = lead.companyName || lead.websiteUrl;
    try {
      const { status, data } = await postJson("/api/leads/verify", {
        rowNumber: lead.rowNumber,
        websiteUrl: lead.websiteUrl,
        provider,
        emails,
      });
      setActionMessage({ ok: !!data.ok, text: `${name} — ${data.message ?? `Request failed (${status})`}` });
      await refreshQuietly(); // results that succeeded are saved even if others failed
    } catch (err: any) {
      setActionMessage({ ok: false, text: `${name} — ${err.message ?? "Check failed"}` });
    } finally {
      setVerifyBusy(null);
    }
  }

  // Clay has no API on its free plan: copy the addresses and open Clay; the
  // result is entered by hand in the panel on the left.
  function clayCopyAndOpen(lead: Lead) {
    const emails = selection.forLead(lead);
    if (emails.length === 0) return;
    const name = lead.companyName || lead.websiteUrl;
    const text = emails.join("\n");
    // Open first, synchronously, so the browser treats it as a direct click.
    window.open("https://app.clay.com", "_blank", "noopener,noreferrer");
    const done = (copied: boolean) =>
      setActionMessage({
        ok: copied,
        text: copied
          ? `${name} — copied ${emails.length} address${emails.length === 1 ? "" : "es"}. Paste them into a Clay table, run its email verification, then choose the result under "Clay result" in the panel on the left.`
          : `${name} — couldn't copy automatically. Addresses: ${emails.join(", ")}`,
      });
    const fallback = () => {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        done(ok);
      } catch {
        done(false);
      }
    };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(() => done(true), fallback);
    else fallback();
  }

  async function recordClay(lead: Lead, email: string, verdict: Verdict | "") {
    setVerifyBusy("record");
    try {
      const body = { rowNumber: lead.rowNumber, websiteUrl: lead.websiteUrl, email, provider: "clay" };
      const { status, data } = await postJson(
        "/api/leads/verify/record",
        verdict ? { ...body, action: "set", verdict } : { ...body, action: "clear" }
      );
      if (!data.ok) setActionMessage({ ok: false, text: `${email} — ${data.message ?? `Couldn't save (${status})`}` });
      await refreshQuietly();
    } catch (err: any) {
      setActionMessage({ ok: false, text: `${email} — ${err.message ?? "Couldn't save"}` });
    } finally {
      setVerifyBusy(null);
    }
  }

  async function resetEmail(lead: Lead, email: string) {
    if (!window.confirm(`Forget all verification results for ${email}? It can then be checked again (this may use credits).`)) return;
    setVerifyBusy("record");
    try {
      const { status, data } = await postJson("/api/leads/verify/record", {
        rowNumber: lead.rowNumber,
        websiteUrl: lead.websiteUrl,
        email,
        action: "reset",
      });
      if (!data.ok) setActionMessage({ ok: false, text: `${email} — ${data.message ?? `Couldn't reset (${status})`}` });
      await refreshQuietly();
    } catch (err: any) {
      setActionMessage({ ok: false, text: `${email} — ${err.message ?? "Couldn't reset"}` });
    } finally {
      setVerifyBusy(null);
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

  const selectedTotal = Object.keys(selection.selected).length;
  const popoverLead = popover ? leads.find((l) => l.rowNumber === popover.rowNumber) : undefined;

  return (
    <div className="lg:flex lg:items-start lg:gap-6">
      <aside className={`${selectedTotal > 0 ? "" : "hidden lg:block"} mb-6 lg:mb-0 lg:w-72 lg:shrink-0`}>
        <div className="lg:sticky lg:top-6 lg:max-h-[calc(100vh-3rem)] lg:overflow-y-auto">
          <SelectedEmailsPanel
            leads={leads}
            selected={Object.values(selection.selected)}
            busy={verifyBusy !== null || looping}
            onRemove={selection.remove}
            onClear={selection.clear}
            onClay={(l, email, verdict) => recordClay(l as Lead, email, verdict)}
            onReset={(l, email) => resetEmail(l as Lead, email)}
          />
        </div>
      </aside>

      <div className="min-w-0 flex-1 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-slate-900">Dashboard</h1>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={runNow}
            disabled={running || looping || verifyBusy !== null}
            className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50"
            title="One pipeline step for every waiting lead"
          >
            {running ? "Running..." : "Run pipeline now"}
          </button>
          <button
            onClick={runUntilDone}
            disabled={running || looping || verifyBusy !== null}
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
              <th className="min-w-[120px] whitespace-nowrap px-4 py-2">Email Verified</th>
              <th className="px-4 py-2">Error</th>
              <th className="min-w-[190px] px-4 py-2">Action</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-slate-400">
                  Loading...
                </td>
              </tr>
            )}
            {!loading && leads.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-slate-400">
                  No leads yet.
                </td>
              </tr>
            )}
            {leads.map((lead) => {
              const mx = mxBadge(lead.mxStatus);
              const emails = leadEmails(lead);
              const summary = summarizeLead(parseStore(lead.emailVerified), emails);
              const selectedCount = selection.forLead(lead).length;
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
                  <td className="min-w-[210px] px-4 py-2">
                    {emails.length === 0 ? (
                      <span className="text-slate-300">—</span>
                    ) : (
                      <>
                        <button
                          type="button"
                          data-email-badge=""
                          aria-haspopup="dialog"
                          aria-expanded={popover?.rowNumber === lead.rowNumber}
                          onMouseEnter={(e) => openPopover(lead, e.currentTarget)}
                          onMouseLeave={scheduleClose}
                          onClick={(e) => openPopover(lead, e.currentTarget)}
                          title={`${summary.checked} of ${summary.total} address${summary.total === 1 ? "" : "es"} checked — hover to choose which to verify`}
                          className={`inline-block whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ${TONE_CLASS[summary.tone]}`}
                        >
                          {summary.label}
                          {selectedCount > 0 ? ` · ${selectedCount} selected` : ""}
                        </button>
                        <VerifyButtons
                          lead={lead}
                          selectedCount={selectedCount}
                          providers={providers}
                          busyKey={verifyBusy}
                          disabled={looping}
                          onVerify={(l, provider) => (provider === "clay" ? clayCopyAndOpen(l as Lead) : verifySelected(l as Lead, provider))}
                        />
                      </>
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

      {popover && popoverLead && (
        <EmailPopover
          lead={popoverLead}
          anchor={{ left: popover.left, bottom: popover.bottom }}
          isSelected={(email) => selection.isSelected(popoverLead.rowNumber, email)}
          onToggle={(email) => selection.toggle(popoverLead, email)}
          onEnter={cancelClose}
          onLeave={scheduleClose}
        />
      )}
    </div>
  );
}
