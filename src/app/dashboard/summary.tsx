"use client";

// Two read-only summary cards for the dashboard, computed from the same data
// already on the page (each lead's D/E/F addresses and its email_verified
// cell) — no new fetch, no new stored state, nothing that can drift out of
// sync with the table or the per-lead popups.

import { leadEmails, normalizeEmail, overallVerdict, parseStore, type Verdict } from "@/lib/verification-store";

type SummaryLead = {
  officialEmail: string;
  secondaryEmail: string;
  anotherEmail: string;
  emailVerified: string;
};

export type EmailStatusSummary = {
  totalLeads: number;
  leadsWithEmail: number;
  totalAddresses: number;
  deliverable: number;
  risky: number;
  undeliverable: number;
  unchecked: number; // includes both "never checked" and a checked-but-"unknown" result
};

// Pure and exported so it can be unit-tested the same way as the rest of the
// verification logic.
export function summarizeEmailStatus(leads: SummaryLead[]): EmailStatusSummary {
  let leadsWithEmail = 0;
  let totalAddresses = 0;
  const counts: Record<Verdict, number> = { deliverable: 0, undeliverable: 0, risky: 0, unknown: 0 };
  let uncheckedNever = 0;

  for (const lead of leads) {
    const emails = leadEmails(lead);
    if (emails.length > 0) leadsWithEmail += 1;
    const store = parseStore(lead.emailVerified);
    for (const email of emails) {
      totalAddresses += 1;
      const verdict = overallVerdict(store[normalizeEmail(email)]);
      if (verdict === null) uncheckedNever += 1;
      else counts[verdict] += 1;
    }
  }

  return {
    totalLeads: leads.length,
    leadsWithEmail,
    totalAddresses,
    deliverable: counts.deliverable,
    risky: counts.risky,
    undeliverable: counts.undeliverable,
    unchecked: uncheckedNever + counts.unknown,
  };
}

export type ReachTier = "none" | "attention" | "fair" | "good" | "excellent";

export type ReachSignal = { tier: ReachTier; label: string; bars: number; checked: number; deliverable: number };

// The "signal" is deliverable ÷ checked — how much of what's actually been
// verified is good to send to. Addresses never checked don't count against
// it (they're neither good nor bad yet), which keeps the signal meaningful
// even for a Sheet where verification has only just started.
export function summarizeReach(s: EmailStatusSummary): ReachSignal {
  const checked = s.deliverable + s.risky + s.undeliverable;
  if (checked === 0) return { tier: "none", label: "Not enough data yet", bars: 0, checked, deliverable: s.deliverable };
  const ratio = s.deliverable / checked;
  if (ratio >= 0.75) return { tier: "excellent", label: "Excellent reach", bars: 4, checked, deliverable: s.deliverable };
  if (ratio >= 0.5) return { tier: "good", label: "Good reach", bars: 3, checked, deliverable: s.deliverable };
  if (ratio >= 0.25) return { tier: "fair", label: "Fair reach", bars: 2, checked, deliverable: s.deliverable };
  return { tier: "attention", label: "Needs attention", bars: 1, checked, deliverable: s.deliverable };
}

const TIER_COLOR: Record<ReachTier, string> = {
  none: "#94a3b8",
  attention: "#ef4444",
  fair: "#f59e0b",
  good: "#22c55e",
  excellent: "#16a34a",
};

function SignalBars({ tier, bars }: { tier: ReachTier; bars: number }) {
  const heights = [6, 10, 14, 18];
  const color = TIER_COLOR[tier];
  return (
    <svg width="28" height="20" viewBox="0 0 28 20" aria-hidden className="shrink-0">
      {heights.map((h, i) => (
        <rect
          key={i}
          x={i * 7}
          y={20 - h}
          width={5}
          height={h}
          rx={1}
          fill={i < bars ? color : "currentColor"}
          className={i < bars ? "" : "text-slate-200"}
        />
      ))}
    </svg>
  );
}

