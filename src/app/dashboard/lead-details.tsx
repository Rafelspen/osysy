"use client";

// Lead details popup, opened from the company name in the dashboard table. It
// shows the whole picture of one lead and offers the same controls as the rest
// of the dashboard. It owns no data of its own: everything is read from the lead
// row (kept fresh by the dashboard) and every action calls the dashboard's own
// handlers, so the table, the left panel and this popup always agree.

import { useEffect, useRef } from "react";
import type { ProviderStatus } from "@/lib/email-verifier";
import { addressRoles, emailMatchesWebsite, isFreeMailAddress, type AddressRole } from "@/lib/lead-recipients";
import { leadEmails, normalizeEmail, parseStore, summarizeLead, type ProviderId, type Tone, type Verdict } from "@/lib/verification-store";
import { ManualResult, ResultChips, VerifyButtons, type VLead } from "./verification";

export type DetailLead = VLead & {
  stage: string;
  lastError: string;
  mxStatus: string;
  source?: string;
  greetingName?: string;
  gmailDraftId?: string;
  threadId?: string;
  followup1DraftId: string;
  followup2DraftId: string;
  followup3DraftId: string;
};

export const FOLLOW_UPS = [
  { step: 1, label: "Follow-up 1", key: "followup1DraftId" },
  { step: 2, label: "Follow-up 2", key: "followup2DraftId" },
  { step: 3, label: "Final follow-up", key: "followup3DraftId" },
] as const;

export const STAGE_ORDER = ["SOURCED", "ENRICHED", "VERIFIED", "OUTREACH", "QA", "DRAFTED"];

export const STAGE_COLORS: Record<string, string> = {
  SOURCED: "bg-slate-100 text-slate-700",
  ENRICHED: "bg-blue-100 text-blue-800",
  VERIFIED: "bg-indigo-100 text-indigo-800",
  OUTREACH: "bg-amber-100 text-amber-800",
  QA: "bg-purple-100 text-purple-800",
  DRAFTED: "bg-green-100 text-green-800",
};

// Badge colours for the Email Verified column (see summarizeLead in verification-store.ts).
export const TONE_CLASS: Record<Tone, string> = {
  none: "bg-slate-100 text-slate-500",
  green: "bg-green-100 text-green-800",
  amber: "bg-amber-100 text-amber-800",
  red: "bg-red-100 text-red-800",
};

// mxStatus is stored as "X/Y valid" — X of the Y found addresses (Official/
// Secondary/Another) have a domain confirmed able to receive mail.
export function mxBadge(mxStatus: string): { label: string; className: string } | null {
  const match = mxStatus.match(/^(\d+)\/(\d+) valid$/);
  if (!match) return null;
  const valid = Number(match[1]);
  const total = Number(match[2]);
  if (total === 0) return null;
  if (valid === total) return { label: mxStatus, className: "bg-green-100 text-green-800" };
  if (valid === 0) return { label: mxStatus, className: "bg-red-100 text-red-800" };
  return { label: mxStatus, className: "bg-amber-100 text-amber-800" };
}

// last_error holds real errors and also standing warnings ("domain mismatch warning:",
// "deliverability warning:"). A warning can be carried after an error ("error; domain
// mismatch warning: ..."), so split it off to show it in its own amber callout.
export function splitLastError(text: string): { error: string; warning: string } {
  const t = text.trim();
  if (!t) return { error: "", warning: "" };
  if (/^deliverability warning:/i.test(t)) return { error: "", warning: t };
  const at = t.search(/domain mismatch warning:/i);
  if (at === 0) return { error: "", warning: t };
  if (at > 0) return { error: t.slice(0, at).replace(/[;\s]+$/, ""), warning: t.slice(at) };
  return { error: t, warning: "" };
}

// A safe link target, or null. Only http(s) is ever linked.
function webHref(raw: string | undefined): string | null {
  const t = (raw ?? "").trim();
  if (!t) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(t) ? t : `https://${t}`);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

const ROLE_LABEL: Record<AddressRole, string> = { to: "TO", cc: "CC", "left-out": "Left out" };
const ROLE_STYLE: Record<AddressRole, string> = {
  to: "bg-blue-100 text-blue-800",
  cc: "bg-slate-100 text-slate-700",
  "left-out": "bg-red-100 text-red-800",
};
const COLUMN_LABEL = ["Column D", "Column E", "Column F"];

function Section(props: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-slate-100 pt-4">
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-500">{props.title}</h3>
      {props.children}
    </section>
  );
}

