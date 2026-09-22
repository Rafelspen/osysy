"use client";

// The "Open & enrich" bulk tool, opened from the Reach card. It lists every
// lead in one of two views (Needs enrichment / Enriched), lets you tick
// addresses across many leads at once, and runs them through a fallback
// chain of the services you pick (try the first checked one; anything it
// doesn't resolve — a failure, or an Unknown result — is retried with the
// next checked one). It reads the same lead data and the same shared
// selection as the rest of the dashboard, and every network call goes
// through the existing, already-tested /api/leads/verify endpoint (run once
// per provider per lead, chunked to that endpoint's own 3-address limit) —
// this file adds no new server-side logic.

import { useEffect, useRef, useState } from "react";
import type { ApiProviderId, ProviderStatus } from "@/lib/email-verifier";
import { leadEmails, normalizeEmail, overallVerdict, parseStore, PROVIDER_IDS, type EmailChecks } from "@/lib/verification-store";
import { ResultChips, type VLead } from "./verification";

// Mirrors MAX_EMAILS_PER_REQUEST in src/lib/verify-lead.ts. Not imported directly —
// that file pulls in server-only modules (Sheets, Google auth) that must never
// reach the client bundle.
export const MAX_ENRICH_CHUNK = 3;

const PROVIDER_LABEL: Record<ApiProviderId, string> = { zerobounce: "ZeroBounce", hunter: "Hunter", clay: "Clay" };

export type EnrichJob = { lead: VLead; emails: string[] };

export type EnrichRow = { email: string; checks: EmailChecks | undefined; checked: boolean };
export type EnrichGroup = { lead: VLead; rows: EnrichRow[]; hasUnchecked: boolean };

// Pure — split out so it's covered by the same lib-style tests as the rest of the
// verification logic, without needing to render the modal.
export function groupLeadsForTab(leads: VLead[], tab: "needs" | "enriched"): EnrichGroup[] {
  return leads
    .map((lead) => {
      const store = parseStore(lead.emailVerified);
      const rows: EnrichRow[] = leadEmails(lead).map((email) => {
        const checks = store[normalizeEmail(email)];
        return { email, checks, checked: overallVerdict(checks) !== null };
      });
      const shown = tab === "needs" ? rows : rows.filter((r) => r.checked);
      return { lead, rows: shown, hasUnchecked: rows.some((r) => !r.checked) };
    })
    .filter((g) => (tab === "needs" ? g.hasUnchecked : g.rows.length > 0));
}

// Selected addresses that still need enrichment, across every lead — never an
// already-enriched one, even if it happens to be selected via some other part of
// the dashboard (the per-lead popover selects regardless of status).
export function buildEnrichJobs(leads: VLead[], isSelected: (rowNumber: number, email: string) => boolean): EnrichJob[] {
  return leads
    .map((lead) => {
      const store = parseStore(lead.emailVerified);
      const emails = leadEmails(lead).filter(
        (email) => overallVerdict(store[normalizeEmail(email)]) === null && isSelected(lead.rowNumber, email)
      );
      return { lead, emails };
    })
    .filter((j) => j.emails.length > 0);
}

function providerAvailable(id: ApiProviderId, providers: ProviderStatus[]): boolean {
  const info = providers.find((p) => p.id === id);
  if (!info?.configured) return false;
  // Clay only runs automatically once CLAY_API_KEY + CLAY_FUNCTION_ID are set
  // (see email-verifier.ts); in manual mode it can't be part of a bulk run.
  if (id === "clay" && info.kind !== "api") return false;
  return true;
}

