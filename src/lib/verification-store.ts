// Per-address email verification results, kept in the Sheet's `email_verified`
// cell (column P) as JSON. Pure functions only — no server or network code — so
// the dashboard (browser) and the API routes (server) share exactly the same
// logic and can never disagree about what a result means.

export type Verdict = "deliverable" | "undeliverable" | "risky" | "unknown";
export const VERDICTS: readonly Verdict[] = ["deliverable", "undeliverable", "risky", "unknown"];

export const PROVIDER_IDS = ["zerobounce", "hunter", "clay"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export type Check = {
  v: Verdict;
  raw: string; // the service's own wording, e.g. "valid" or "catch-all (accept_all)"
  t: string; // ISO time of the check
  manual?: boolean; // typed in by hand (Clay)
};
export type EmailChecks = Partial<Record<ProviderId, Check>>;
// Keyed by the lower-cased address.
export type Store = Record<string, EmailChecks>;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// The lead's addresses (columns D, E, F): trimmed, blanks removed, duplicates
// removed ignoring case, in column order.
export function leadEmails(lead: { officialEmail: string; secondaryEmail: string; anotherEmail: string }): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [lead.officialEmail, lead.secondaryEmail, lead.anotherEmail]) {
    const email = (raw ?? "").trim();
    const key = normalizeEmail(email);
    if (email && !seen.has(key)) {
      seen.add(key);
      out.push(email);
    }
  }
  return out;
}

// Reads the cell. Never throws: anything unreadable is treated as "no results",
// and individual malformed entries are dropped instead of failing the whole cell.
export function parseStore(cell: string | null | undefined): Store {
  const store: Store = {};
  const text = (cell ?? "").trim();
  if (!text) return store;
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return store;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return store;

  for (const [email, checks] of Object.entries(data as Record<string, unknown>)) {
    if (!checks || typeof checks !== "object" || Array.isArray(checks)) continue;
    const clean: EmailChecks = {};
    for (const id of PROVIDER_IDS) {
      const c = (checks as Record<string, unknown>)[id] as Record<string, unknown> | undefined;
      if (!c || typeof c !== "object") continue;
      if (typeof c.v !== "string" || !(VERDICTS as readonly string[]).includes(c.v)) continue;
      clean[id] = {
        v: c.v as Verdict,
        raw: typeof c.raw === "string" ? c.raw : "",
        t: typeof c.t === "string" ? c.t : "",
        ...(c.manual === true ? { manual: true } : {}),
      };
    }
    if (Object.keys(clean).length > 0) store[normalizeEmail(email)] = clean;
  }
  return store;
}

export function serializeStore(store: Store): string {
  const entries = Object.entries(store).filter(([, checks]) => Object.keys(checks).length > 0);
  return entries.length ? JSON.stringify(Object.fromEntries(entries)) : "";
}

export function setCheck(store: Store, email: string, provider: ProviderId, check: Check): Store {
  const key = normalizeEmail(email);
  return { ...store, [key]: { ...(store[key] ?? {}), [provider]: check } };
}

export function clearCheck(store: Store, email: string, provider: ProviderId): Store {
  const key = normalizeEmail(email);
  const current = { ...(store[key] ?? {}) };
  delete current[provider];
  const next = { ...store };
  if (Object.keys(current).length) next[key] = current;
  else delete next[key];
  return next;
}

export function clearEmail(store: Store, email: string): Store {
  const next = { ...store };
  delete next[normalizeEmail(email)];
  return next;
}

// One verdict per address from all the services that checked it. The safest
// answer wins: undeliverable > risky > unknown > deliverable. null = never checked.
export function overallVerdict(checks: EmailChecks | undefined): Verdict | null {
  const verdicts = Object.values(checks ?? {}).map((c) => c!.v);
  if (verdicts.length === 0) return null;
  for (const v of ["undeliverable", "risky", "unknown"] as const) {
    if (verdicts.includes(v)) return v;
  }
  return "deliverable";
}

export type Tone = "none" | "green" | "amber" | "red";
export type LeadSummary = { total: number; checked: number; deliverable: number; tone: Tone; label: string };

export function summarizeLead(store: Store, emails: string[]): LeadSummary {
  const total = emails.length;
  let checked = 0;
  let deliverable = 0;
  let undeliverable = 0;
  for (const email of emails) {
    const v = overallVerdict(store[normalizeEmail(email)]);
    if (v === null) continue;
    checked += 1;
    if (v === "deliverable") deliverable += 1;
    if (v === "undeliverable") undeliverable += 1;
  }
  if (checked === 0) return { total, checked, deliverable, tone: "none", label: "Not checked" };
  const tone: Tone = undeliverable > 0 ? "red" : deliverable === total ? "green" : "amber";
  return { total, checked, deliverable, tone, label: `${deliverable}/${total} verified` };
}

// Addresses that any service reported undeliverable — never CC'd.
export function undeliverableSet(cell: string | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const [email, checks] of Object.entries(parseStore(cell))) {
    if (overallVerdict(checks) === "undeliverable") out.add(email);
  }
  return out;
}