export function LeadDetailsDialog(props: {
  lead: DetailLead;
  providers: ProviderStatus[];
  isSelected: (email: string) => boolean;
  onToggle: (email: string) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  verifyBusy: string | null;
  followUpBusy: string | null;
  looping: boolean;
  message: { ok: boolean; text: string } | null;
  onVerify: (provider: ProviderId) => void;
  onSet: (email: string, provider: ProviderId, verdict: Verdict | "") => void;
  onReset: (email: string) => void;
  onFollowUp: (step: number, label: string) => void;
  onClose: () => void;
}) {
  const { lead, onClose } = props;
  const closeRef = useRef<HTMLButtonElement>(null);

  // Escape closes; the page behind doesn't scroll while the popup is open; focus
  // moves in and goes back to where it was.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      opener?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const emails = leadEmails(lead);
  const store = parseStore(lead.emailVerified);
  const summary = summarizeLead(store, emails);
  const roles = addressRoles(lead);
  const selectedCount = emails.filter((e) => props.isSelected(e)).length;
  const busy = props.verifyBusy !== null || props.looping;
  const mx = mxBadge(lead.mxStatus);
  const { error, warning } = splitLastError(lead.lastError);
  const stage = lead.stage.trim().toUpperCase();
  const stageIndex = STAGE_ORDER.indexOf(stage);
  const title = lead.companyName.trim() || lead.websiteUrl.trim() || `Row ${lead.rowNumber}`;
  const siteHref = webHref(lead.websiteUrl);
  const sourceHref = webHref(lead.source);
  const drafted = stage === "DRAFTED";
  const claySelection = props.providers.find((p) => p.id === "clay");

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 sm:p-8"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="lead-details-title"
        className="relative w-full max-w-3xl space-y-4 rounded-lg border border-slate-200 bg-white p-6 shadow-lg"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 id="lead-details-title" className="break-words text-lg font-semibold text-slate-900">
              {title}
            </h2>
            <p className="mt-0.5 break-all text-sm text-slate-600">
              {siteHref ? (
                <a href={siteHref} target="_blank" rel="noopener noreferrer" className="underline">
                  {lead.websiteUrl}
                </a>
              ) : (
                lead.websiteUrl || "No website"
              )}
              <span className="text-slate-400"> · Sheet row {lead.rowNumber}</span>
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STAGE_COLORS[stage] ?? "bg-slate-100 text-slate-600"}`}>
              {lead.stage || "—"}
            </span>
            <button
              ref={closeRef}
              type="button"
              onClick={onClose}
              aria-label="Close lead details"
              className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-sm text-slate-700 hover:bg-slate-50"
            >
              ×
            </button>
          </div>
        </div>

        {props.message && (
          <div
            role="status"
            className={`rounded-md border px-3 py-2 text-sm ${
              props.message.ok ? "border-green-200 bg-green-50 text-green-800" : "border-amber-200 bg-amber-50 text-amber-900"
            }`}
          >
            {props.message.text}
          </div>
        )}

        <Section title="Pipeline progress">
          <ol className="flex flex-wrap gap-1.5">
            {STAGE_ORDER.map((s, i) => {
              const cls =
                stageIndex === -1 || i > stageIndex
                  ? "bg-slate-100 text-slate-400"
                  : i === stageIndex
                    ? STAGE_COLORS[s]
                    : "bg-green-100 text-green-800";
              return (
                <li
                  key={s}
                  aria-current={i === stageIndex ? "step" : undefined}
                  className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${cls}`}
                >
                  {i < stageIndex ? `${s} ✓` : s}
                </li>
              );
            })}
          </ol>
          {stageIndex === -1 && lead.stage.trim() && (
            <p className="mt-1.5 text-xs text-slate-500">Stage in the Sheet: &ldquo;{lead.stage}&rdquo; (not a standard stage).</p>
          )}
        </Section>

        <Section title="Status">
          <div className="space-y-2 text-sm">
            {!error && !warning && <p className="text-green-800">No errors or warnings.</p>}
            {error && <p className="break-words text-red-700">{error}</p>}
            {warning && (
              <div className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-800">{warning}</div>
            )}
            <p className="flex flex-wrap items-center gap-2 text-slate-700">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">MX/Domain</span>
              {mx ? (
                <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${mx.className}`}>{mx.label}</span>
              ) : (
                <span className="text-slate-400">not checked yet</span>
              )}
              <span className="text-xs text-slate-500">
                {mx ? "addresses whose domain can receive mail" : "the pipeline checks this at the Enriched step"}
              </span>
            </p>
          </div>
        </Section>

        <Section title="Email addresses">
          {emails.length === 0 ? (
            <p className="text-sm text-slate-500">No addresses found for this lead yet.</p>
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`inline-block whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ${TONE_CLASS[summary.tone]}`}>
                  {summary.label}
                </span>
                <button
                  type="button"
                  onClick={props.onSelectAll}
                  className="text-xs font-medium text-slate-600 underline hover:text-slate-900"
                >
                  Select all
                </button>
                <button
                  type="button"
                  disabled={selectedCount === 0}
                  onClick={props.onClearSelection}
                  className="text-xs font-medium text-slate-600 underline hover:text-slate-900 disabled:opacity-40"
                >
                  Clear selection
                </button>
                <span className="text-xs text-slate-500">{selectedCount} selected</span>
              </div>

              <ul className="space-y-2">
                {emails.map((email, i) => {
                  const checks = store[normalizeEmail(email)];
                  const role = roles.find((r) => normalizeEmail(r.email) === normalizeEmail(email))?.role ?? "cc";
                  const freeMail = isFreeMailAddress(email);
                  const match = freeMail ? null : emailMatchesWebsite(email, lead.websiteUrl);
                  const hasAny = !!checks && Object.keys(checks).length > 0;
                  return (
                    <li key={email} className="rounded-md border border-slate-200 p-2.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <label className="flex min-w-0 items-center gap-2 text-sm text-slate-800">
                          <input
                            type="checkbox"
                            checked={props.isSelected(email)}
                            onChange={() => props.onToggle(email)}
                            aria-label={`Select ${email} for verification`}
                          />
                          <span className="min-w-0 break-all">{email}</span>
                        </label>
                        <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${ROLE_STYLE[role]}`}>{ROLE_LABEL[role]}</span>
                        <span className="text-[11px] text-slate-400">{COLUMN_LABEL[i] ?? ""}</span>
                        {freeMail && <span className="text-[11px] text-slate-500">Gmail address</span>}
                        {match !== null && (
                          <span className={`text-[11px] ${match ? "text-green-800" : "text-amber-800"}`}>
                            {match ? "matches website" : "different domain"}
                          </span>
                        )}
                      </div>
                      <div className="mt-1.5">
                        <ResultChips checks={checks} />
                      </div>
                      <ManualResult
                        lead={lead}
                        email={email}
                        checks={checks}
                        busy={busy}
                        onSet={(_l, e, provider, verdict) => props.onSet(e, provider, verdict)}
                      />
                      {hasAny && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => props.onReset(email)}
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

              <div>
                <VerifyButtons
                  lead={lead}
                  selectedCount={selectedCount}
                  providers={props.providers}
                  busyKey={props.verifyBusy}
                  disabled={props.looping}
                  onVerify={(_l, provider) => props.onVerify(provider)}
                />
                <p className="mt-1.5 text-[11px] leading-relaxed text-slate-400">
                  Checks run on the selected addresses only. ZeroBounce and Hunter use about one credit per address, and an
                  address a service already checked is not checked again by it.
                  {claySelection?.kind === "manual" ? " Clay opens Clay's site; record its answer with “Set result from”." : ""}
                </p>
              </div>

              <p className="text-[11px] leading-relaxed text-slate-400">
                TO / CC / Left out shows how a draft made now would be addressed (an undeliverable address is left out, and an
                undeliverable TO is replaced by a usable one from column E or F). Drafts that already exist are not changed.
              </p>
            </div>
          )}
        </Section>

        <Section title="Drafts and follow-ups">
          <div className="space-y-2 text-sm text-slate-700">
            <p>
              First email:{" "}
              {lead.gmailDraftId?.trim() ? (
                <span className="text-green-800">drafted in Gmail{lead.threadId?.trim() ? " (thread linked)" : ""}</span>
              ) : (
                <span className="text-slate-500">not drafted yet</span>
              )}
            </p>
            {drafted ? (
              <div className="flex flex-wrap gap-1.5">
                {FOLLOW_UPS.map(({ step, label, key }) => {
                  const done = !!lead[key]?.trim();
                  const previousDone = step === 1 || !!lead[FOLLOW_UPS[step - 2].key]?.trim();
                  const isBusy = props.followUpBusy === `${lead.rowNumber}-${step}`;
                  return (
                    <button
                      key={step}
                      type="button"
                      onClick={() => props.onFollowUp(step, label)}
                      disabled={props.followUpBusy !== null || props.looping || (!done && !previousDone)}
                      title={
                        done ? `${label} was drafted — click to re-check its status` : !previousDone ? "Draft the previous follow-up first" : `Draft ${label} in the same Gmail thread`
                      }
                      className={`whitespace-nowrap rounded-md border px-2 py-1 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-40 ${
                        done ? "border-green-300 bg-green-50 text-green-800" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                      }`}
                    >
                      {isBusy ? "Drafting..." : done ? `${label} ✓` : label}
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="text-xs text-slate-500">Follow-ups become available once the first email is drafted (stage DRAFTED).</p>
            )}
          </div>
        </Section>

        <Section title="Lead info">
          <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs text-slate-500">Company</dt>
              <dd className="break-words text-slate-800">{lead.companyName.trim() || "—"}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500">Greeting name</dt>
              <dd className="break-words text-slate-800">{lead.greetingName?.trim() || "—"}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-xs text-slate-500">Source</dt>
              <dd className="break-all text-slate-800">
                {sourceHref ? (
                  <a href={sourceHref} target="_blank" rel="noopener noreferrer" className="underline">
                    {lead.source}
                  </a>
                ) : (
                  lead.source?.trim() || "—"
                )}
              </dd>
            </div>
          </dl>
        </Section>
      </div>
    </div>
  );
}
