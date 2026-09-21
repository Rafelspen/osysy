// Mailbox verification services. ZeroBounce and Hunter are called through their
// APIs; Clay has no API on its free plan (webhooks and HTTP API start at its
// Growth plan), so it is "manual": the person runs the check in Clay's own site
// and records the result in the dashboard.
//
// Adding another API service = one entry in `API_PROVIDERS` plus a mapping
// function below. API keys come from environment variables and never leave the
// server; they are never included in an error message.

import type { ProviderId, Verdict } from "./verification-store";

export type ApiProviderId = "zerobounce" | "hunter";
export type ProviderKind = "api" | "manual";
export type ProviderStatus = { id: ProviderId; label: string; kind: ProviderKind; configured: boolean; envKey?: string };

export type ProviderResult = { verdict: Verdict; raw: string };

export type VerifierErrorCode = "auth" | "credits" | "rate" | "pending" | "network" | "bad_response" | "bad_request";

export class VerifierError extends Error {
  constructor(public code: VerifierErrorCode, message: string) {
    super(message);
    this.name = "VerifierError";
  }
}

type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;

const REQUEST_TIMEOUT_MS = 25_000;

const META: Record<ProviderId, { label: string; kind: ProviderKind; envKey?: string }> = {
  zerobounce: { label: "ZeroBounce", kind: "api", envKey: "ZEROBOUNCE_API_KEY" },
  hunter: { label: "Hunter", kind: "api", envKey: "HUNTER_API_KEY" },
  clay: { label: "Clay", kind: "manual" },
};

export function isApiProvider(id: string): id is ApiProviderId {
  return id === "zerobounce" || id === "hunter";
}

export function isManualProvider(id: string): id is "clay" {
  return id === "clay";
}

function apiKeyFor(id: ApiProviderId): string {
  return (process.env[META[id].envKey!] ?? "").trim();
}

// For the dashboard and /api/health. Reports only whether a key exists — never the key.
export function providerStatuses(): ProviderStatus[] {
  return (Object.keys(META) as ProviderId[]).map((id) => ({
    id,
    label: META[id].label,
    kind: META[id].kind,
    configured: META[id].kind === "manual" ? true : !!apiKeyFor(id as ApiProviderId),
    ...(META[id].envKey ? { envKey: META[id].envKey } : {}),
  }));
}

export function providerLabel(id: ProviderId): string {
  return META[id].label;
}

async function requestJson(
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string> | undefined,
  label: string
): Promise<{ status: number; data: any }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { headers, signal: controller.signal });
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    return { status: res.status, data };
  } catch (err: any) {
    if (err?.name === "AbortError") throw new VerifierError("network", `${label} took too long to answer — try again.`);
    throw new VerifierError("network", `Couldn't reach ${label} — try again.`);
  } finally {
    clearTimeout(timer);
  }
}

// ---- ZeroBounce -----------------------------------------------------------

const ZEROBOUNCE_VERDICT: Record<string, Verdict> = {
  valid: "deliverable",
  invalid: "undeliverable",
  "catch-all": "risky",
  unknown: "unknown",
  abuse: "risky",
  do_not_mail: "risky",
  spamtrap: "undeliverable", // never email a suspected spam trap
};

async function verifyZeroBounce(email: string, apiKey: string, fetchImpl: FetchLike): Promise<ProviderResult> {
  const url = new URL("https://api.zerobounce.net/v2/validate");
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("email", email);
  url.searchParams.set("timeout", "15");

  const { status, data } = await requestJson(fetchImpl, url.toString(), undefined, "ZeroBounce");
  if (status === 401 || status === 403) throw new VerifierError("auth", "ZeroBounce rejected the API key.");
  if (status === 429) throw new VerifierError("rate", "ZeroBounce is rate-limiting requests — wait a moment and try again.");
  if (!data || typeof data !== "object") throw new VerifierError("bad_response", "ZeroBounce sent an answer the app couldn't read.");
  if (data.error) {
    // ZeroBounce uses one message for both cases.
    throw new VerifierError("credits", "ZeroBounce refused the request: the API key is invalid or the monthly credits are used up.");
  }
  const raw = String(data.status ?? "").trim().toLowerCase();
  const verdict = ZEROBOUNCE_VERDICT[raw];
  if (!verdict) throw new VerifierError("bad_response", `ZeroBounce returned an unfamiliar status ("${raw || "empty"}").`);
  const sub = String(data.sub_status ?? "").trim();
  return { verdict, raw: sub ? `${raw} (${sub})` : raw };
}

// ---- Hunter ---------------------------------------------------------------

const HUNTER_VERDICT: Record<string, Verdict> = {
  valid: "deliverable",
  invalid: "undeliverable",
  accept_all: "risky",
  disposable: "risky",
  webmail: "unknown", // a webmail address (Gmail etc.) can't be confirmed
  unknown: "unknown",
};

async function verifyHunter(email: string, apiKey: string, fetchImpl: FetchLike): Promise<ProviderResult> {
  const url = `https://api.hunter.io/v2/email-verifier?email=${encodeURIComponent(email)}`;
  const { status, data } = await requestJson(fetchImpl, url, { "X-API-KEY": apiKey }, "Hunter");
  if (status === 202) throw new VerifierError("pending", "Hunter is still verifying this address — try again in a minute.");
  if (status === 401) throw new VerifierError("auth", "Hunter rejected the API key.");
  if (status === 403) throw new VerifierError("rate", "Hunter is rate-limiting requests — wait a moment and try again.");
  if (status === 429) throw new VerifierError("credits", "Hunter says the monthly verification limit is used up.");
  if (status === 400) throw new VerifierError("bad_request", "Hunter didn't accept that address.");
  if (status === 222) return { verdict: "unknown", raw: "unexpected response from the mail server" };
  if (status !== 200) throw new VerifierError("bad_response", `Hunter returned an unexpected HTTP status (${status}).`);
  const raw = String(data?.data?.status ?? "").trim().toLowerCase();
  const verdict = HUNTER_VERDICT[raw];
  if (!verdict) throw new VerifierError("bad_response", `Hunter returned an unfamiliar status ("${raw || "empty"}").`);
  return { verdict, raw };
}

// ---- entry point -----------------------------------------------------------

export async function verifyWithProvider(
  id: ApiProviderId,
  email: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  apiKeyOverride?: string
): Promise<ProviderResult> {
  const apiKey = apiKeyOverride ?? apiKeyFor(id);
  if (!apiKey) throw new VerifierError("auth", `${META[id].label} isn't set up: add ${META[id].envKey} in Vercel and redeploy.`);
  return id === "zerobounce" ? verifyZeroBounce(email, apiKey, fetchImpl) : verifyHunter(email, apiKey, fetchImpl);
}
