// Mailbox verification services.
//
//  - ZeroBounce and Hunter are called through their APIs.
//  - Clay has two modes. With CLAY_API_KEY + CLAY_FUNCTION_ID set, it runs a Clay
//    "function" you built in Clay through Clay's Public API (start a run, then
//    collect the result). Without them it is "manual": the person runs the check
//    in Clay's own site and records the result in the dashboard.
//
// Adding another API service = one function below plus an entry in META. API
// keys come from environment variables and never leave the server; they are
// never included in an error message.

import type { ProviderId, Verdict } from "./verification-store";

export type ApiProviderId = "zerobounce" | "hunter" | "clay";
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

type FetchInit = { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal };
export type FetchLike = (url: string, init?: FetchInit) => Promise<Response>;

const REQUEST_TIMEOUT_MS = 25_000;

const META: Record<ProviderId, { label: string; envKey?: string }> = {
  zerobounce: { label: "ZeroBounce", envKey: "ZEROBOUNCE_API_KEY" },
  hunter: { label: "Hunter", envKey: "HUNTER_API_KEY" },
  clay: { label: "Clay", envKey: "CLAY_API_KEY" },
};

const env = (name: string) => (process.env[name] ?? "").trim();

// Clay runs automatically only when BOTH the key and the function id are set.
export function clayApiConfigured(): boolean {
  return !!env("CLAY_API_KEY") && !!env("CLAY_FUNCTION_ID");
}

export function isApiProvider(id: string): id is ApiProviderId {
  if (id === "zerobounce" || id === "hunter") return true;
  return id === "clay" && clayApiConfigured();
}

// For the dashboard and /api/health. Reports only whether a key exists — never the key.
export function providerStatuses(): ProviderStatus[] {
  return (Object.keys(META) as ProviderId[]).map((id) => {
    if (id === "clay") {
      const api = clayApiConfigured();
      return { id, label: META.clay.label, kind: api ? ("api" as const) : ("manual" as const), configured: true, ...(api ? { envKey: "CLAY_API_KEY" } : {}) };
    }
    return { id, label: META[id].label, kind: "api" as const, configured: !!env(META[id].envKey!), envKey: META[id].envKey };
  });
}

export function providerLabel(id: ProviderId): string {
  return META[id].label;
}

async function requestJson(
  fetchImpl: FetchLike,
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string },
  label: string
): Promise<{ status: number; data: any; retryAfter: number | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { ...init, signal: controller.signal });
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    const ra = Number((res as any).headers?.get?.("retry-after"));
    return { status: res.status, data, retryAfter: Number.isFinite(ra) && ra > 0 ? ra : null };
  } catch (err: any) {
    if (err?.name === "AbortError") throw new VerifierError("network", `${label} took too long to answer — try again.`);
    // Say why, with anything secret removed, so a bad setup can be told from a real outage.
    let why = String(err?.cause?.code ?? err?.cause?.message ?? err?.message ?? "");
    let queryValues: string[] = [];
    try {
      queryValues = Array.from(new URL(url).searchParams.values());
    } catch {
      /* not a parseable URL: nothing extra to hide */
    }
    for (const secret of [...Object.values(init.headers ?? {}), ...queryValues, url]) {
      if (secret) why = why.split(secret).join("[hidden]");
    }
    why = why.replace(/\s+/g, " ").slice(0, 120);
    throw new VerifierError("network", `Couldn't reach ${label}${why ? ` (${why})` : ""} — try again.`);
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

  const { status, data } = await requestJson(fetchImpl, url.toString(), {}, "ZeroBounce");
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
  const { status, data } = await requestJson(fetchImpl, url, { headers: { "X-API-KEY": apiKey } }, "Hunter");
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

// ---- Clay (Public API) ------------------------------------------------------
// Documented flow (developers.clay.com): POST /routines/function:t_…/run with
// { items: [{ id, inputs }] } answers 202 { routine_run_id }; then
// GET /routines/run/{id}/results answers 202 while running and 200
// { status: "complete", data: [{ id, status: "complete"|"failed", result|error }] }.
// What a person's "verify email" function returns is up to that function, so the
// answer is read defensively: only an explicit, known word becomes a verdict;
// anything else is "unknown" and the original output is kept in `raw`.

const CLAY_BASE = "https://api.clay.com/public/v0";
const CLAY_ITEM_ID = "verify-1";

export type ClayTiming = { sleep: (ms: number) => Promise<void>; now: () => number; pollMs: number; deadlineMs: number; maxRetryAfterMs: number };
const REAL_CLAY_TIMING: ClayTiming = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  pollMs: 2000,
  deadlineMs: 45_000, // the API route may run for at most 60s
  maxRetryAfterMs: 10_000,
};

