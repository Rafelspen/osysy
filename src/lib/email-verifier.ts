// Pluggable mailbox verification ("does this exact address exist?").
//
// The free MX/domain check only proves a domain can receive mail. A verification
// service answers per address. This file is the socket: it normalizes every
// service's answer to one of four verdicts and does the timeout/parallel work,
// so adding a service later means writing one small adapter and registering it
// (see README, "Adding an email verifier").
//
// With no provider configured, everything here is inert: verifyEmails() returns
// null and the pipeline behaves exactly as before.

export type Verdict = "deliverable" | "undeliverable" | "risky" | "unknown";

export interface EmailVerifierProvider {
  // Ask the service about one address and map its answer to a Verdict.
  // Throw on network/API errors — the caller treats a throw as "unknown".
  verify(email: string, apiKey: string, signal: AbortSignal): Promise<Verdict>;
}

// Register providers here, keyed by the value of EMAIL_VERIFIER_PROVIDER.
// Empty until a service is chosen.
const PROVIDERS: Record<string, EmailVerifierProvider> = {};

const REQUEST_TIMEOUT_MS = 8000;

export type VerifierConfig = { configured: boolean; provider: string | null; reason?: string };

export function getVerifierConfig(): VerifierConfig {
  const name = process.env.EMAIL_VERIFIER_PROVIDER?.trim().toLowerCase();
  const key = process.env.EMAIL_VERIFIER_API_KEY?.trim();
  if (!name) return { configured: false, provider: null };
  if (!PROVIDERS[name]) return { configured: false, provider: name, reason: "unknown provider (no adapter registered)" };
  if (!key) return { configured: false, provider: name, reason: "EMAIL_VERIFIER_API_KEY is missing" };
  return { configured: true, provider: name };
}

export type VerificationResult = {
  verdicts: Record<string, Verdict>; // keyed by lower-cased address
  deliverable: number;
  total: number;
};

// Verifies each unique address (in parallel). Returns null when no provider is
// configured. A failed or timed-out lookup is "unknown" and never blocks anything.
export async function verifyEmails(emails: string[]): Promise<VerificationResult | null> {
  const config = getVerifierConfig();
  if (!config.configured || !config.provider) return null;
  const provider = PROVIDERS[config.provider];
  const apiKey = process.env.EMAIL_VERIFIER_API_KEY!.trim();

  const unique = Array.from(new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean)));
  const entries = await Promise.all(
    unique.map(async (email) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        return [email, await provider.verify(email, apiKey, controller.signal)] as const;
      } catch {
        return [email, "unknown" as Verdict] as const;
      } finally {
        clearTimeout(timer);
      }
    })
  );

  const verdicts = Object.fromEntries(entries) as Record<string, Verdict>;
  return {
    verdicts,
    deliverable: entries.filter(([, v]) => v === "deliverable").length,
    total: entries.length,
  };
}

// Stored in the sheet's email_verified cell, e.g.
//   "2/3 deliverable · bad@x.com: undeliverable"
// Only addresses that are NOT deliverable are listed after the dot.
export function formatVerification(result: VerificationResult): string {
  const problems = Object.entries(result.verdicts)
    .filter(([, v]) => v !== "deliverable")
    .map(([email, v]) => `${email}: ${v}`);
  const base = `${result.deliverable}/${result.total} deliverable`;
  return problems.length ? `${base} · ${problems.join(", ")}` : base;
}

// Addresses the verifier reported undeliverable, read back from the cell text.
export function undeliverableAddresses(cell: string): Set<string> {
  const out = new Set<string>();
  for (const m of cell.matchAll(/([^\s,·:]+@[^\s,·:]+):\s*undeliverable/gi)) out.add(m[1].toLowerCase());
  return out;
}
