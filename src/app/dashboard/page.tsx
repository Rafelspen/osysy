"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiProviderId, ProviderStatus } from "@/lib/email-verifier";
import { leadEmails, parseStore, summarizeLead, type ProviderId, type Verdict } from "@/lib/verification-store";
import { EmailPopover, SelectedEmailsPanel, useSelection, VerifyButtons } from "./verification";
import { EmailStatusCard, ReachSignalCard } from "./summary";
import { EnrichmentModal, MAX_ENRICH_CHUNK, type EnrichJob } from "./enrichment";
import {
  FOLLOW_UPS,
  LeadDetailsDialog,
  mxBadge,
  splitLastError,
  STAGE_COLORS,
  STAGE_ORDER,
  TONE_CLASS,
} from "./lead-details";

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
  source?: string;
  greetingName?: string;
  gmailDraftId?: string;
  threadId?: string;
  followup1DraftId: string;
  followup2DraftId: string;
  followup3DraftId: string;
  abVariant?: string;
};

// "Run until done" safety limits. A lead needs at most 5 runs to reach DRAFTED and
// each run handles 10 leads, so 40 rounds covers roughly 80 leads in one click.
const MAX_ROUNDS = 40;
const MAX_LOCK_RETRIES = 5;
// Browsers word "can't reach the server" differently and unhelpfully ("Failed to fetch"...).
function friendlyError(err: any, fallback: string): string {
  const msg = String(err?.message ?? "");
  if (err instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(msg)) {
    return "Couldn't reach the app — check your connection and try again.";
  }
  return msg || fallback;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const PROVIDER_LABEL: Record<ApiProviderId, string> = { zerobounce: "ZeroBounce", hunter: "Hunter", clay: "Clay" };

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
  const [details, setDetails] = useState<{ rowNumber: number; websiteUrl: string } | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [looping, setLooping] = useState(false);
  const [loopStatus, setLoopStatus] = useState<string | null>(null);
  const stopRef = useRef(false);
  const [enrichOpen, setEnrichOpen] = useState(false);
  const [enrichRunning, setEnrichRunning] = useState(false);
  const [enrichStatus, setEnrichStatus] = useState<string | null>(null);
  const enrichStopRef = useRef(false);
  // Any large batch action (the pipeline loop or bulk enrichment) blocks the other —
  // both can write to the same Sheet, so they never run at the same time.
  const batchBusy = looping || enrichRunning;

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
      setActionMessage({ ok: false, text: `${name} — ${friendlyError(err, "Check failed")}` });
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
          ? `${name} — copied ${emails.length} address${emails.length === 1 ? "" : "es"}. Paste them into a Clay table, run its email verification, then record the answer with "Set result from" (Clay) in the panel on the left.`
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

  async function recordManual(lead: Lead, email: string, provider: ProviderId, verdict: Verdict | "") {
    setVerifyBusy("record");
    try {
      const body = { rowNumber: lead.rowNumber, websiteUrl: lead.websiteUrl, email, provider };
      const { status, data } = await postJson(
        "/api/leads/verify/record",
        verdict ? { ...body, action: "set", verdict } : { ...body, action: "clear" }
      );
      if (!data.ok) setActionMessage({ ok: false, text: `${email} — ${data.message ?? `Couldn't save (${status})`}` });
      await refreshQuietly();
    } catch (err: any) {
      setActionMessage({ ok: false, text: `${email} — ${friendlyError(err, "Couldn't save")}` });
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
      setActionMessage({ ok: false, text: `${email} — ${friendlyError(err, "Couldn't reset")}` });
    } finally {
      setVerifyBusy(null);
    }
  }

  // Runs each lead's selected (never-checked) addresses through the checked services
  // in order, as a fallback chain: whatever a service doesn't resolve (a failure, or
  // an Unknown verdict) is retried with the next checked service. Calls the same
  // /api/leads/verify endpoint the per-row buttons use — one request per provider per
  // lead, chunked to its 3-address limit — so no new server-side logic is involved.
  async function runBulkEnrichment(jobs: EnrichJob[], providerOrder: ApiProviderId[]) {
    if (jobs.length === 0 || providerOrder.length === 0) return;
    enrichStopRef.current = false;
    setEnrichRunning(true);
    setActionMessage(null);
    let leadsDone = 0;
    let addressesEnriched = 0;
    const totalJobs = jobs.length;
    try {
      for (const job of jobs) {
        if (enrichStopRef.current) break;
        const name = job.lead.companyName || job.lead.websiteUrl;
        let remaining = [...job.emails];
        for (const provider of providerOrder) {
          if (remaining.length === 0 || enrichStopRef.current) break;
          const stillUnresolved: string[] = [];
          for (let i = 0; i < remaining.length; i += MAX_ENRICH_CHUNK) {
            if (enrichStopRef.current) break;
            const chunk = remaining.slice(i, i + MAX_ENRICH_CHUNK);
            setEnrichStatus(`${name} — trying ${PROVIDER_LABEL[provider]} for ${chunk.length} address${chunk.length === 1 ? "" : "es"}...`);
            try {
              const { data } = await postJson("/api/leads/verify", {
                rowNumber: job.lead.rowNumber,
                websiteUrl: job.lead.websiteUrl,
                provider,
                emails: chunk,
              });
              const outcomes: Array<{ email: string; status: string; verdict?: string }> = data.outcomes ?? [];
              const resolved = new Set(
                outcomes.filter((o) => (o.status === "checked" || o.status === "cached") && o.verdict && o.verdict !== "unknown").map((o) => o.email.toLowerCase())
              );
              addressesEnriched += resolved.size;
              for (const email of chunk) {
                if (!resolved.has(email.toLowerCase())) stillUnresolved.push(email);
              }
            } catch {
              stillUnresolved.push(...chunk); // couldn't reach the server — let the next provider try
            }
          }
          remaining = stillUnresolved;
        }
        leadsDone += 1;
        await refreshQuietly(); // the modal and table update after each lead, not only at the end
      }
    } finally {
      setEnrichRunning(false);
      setEnrichStatus(null);
      setActionMessage({
        ok: true,
        text: enrichStopRef.current
          ? `Stopped after ${leadsDone} of ${totalJobs} lead(s) — ${addressesEnriched} address${addressesEnriched === 1 ? "" : "es"} enriched.`
          : `Finished ${leadsDone} lead(s) — ${addressesEnriched} address${addressesEnriched === 1 ? "" : "es"} enriched.`,
      });
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
  // The details popup follows its lead through every refresh; if the lead is gone or the
  // Sheet row now holds a different site, the popup closes rather than show the wrong lead.
  const detailsLead = details
    ? leads.find((l) => l.rowNumber === details.rowNumber && l.websiteUrl.trim() === details.websiteUrl.trim())
    : undefined;
  useEffect(() => {
    if (details && !loading && !detailsLead) setDetails(null);
  }, [details, detailsLead, loading]);

  return (
    <div className="lg:flex lg:items-start lg:gap-6">
      <aside className={`${selectedTotal > 0 ? "" : "hidden lg:block"} mb-6 lg:mb-0 lg:w-72 lg:shrink-0`}>
        <div className="lg:sticky lg:top-6 lg:max-h-[calc(100vh-3rem)] lg:overflow-y-auto">
          <SelectedEmailsPanel
            leads={leads}
            selected={Object.values(selection.selected)}
            busy={verifyBusy !== null || batchBusy}
            onRemove={selection.remove}
            onClear={selection.clear}
            onSet={(l, email, provider, verdict) => recordManual(l as Lead, email, provider, verdict)}
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
            disabled={running || batchBusy || verifyBusy !== null}
            className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50 disabled:opacity-50"
            title="One pipeline step for every waiting lead"
          >
            {running ? "Running..." : "Run pipeline now"}
          </button>
          <button
            onClick={runUntilDone}
            disabled={running || batchBusy || verifyBusy !== null}
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

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <EmailStatusCard leads={leads} />
        <ReachSignalCard leads={leads} onOpenEnrich={() => setEnrichOpen(true)} enrichDisabled={running || looping} />
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-2">Company</th>
              <th className="px-4 py-2">Website</th>
              <th className="min-w-[125px] whitespace-nowrap px-4 py-2">Stage</th>
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
                  <td className="px-4 py-2 font-medium text-slate-900">
                    <button
                      type="button"
                      onClick={() => {
                        cancelClose();
                        setPopover(null);
                        setDetails({ rowNumber: lead.rowNumber, websiteUrl: lead.websiteUrl });
                      }}
                      aria-haspopup="dialog"
                      title="Open all the details for this lead"
                      className="text-left font-medium underline decoration-dotted underline-offset-4 hover:decoration-solid"
                    >
                      {lead.companyName || "—"}
                    </button>
                  </td>
                  <td className="px-4 py-2 text-slate-600">{lead.websiteUrl}</td>
                  <td className="px-4 py-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STAGE_COLORS[lead.stage] ?? "bg-slate-100 text-slate-600"}`}>
                        {lead.stage || "—"}
                      </span>
                      {(lead.abVariant === "A" || lead.abVariant === "B") && (
                        <span
                          title={`This lead's email sequence is using Variant ${lead.abVariant} (A/B test, set on the Templates page)`}
                          className="inline-block rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-500"
                        >
                          {lead.abVariant}
                        </span>
                      )}
                    </div>
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
                          disabled={batchBusy}
                          onVerify={(l, provider) => (provider === "clay" && providers.find((p) => p.id === "clay")?.kind !== "api" ? clayCopyAndOpen(l as Lead) : verifySelected(l as Lead, provider))}
                        />
                      </>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    {(() => {
                      const { error, warning } = splitLastError(lead.lastError);
                      return (
                        <div className="space-y-1.5">
                          {error && <div className="text-red-700">{error}</div>}
                          {warning && (
                            <div className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-800">{warning}</div>
                          )}
                        </div>
                      );
                    })()}
                  </td>
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
                              disabled={busyKey !== null || batchBusy || (!done && !previousDone)}
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

      {detailsLead && (
        <LeadDetailsDialog
          lead={detailsLead}
          providers={providers}
          isSelected={(email) => selection.isSelected(detailsLead.rowNumber, email)}
          onToggle={(email) => selection.toggle(detailsLead, email)}
          onSelectAll={() => {
            for (const email of leadEmails(detailsLead)) {
              if (!selection.isSelected(detailsLead.rowNumber, email)) selection.toggle(detailsLead, email);
            }
          }}
          onClearSelection={() => {
            for (const email of leadEmails(detailsLead)) {
              if (selection.isSelected(detailsLead.rowNumber, email)) selection.toggle(detailsLead, email);
            }
          }}
          verifyBusy={verifyBusy}
          followUpBusy={busyKey}
          looping={batchBusy}
          message={actionMessage}
          onVerify={(provider) =>
            provider === "clay" && providers.find((p) => p.id === "clay")?.kind !== "api"
              ? clayCopyAndOpen(detailsLead)
              : verifySelected(detailsLead, provider)
          }
          onSet={(email, provider, verdict) => recordManual(detailsLead, email, provider, verdict)}
          onReset={(email) => resetEmail(detailsLead, email)}
          onFollowUp={(step, label) => draftFollowUp(detailsLead, step, label)}
          onClose={() => setDetails(null)}
        />
      )}

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

      {enrichOpen && (
        <EnrichmentModal
          leads={leads}
          providers={providers}
          isSelected={selection.isSelected}
          toggle={selection.toggle}
          running={enrichRunning}
          status={enrichStatus}
          onEnrich={(jobs, order) => runBulkEnrichment(jobs, order)}
          onStop={() => {
            enrichStopRef.current = true;
            setEnrichStatus("Stopping after this address...");
          }}
          onClose={() => setEnrichOpen(false)}
        />
      )}
    </div>
  );
}