export type ClayConfig = { apiKey: string; functionId: string; inputName: string };

export function normalizeClayFunctionId(id: string): string {
  const t = id.trim();
  return t.startsWith("function:") ? t : `function:${t}`;
}

const DELIVERABLE_WORDS = new Set(["valid", "deliverable", "verified", "safe", "ok", "good"]);
const UNDELIVERABLE_WORDS = new Set(["invalid", "undeliverable", "bad", "bounce", "bounced", "not_valid", "invalid_email", "mailbox_not_found"]);
const RISKY_WORDS = new Set(["risky", "catch_all", "catchall", "accept_all", "accepts_all", "disposable", "role_based", "do_not_mail"]);
const UNKNOWN_WORDS = new Set(["unknown", "unverifiable", "unable_to_verify", "inconclusive"]);
// Keys that usually carry the verdict, most specific first.
const TEXT_KEYS = ["email_status", "verification_status", "validation_status", "deliverability", "status", "result", "verdict", "validation", "quality"];
const BOOL_KEYS = ["valid", "is_valid", "deliverable", "is_deliverable", "verified", "is_verified"];

function verdictForWord(value: unknown): Verdict | null {
  if (typeof value !== "string") return null;
  const w = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (DELIVERABLE_WORDS.has(w)) return "deliverable";
  if (UNDELIVERABLE_WORDS.has(w)) return "undeliverable";
  if (RISKY_WORDS.has(w)) return "risky";
  if (UNKNOWN_WORDS.has(w)) return "unknown";
  return null;
}

function flatten(obj: unknown, depth = 0, out: Array<[string, unknown]> = []): Array<[string, unknown]> {
  if (obj && typeof obj === "object" && !Array.isArray(obj) && depth < 3) {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, depth + 1, out);
      else out.push([k.toLowerCase(), v]);
    }
  }
  return out;
}

export function interpretClayResult(result: unknown): ProviderResult {
  const value = Array.isArray(result) ? result[0] : result;
  // A function may simply return the word.
  const direct = verdictForWord(value);
  if (direct) return { verdict: direct, raw: String(value).slice(0, 80) };

  const entries = flatten(value);
  for (const key of TEXT_KEYS) {
    for (const [k, v] of entries) {
      if (k !== key) continue;
      const verdict = verdictForWord(v);
      if (verdict) return { verdict, raw: `${key}: ${String(v).slice(0, 80)}` };
    }
  }
  for (const key of BOOL_KEYS) {
    for (const [k, v] of entries) {
      if (k === key && typeof v === "boolean") return { verdict: v ? "deliverable" : "undeliverable", raw: `${key}: ${v}` };
    }
  }
  let snippet = "";
  try {
    snippet = JSON.stringify(value) ?? "";
  } catch {
    snippet = "";
  }
  return { verdict: "unknown", raw: `unrecognized answer: ${snippet.slice(0, 180)}` };
}

function clayHttpError(status: number, data: any): VerifierError {
  if (status === 401 || status === 403) return new VerifierError("auth", "Clay rejected the API key.");
  if (status === 404) return new VerifierError("bad_request", "Clay couldn't find that function — check CLAY_FUNCTION_ID (it starts with t_).");
  if (status === 429) return new VerifierError("rate", "Clay is rate-limiting requests — wait a moment and try again.");
  if (status === 400) return new VerifierError("bad_request", `Clay didn't accept the request${data?.message ? `: ${String(data.message).slice(0, 140)}` : "."}`);
  return new VerifierError("bad_response", `Clay returned an unexpected HTTP status (${status}).`);
}