export function EnrichmentModal(props: {
  leads: VLead[];
  providers: ProviderStatus[];
  isSelected: (rowNumber: number, email: string) => boolean;
  toggle: (lead: VLead, email: string) => void;
  running: boolean;
  status: string | null;
  onEnrich: (jobs: EnrichJob[], providerOrder: ApiProviderId[]) => void;
  onStop: () => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<"needs" | "enriched">("needs");
  const [checkedProviders, setCheckedProviders] = useState<Set<ApiProviderId>>(new Set());
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      opener?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const groups = groupLeadsForTab(props.leads, tab);
  // Selected addresses that still need enrichment, across every lead (not just the
  // ones visible in the current tab) — this drives the button's count and the run.
  const selectedJobs = buildEnrichJobs(props.leads, props.isSelected);
  const selectedCount = selectedJobs.reduce((n, j) => n + j.emails.length, 0);
  const providerOrder = PROVIDER_IDS.filter((id) => checkedProviders.has(id)) as ApiProviderId[];

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 sm:p-8"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="enrichment-title"
        className="relative w-full max-w-3xl space-y-4 rounded-lg border border-slate-200 bg-white p-6 shadow-lg"
      >
        <div className="flex items-start justify-between gap-4">
          <h2 id="enrichment-title" className="text-lg font-semibold text-slate-900">
            Open &amp; enrich
          </h2>
          <button
            ref={closeRef}
            type="button"
            onClick={props.onClose}
            aria-label="Close"
            className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-sm text-slate-700 hover:bg-slate-50"
          >
            ×
          </button>
        </div>

        <div className="flex gap-2" role="tablist" aria-label="Filter leads">
          {(["needs", "enriched"] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={`rounded-md border px-3 py-1.5 text-sm font-medium ${
                tab === t ? "border-slate-900 bg-slate-900 text-white" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
              }`}
            >
              {t === "needs" ? "Needs enrichment" : "Enriched"}
            </button>
          ))}
        </div>

        {props.status && (
          <p role="status" className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-900">
            {props.status}
          </p>
        )}

        <div className="max-h-[50vh] space-y-3 overflow-y-auto pr-1">
          {groups.length === 0 && (
            <p className="text-sm text-slate-500">
              {tab === "needs" ? "Every address has already been checked at least once." : "Nothing has been checked yet."}
            </p>
          )}
          {groups.map(({ lead, rows }) => (
            <div key={lead.rowNumber} className="rounded-md border border-slate-200 p-3">
              <p className="mb-2 flex flex-wrap items-center gap-2 text-sm font-semibold text-slate-800">
                <span>
                  {lead.companyName || lead.websiteUrl} <span className="font-normal text-slate-400">· Sheet row {lead.rowNumber}</span>
                </span>
                {tab === "needs" && (
                  <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800">
                    {rows.filter((r) => !r.checked).length}/{rows.length} needs enrichment
                  </span>
                )}
              </p>
              <ul className="space-y-1.5">
                {rows.map(({ email, checks, checked }) => (
                  <li key={email} className="flex flex-wrap items-center gap-2">
                    {!checked ? (
                      <label className="needs-enrichment-glow flex min-w-0 items-center gap-2 rounded-md px-2 py-1 text-sm text-slate-800">
                        <input
                          type="checkbox"
                          checked={props.isSelected(lead.rowNumber, email)}
                          onChange={() => props.toggle(lead, email)}
                          disabled={props.running}
                          aria-label={`Select ${email} for enrichment`}
                        />
                        <span className="min-w-0 break-all">{email}</span>
                      </label>
                    ) : (
                      <span className="min-w-0 break-all text-sm text-slate-500">{email}</span>
                    )}
                    {checked ? (
                      <>
                        {/* Blue on purpose: green is already the "Deliverable" verdict colour used right next to
                            this by ResultChips, and this badge means something different ("already checked",
                            regardless of the result) — a matching colour would read as if it meant the same thing. */}
                        <span className="rounded-full bg-blue-100 px-2 py-0.5 text-[11px] font-medium text-blue-800">Enriched</span>
                        <ResultChips checks={checks} />
                      </>
                    ) : (
                      <span className="text-[11px] text-slate-400">needs enrichment</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {tab === "needs" && (
          <div className="space-y-2 border-t border-slate-100 pt-3">
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={props.running || selectedCount === 0 || providerOrder.length === 0}
                onClick={() => props.onEnrich(selectedJobs, providerOrder)}
                title={
                  selectedCount === 0
                    ? "Tick at least one address below"
                    : providerOrder.length === 0
                      ? "Choose at least one service"
                      : `Enrich ${selectedCount} address${selectedCount === 1 ? "" : "es"}`
                }
                className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {props.running ? "Enriching..." : `Enrich (${selectedCount} selected)`}
              </button>
              {props.running && (
                <button
                  type="button"
                  onClick={props.onStop}
                  className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  Stop
                </button>
              )}
              <div className="flex flex-wrap items-center gap-3 text-sm text-slate-700">
                {PROVIDER_IDS.map((id) => {
                  const available = providerAvailable(id, props.providers);
                  const info = props.providers.find((p) => p.id === id);
                  const reason =
                    id === "clay" && info && info.kind !== "api"
                      ? "Clay is in manual mode — set CLAY_API_KEY and CLAY_FUNCTION_ID to include it here"
                      : `${PROVIDER_LABEL[id]} isn't set up yet`;
                  return (
                    <label key={id} className={`flex items-center gap-1.5 ${available ? "" : "opacity-40"}`} title={available ? `Include ${PROVIDER_LABEL[id]}` : reason}>
                      <input
                        type="checkbox"
                        disabled={!available || props.running}
                        checked={checkedProviders.has(id)}
                        onChange={(e) =>
                          setCheckedProviders((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(id);
                            else next.delete(id);
                            return next;
                          })
                        }
                      />
                      {PROVIDER_LABEL[id]}
                    </label>
                  );
                })}
              </div>
            </div>
            <p className="text-[11px] leading-relaxed text-slate-400">
              Checked services run in order — ZeroBounce, then Hunter, then Clay — as a fallback chain: whatever the
              first one doesn&rsquo;t resolve (a failure, or an Unknown result) is retried with the next one you
              checked. Each attempt spends that service&rsquo;s credits.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
