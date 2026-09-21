"use client";

// Email verification UI: selection state, the popup on the "Email Verified"
// badge, the left-hand "Selected emails" panel and the per-lead service buttons.
// Everything reads the same two things — the leads from the Sheet (results live
// in each lead's email_verified cell) and one shared selection — so the badge,
// popup, panel and buttons cannot disagree.

import { useEffect, useState } from "react";
import type { ProviderStatus } from "@/lib/email-verifier";
import {
  leadEmails,
  normalizeEmail,
  parseStore,
  PROVIDER_IDS,
  VERDICTS,
  type EmailChecks,
  type ProviderId,
  type Verdict,
} from "@/lib/verification-store";

export type VLead = {
  rowNumber: number;
  companyName: string;
  websiteUrl: string;
  officialEmail: string;
  secondaryEmail: string;
  anotherEmail: string;
  emailVerified: string;
};

export type Selected = { rowNumber: number; websiteUrl: string; email: string };

const STORAGE_KEY = "obsys.selectedEmails.v1";
export const selKey = (rowNumber: number, email: string) => `${rowNumber}|${normalizeEmail(email)}`;

const VERDICT_STYLE: Record<Verdict, string> = {
  deliverable: "bg-green-100 text-green-800",
  undeliverable: "bg-red-100 text-red-800",
  risky: "bg-amber-100 text-amber-800",
  unknown: "bg-slate-100 text-slate-600",
};
const VERDICT_WORD: Record<Verdict, string> = {
  deliverable: "Deliverable",
  undeliverable: "Undeliverable",
  risky: "Risky",
  unknown: "Unknown",
};
const PROVIDER_NAME: Record<ProviderId, string> = { zerobounce: "ZeroBounce", hunter: "Hunter", clay: "Clay" };

// ---------------------------------------------------------------------------
// Shared selection (survives a page reload; entries that no longer match the
// Sheet are dropped once the leads have loaded).
// ---------------------------------------------------------------------------