function MailIcon({ tone }: { tone: "neutral" | "green" | "amber" | "red" }) {
  const stroke = { neutral: "#64748b", green: "#16a34a", amber: "#d97706", red: "#dc2626" }[tone];
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden className="shrink-0">
      <rect x="3" y="5" width="18" height="14" rx="2" stroke={stroke} strokeWidth="2" />
      <path d="m4 7 8 6 8-6" stroke={stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function StatRow(props: { icon: React.ReactNode; label: string; value: string; title: string }) {
  return (
    <div className="flex items-center gap-2" title={props.title}>
      {props.icon}
      <span className="text-xs text-slate-500">{props.label}</span>
      <span className="ml-auto text-sm font-semibold text-slate-900">{props.value}</span>
    </div>
  );
}

// "Has email" / "Valid" / "Risky" / "Not found" — the same four-figure shape
// as most mailbox-verification dashboards, built from our own deliverable /
// risky / undeliverable verdicts (see verification-store.ts) rather than a
// separate scoring system.
export function EmailStatusCard({ leads }: { leads: SummaryLead[] }) {
  const s = summarizeEmailStatus(leads);
  const coveragePct = s.totalLeads > 0 ? Math.round((s.leadsWithEmail / s.totalLeads) * 100) : 0;

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <h2 className="mb-3 text-sm font-semibold text-slate-900">Email status</h2>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2.5">
        <StatRow
          icon={<MailIcon tone="neutral" />}
          label="Has email"
          value={`${coveragePct}%`}
          title={`${s.leadsWithEmail} of ${s.totalLeads} lead(s) have at least one email address found`}
        />
        <StatRow
          icon={<MailIcon tone="amber" />}
          label="Risky"
          value={String(s.risky)}
          title="Addresses whose result was Risky (accept-all, catch-all, disposable, etc.)"
        />
        <StatRow
          icon={<MailIcon tone="green" />}
          label="Valid"
          value={String(s.deliverable)}
          title="Addresses whose result was Deliverable"
        />
        <StatRow
          icon={<MailIcon tone="red" />}
          label="Not found"
          value={String(s.undeliverable)}
          title="Addresses whose result was Undeliverable"
        />
      </div>
      {s.unchecked > 0 && (
        <p className="mt-3 text-[11px] text-slate-400">
          {s.unchecked} address{s.unchecked === 1 ? "" : "es"} not yet checked (or the result was Unknown) — nothing
          is checked automatically, see the Email Verified column.
        </p>
      )}
    </div>
  );
}

// A single "how good is this Sheet to send to right now" reading: what share
// of the addresses actually checked so far came back deliverable.
export function ReachSignalCard({
  leads,
  onOpenEnrich,
  enrichDisabled,
}: {
  leads: SummaryLead[];
  onOpenEnrich?: () => void;
  enrichDisabled?: boolean;
}) {
  const s = summarizeEmailStatus(leads);
  const r = summarizeReach(s);

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-start justify-between gap-2">
        <h2 className="text-sm font-semibold text-slate-900">Reach</h2>
        {onOpenEnrich && (
          <button
            type="button"
            onClick={onOpenEnrich}
            disabled={enrichDisabled}
            title={enrichDisabled ? "Wait for the current pipeline run to finish first" : "Open the bulk enrichment tool"}
            className="text-xs font-medium text-slate-600 underline hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-50 disabled:no-underline"
          >
            Open &amp; enrich →
          </button>
        )}
      </div>
      {s.totalAddresses > 0 && (
        <p className="mt-2 text-xs text-slate-500">
          <span className="font-semibold text-slate-700">{s.totalAddresses}</span> address{s.totalAddresses === 1 ? "" : "es"} total —{" "}
          <span className="font-semibold text-slate-700">{r.checked}</span> verified,{" "}
          <span className="font-semibold text-slate-700">{s.unchecked}</span> need{s.unchecked === 1 ? "s" : ""} verification.
        </p>
      )}
      <div className="mt-3 flex items-center gap-3">
        <SignalBars tier={r.tier} bars={r.bars} />
        <span className="text-sm font-semibold text-slate-900">{r.label}</span>
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
        {r.checked === 0
          ? "Check some addresses (ZeroBounce, Hunter or Clay) to see how deliverable this Sheet is."
          : `${r.deliverable} of ${r.checked} checked address${r.checked === 1 ? "" : "es"} came back deliverable.`}
      </p>
    </div>
  );
}
