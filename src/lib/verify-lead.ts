import type { OAuth2Client } from "google-auth-library";
import { readCell, updateLeadRow, type LeadRow } from "./sheets";
import { HttpError } from "./lead-access";
import {
  clearCheck,
  clearEmail,
  leadEmails,
  normalizeEmail,
  parseStore,
  serializeStore,
  setCheck,
  VERDICTS,
  type ProviderId,
  type Verdict,
} from "./verification-store";
import {
  providerLabel,
  verifyWithProvider,
  VerifierError,
  type ApiProviderId,
  type VerifierErrorCode,
} from "./email-verifier";

export const MAX_EMAILS_PER_REQUEST = 3;

// Where results are read from and written to. Injectable so the logic can be
// tested without Google.
export type CellIO = { read: () => Promise<string>; write: (value: string) => Promise<void> };

export function sheetCellIO(auth: OAuth2Client, sheetId: string, rowNumber: number): CellIO {
  return {
    read: () => readCell(auth, sheetId, `P${rowNumber}`),
    write: (value) => updateLeadRow(auth, sheetId, rowNumber, { emailVerified: value }),
  };
}

export type EmailOutcome = {
  email: string;
  status: "checked" | "cached" | "failed";
  verdict?: Verdict;
  raw?: string;
  error?: string;
  code?: VerifierErrorCode;
};

// Maps the addresses the caller asked about to the lead's own addresses.
// Anything that isn't one of them is refused, so the endpoint can't be used to
// look up arbitrary addresses on your account's credits.
function resolveEmails(lead: LeadRow, requested: string[]): string[] {
  const own = new Map(leadEmails(lead).map((e) => [normalizeEmail(e), e]));
  const out: string[] = [];
  for (const raw of requested) {
    const key = normalizeEmail(String(raw));
    const email = own.get(key);
    if (!email) throw new HttpError(400, `${String(raw).slice(0, 80)} isn't one of this lead's addresses.`);
    if (!out.includes(email)) out.push(email);
  }
  if (out.length === 0) throw new HttpError(400, "Select at least one address first.");
  if (out.length > MAX_EMAILS_PER_REQUEST) throw new HttpError(400, `At most ${MAX_EMAILS_PER_REQUEST} addresses per check.`);
  return out;
}

// Verifies the given addresses with one service. An address that already has a
// result from that service is NOT checked again (no credit spent) unless `force`.
export async function runVerification(args: {
  lead: LeadRow;
  provider: ApiProviderId;
  emails: string[];
  force: boolean;
  io: CellIO;
  verify?: typeof verifyWithProvider;
  now?: () => Date;
}): Promise<EmailOutcome[]> {
  const { lead, provider, force, io } = args;
  const verify = args.verify ?? verifyWithProvider;
  const now = args.now ?? (() => new Date());
  const emails = resolveEmails(lead, args.emails);

  const existing = parseStore(lead.emailVerified);
  const outcomes: EmailOutcome[] = await Promise.all(
    emails.map(async (email): Promise<EmailOutcome> => {
      const prior = existing[normalizeEmail(email)]?.[provider];
      if (prior && !force) return { email, status: "cached", verdict: prior.v, raw: prior.raw };
      try {
        const r = await verify(provider, email);
        return { email, status: "checked", verdict: r.verdict, raw: r.raw };
      } catch (err) {
        if (err instanceof VerifierError) return { email, status: "failed", error: err.message, code: err.code };
        return { email, status: "failed", error: `${providerLabel(provider)} check failed unexpectedly.`, code: "bad_response" };
      }
    })
  );

  const fresh = outcomes.filter((o) => o.status === "checked");
  if (fresh.length > 0) {
    // Re-read the cell right before writing so results saved a moment ago (another
    // click, another tab) are kept instead of overwritten.
    let store = parseStore(await io.read());
    for (const o of fresh) {
      store = setCheck(store, o.email, provider, { v: o.verdict!, raw: o.raw ?? "", t: now().toISOString() });
    }
    await io.write(serializeStore(store));
  }
  return outcomes;
}

export type RecordAction =
  | { action: "set"; email: string; provider: ProviderId; verdict: string }
  | { action: "clear"; email: string; provider: ProviderId }
  | { action: "reset"; email: string };

// Manual results (Clay) and corrections: set a result, remove one service's
// result for an address, or reset an address so it can be verified again.
export async function recordResult(args: { lead: LeadRow; input: RecordAction; io: CellIO; now?: () => Date }): Promise<void> {
  const { lead, input, io } = args;
  const now = args.now ?? (() => new Date());
  const [email] = resolveEmails(lead, [input.email]);

  let store = parseStore(await io.read());
  if (input.action === "set") {
    if (input.provider !== "clay") throw new HttpError(400, "Only Clay results can be entered by hand.");
    if (!(VERDICTS as readonly string[]).includes(input.verdict)) throw new HttpError(400, "Unknown result.");
    store = setCheck(store, email, "clay", { v: input.verdict as Verdict, raw: "entered by hand", t: now().toISOString(), manual: true });
  } else if (input.action === "clear") {
    if (input.provider !== "clay") throw new HttpError(400, "Only Clay results can be cleared individually.");
    store = clearCheck(store, email, "clay");
  } else {
    store = clearEmail(store, email);
  }
  await io.write(serializeStore(store));
}

// One readable sentence for the dashboard banner.
export function describeOutcomes(provider: ApiProviderId, outcomes: EmailOutcome[]): string {
  const label = providerLabel(provider);
  const checked = outcomes.filter((o) => o.status === "checked");
  const cached = outcomes.filter((o) => o.status === "cached");
  const failed = outcomes.filter((o) => o.status === "failed");
  const parts: string[] = [];
  if (checked.length) parts.push(`${label}: ${checked.map((o) => `${o.email} → ${o.verdict}`).join("; ")} (up to ${checked.length} credit${checked.length === 1 ? "" : "s"} used)`);
  if (cached.length) parts.push(`${cached.length} already checked with ${label} (no credit used): ${cached.map((o) => `${o.email} → ${o.verdict}`).join("; ")}`);
  if (failed.length) parts.push(Array.from(new Set(failed.map((o) => o.error))).join(" "));
  return parts.join(" · ");
}