export function useSelection(leads: VLead[], ready: boolean) {
  const [selected, setSelected] = useState<Record<string, Selected>>({});
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const clean: Record<string, Selected> = {};
        for (const v of Object.values(parsed as Record<string, any>)) {
          if (v && typeof v.rowNumber === "number" && typeof v.websiteUrl === "string" && typeof v.email === "string") {
            clean[selKey(v.rowNumber, v.email)] = { rowNumber: v.rowNumber, websiteUrl: v.websiteUrl, email: v.email };
          }
        }
        setSelected(clean);
      }
    } catch {
      // storage unavailable or corrupted — start empty
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(selected));
    } catch {
      // ignore
    }
  }, [selected, hydrated]);

  // Drop selections whose lead or address is no longer in the Sheet.
  useEffect(() => {
    if (!hydrated || !ready) return;
    setSelected((prev) => {
      let changed = false;
      const next: Record<string, Selected> = {};
      for (const [k, s] of Object.entries(prev)) {
        const lead = leads.find((l) => l.rowNumber === s.rowNumber && l.websiteUrl.trim() === s.websiteUrl.trim());
        const stillThere = !!lead && leadEmails(lead).some((e) => normalizeEmail(e) === normalizeEmail(s.email));
        if (stillThere) next[k] = s;
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [leads, ready, hydrated]);

  return {
    selected,
    isSelected: (rowNumber: number, email: string) => selKey(rowNumber, email) in selected,
    toggle: (lead: VLead, email: string) =>
      setSelected((prev) => {
        const key = selKey(lead.rowNumber, email);
        if (key in prev) {
          const next = { ...prev };
          delete next[key];
          return next;
        }
        return { ...prev, [key]: { rowNumber: lead.rowNumber, websiteUrl: lead.websiteUrl, email } };
      }),
    remove: (key: string) =>
      setSelected((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      }),
    clear: () => setSelected({}),
    // The lead's currently selected addresses, in column order.
    forLead: (lead: VLead): string[] => leadEmails(lead).filter((e) => selKey(lead.rowNumber, e) in selected),
  };
}

// ---------------------------------------------------------------------------
// Small pieces
// ---------------------------------------------------------------------------

// One chip per service that checked the address, "Service: Result", coloured by the result.
// "Not checked" when no service has looked at it yet.
function ResultChips({ checks }: { checks: EmailChecks | undefined }) {
  const present = PROVIDER_IDS.filter((id) => checks?.[id]);
  if (present.length === 0) {
    return <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-500">Not checked</span>;
  }
  return (
    <span className="flex flex-wrap gap-1">
      {present.map((id) => {
        const c = checks![id]!;
        const when = c.t ? new Date(c.t).toLocaleString() : "";
        return (
          <span
            key={id}
            title={`${PROVIDER_NAME[id]}: ${VERDICT_WORD[c.v]}${c.raw ? ` (${c.raw})` : ""}${when ? ` — ${when}` : ""}`}
            className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ${VERDICT_STYLE[c.v]}`}
          >
            {PROVIDER_NAME[id]}: {VERDICT_WORD[c.v]}
          </span>
        );
      })}
    </span>
  );
}

// ---------------------------------------------------------------------------
// The popup shown when hovering (or tapping) the Email Verified badge
// ---------------------------------------------------------------------------

export function EmailPopover(props: {
  lead: VLead;
  anchor: { left: number; bottom: number };
  isSelected: (email: string) => boolean;
  onToggle: (email: string) => void;
  onEnter: () => void;
  onLeave: () => void;
}) {
  const { lead, anchor } = props;
  const emails = leadEmails(lead);
  const store = parseStore(lead.emailVerified);
  const left = Math.max(8, Math.min(anchor.left, (typeof window !== "undefined" ? window.innerWidth : 1200) - 340));

  return (
    <div
      role="dialog"
      data-email-popover=""
      aria-label={`Email addresses for ${lead.companyName || lead.websiteUrl}`}
      onMouseEnter={props.onEnter}
      onMouseLeave={props.onLeave}
      style={{ position: "fixed", top: anchor.bottom + 6, left, width: 330, zIndex: 50 }}
      className="rounded-lg border border-slate-200 bg-white p-3 shadow-lg"
    >
      <p className="mb-2 text-xs font-medium text-slate-500">Click an address to select it — selected addresses appear in the panel on the left.</p>
      {emails.length === 0 ? (
        <p className="text-sm text-slate-400">This lead has no email addresses yet.</p>
      ) : (
        <ul className="space-y-1">
          {emails.map((email) => {
            const on = props.isSelected(email);
            const checks = store[normalizeEmail(email)];
            return (
              <li key={email}>
                <button
                  type="button"
                  aria-pressed={on}
                  onClick={() => props.onToggle(email)}
                  className={`flex w-full items-start gap-2 rounded-md border px-2 py-1.5 text-left text-sm ${
                    on ? "border-blue-300 bg-blue-50" : "border-transparent hover:bg-slate-50"
                  }`}
                >
                  <span
                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] ${
                      on ? "border-blue-600 bg-blue-600 text-white" : "border-slate-300 bg-white text-transparent"
                    }`}
                  >
                    ✓
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-slate-800" title={email}>
                      {email}
                    </span>
                    <span className="mt-1 block">
                      <ResultChips checks={checks} />
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Left-hand panel listing every selected address
// ---------------------------------------------------------------------------

export function SelectedEmailsPanel(props: {
  leads: VLead[];
  selected: Selected[];
  busy: boolean;
  onRemove: (key: string) => void;
  onClear: () => void;
  onClay: (lead: VLead, email: string, verdict: Verdict | "") => void;
  onReset: (lead: VLead, email: string) => void;
}) {
  // Group by lead, keeping the Sheet's row order.
  const groups = props.leads
    .map((lead) => ({
      lead,
      emails: leadEmails(lead).filter((e) => props.selected.some((s) => s.rowNumber === lead.rowNumber && normalizeEmail(s.email) === normalizeEmail(e))),
    }))
    .filter((g) => g.emails.length > 0);
  const total = groups.reduce((n, g) => n + g.emails.length, 0);

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900">Selected emails ({total})</h2>
        {total > 0 && (
          <button onClick={props.onClear} className="text-xs font-medium text-slate-500 hover:text-slate-800">
            Clear all
          </button>
        )}
      </div>

      {total === 0 ? (
        <p className="text-xs leading-relaxed text-slate-500">
          Hover the badge in the <strong>Email Verified</strong> column and click the addresses you want to check. They
          show up here, and the ZeroBounce / Hunter / Clay buttons in that row will check them.
        </p>
      ) : (
        <div className="space-y-4">
          {groups.map(({ lead, emails }) => {
            const store = parseStore(lead.emailVerified);
            return (
              <div key={lead.rowNumber}>
                <p className="mb-1 truncate text-xs font-semibold text-slate-700" title={lead.websiteUrl}>
                  {lead.companyName || lead.websiteUrl}
                </p>
                <ul className="space-y-2">
                  {emails.map((email) => {
                    const checks = store[normalizeEmail(email)];
                    const key = selKey(lead.rowNumber, email);
                    const hasAny = !!checks && Object.keys(checks).length > 0;
                    return (
                      <li key={key} className="rounded-md border border-slate-200 p-2">
                        <div className="flex items-start justify-between gap-2">
                          <span className="min-w-0 break-all text-xs text-slate-800">{email}</span>
                          <button
                            onClick={() => props.onRemove(key)}
                            aria-label={`Remove ${email} from the selection`}
                            className="shrink-0 text-slate-400 hover:text-slate-700"
                          >
                            ×
                          </button>
                        </div>
                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                          <ResultChips checks={checks} />
                        </div>
                        <label className="mt-2 flex items-center gap-1.5 text-[11px] text-slate-500">
                          Clay result
                          <select
                            disabled={props.busy}
                            value={checks?.clay?.v ?? ""}
                            onChange={(e) => props.onClay(lead, email, e.target.value as Verdict | "")}
                            className="rounded border border-slate-300 bg-white px-1 py-0.5 text-[11px] text-slate-700 disabled:opacity-50"
                          >
                            <option value="">not entered</option>
                            {VERDICTS.map((v) => (
                              <option key={v} value={v}>
                                {v}
                              </option>
                            ))}
                          </select>
                        </label>
                        {hasAny && (
                          <button
                            disabled={props.busy}
                            onClick={() => props.onReset(lead, email)}
                            className="mt-1.5 text-[11px] text-slate-400 underline hover:text-slate-700 disabled:opacity-50"
                            title="Forget all results for this address so it can be checked again"
                          >
                            reset results
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
      )}

      <p className="mt-4 border-t border-slate-100 pt-3 text-[11px] leading-relaxed text-slate-400">
        Each ZeroBounce or Hunter check uses one credit per address; an address a service has already checked is never
        checked again by that service. Clay runs on Clay&rsquo;s own site — enter its result above.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The three service buttons in each lead's row
// ---------------------------------------------------------------------------

export function VerifyButtons(props: {
  lead: VLead;
  selectedCount: number;
  providers: ProviderStatus[];
  busyKey: string | null; // `${row}-${provider}` while a check runs
  disabled: boolean; // pipeline loop running
  onVerify: (lead: VLead, provider: ProviderId) => void;
}) {
  const { lead, selectedCount, providers } = props;
  const anyBusy = props.busyKey !== null;

  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {PROVIDER_IDS.map((id) => {
        const info = providers.find((p) => p.id === id);
        const configured = !!info?.configured;
        const busy = props.busyKey === `${lead.rowNumber}-${id}`;
        const noSelection = selectedCount === 0;
        const disabled = props.disabled || anyBusy || !configured || noSelection;
        const title = !configured
          ? `Not set up: add ${info?.envKey ?? "the API key"} in Vercel and redeploy`
          : noSelection
            ? "Select an address first: hover the badge above and click the addresses to check"
            : id === "clay" && info?.kind === "manual"
              ? `Copy the ${selectedCount} selected address${selectedCount === 1 ? "" : "es"} and open Clay`
              : `Check the ${selectedCount} selected address${selectedCount === 1 ? "" : "es"} with ${PROVIDER_NAME[id]} (1 credit each)`;
        return (
          <button
            key={id}
            type="button"
            disabled={disabled}
            title={title}
            onClick={() => props.onVerify(lead, id)}
            className="whitespace-nowrap rounded-md border border-slate-300 bg-white px-2 py-0.5 text-[11px] font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? "Checking..." : PROVIDER_NAME[id]}
          </button>
        );
      })}
    </div>
  );
}