export async function verifyClay(
  email: string,
  cfg: ClayConfig,
  fetchImpl: FetchLike,
  timing: ClayTiming = REAL_CLAY_TIMING
): Promise<ProviderResult> {
  const headers = { "clay-api-key": cfg.apiKey, "Content-Type": "application/json" };
  const runUrl = `${CLAY_BASE}/routines/${encodeURI(normalizeClayFunctionId(cfg.functionId))}/run`;
  const start = await requestJson(
    fetchImpl,
    runUrl,
    { method: "POST", headers, body: JSON.stringify({ items: [{ id: CLAY_ITEM_ID, inputs: { [cfg.inputName]: email } }] }) },
    "Clay"
  );
  if (start.status !== 200 && start.status !== 202) throw clayHttpError(start.status, start.data);
  const runId = start.data?.routine_run_id;
  if (typeof runId !== "string" || !runId) throw new VerifierError("bad_response", "Clay didn't say which run it started.");

  const deadline = timing.now() + timing.deadlineMs;
  const resultsUrl = `${CLAY_BASE}/routines/run/${encodeURIComponent(runId)}/results`;
  while (true) {
    await timing.sleep(timing.pollMs);
    const r = await requestJson(fetchImpl, resultsUrl, { headers }, "Clay");

    if (r.status === 429) {
      if (timing.now() >= deadline) throw clayHttpError(429, r.data);
      await timing.sleep(Math.min((r.retryAfter ?? 2) * 1000, timing.maxRetryAfterMs));
      continue;
    }
    if (r.status === 202 || (r.status === 200 && r.data?.status === "in_progress")) {
      if (timing.now() >= deadline) {
        throw new VerifierError("pending", "Clay is still working on this address — wait a minute before trying again (each try starts a new run).");
      }
      continue;
    }
    if (r.status !== 200) throw clayHttpError(r.status, r.data);

    const items: any[] = Array.isArray(r.data?.data) ? r.data.data : [];
    const item = items.find((x) => x?.id === CLAY_ITEM_ID) ?? items[0];
    if (!item) throw new VerifierError("bad_response", "Clay finished but returned no result.");
    if (item.status === "failed") {
      throw new VerifierError("bad_response", `Clay couldn't verify this address: ${String(item.error?.message ?? "no reason given").slice(0, 160)}`);
    }
    return interpretClayResult(item.result);
  }
}

// ---- entry point -----------------------------------------------------------

export async function verifyWithProvider(
  id: ApiProviderId,
  email: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  apiKeyOverride?: string,
  clayTiming?: ClayTiming
): Promise<ProviderResult> {
  const keyToCheck = apiKeyOverride ?? env(META[id].envKey!);
  if (keyToCheck && /[^\x21-\x7e]/.test(keyToCheck)) {
    throw new VerifierError(
      "auth",
      `${META[id].envKey} contains a character that isn't allowed (a space, quote, line break, or a symbol like … or •). Copy the full key again, paste it with nothing around it, save and redeploy.`
    );
  }
  if (id === "clay") {
    const apiKey = apiKeyOverride ?? env("CLAY_API_KEY");
    const functionId = env("CLAY_FUNCTION_ID");
    if (!apiKey || !functionId) {
      throw new VerifierError("auth", "Clay's API isn't set up: add CLAY_API_KEY and CLAY_FUNCTION_ID in Vercel and redeploy.");
    }
    return verifyClay(email, { apiKey, functionId, inputName: env("CLAY_INPUT_NAME") || "email" }, fetchImpl, clayTiming);
  }
  const apiKey = apiKeyOverride ?? env(META[id].envKey!);
  if (!apiKey) throw new VerifierError("auth", `${META[id].label} isn't set up: add ${META[id].envKey} in Vercel and redeploy.`);
  return id === "zerobounce" ? verifyZeroBounce(email, apiKey, fetchImpl) : verifyHunter(email, apiKey, fetchImpl);
}
