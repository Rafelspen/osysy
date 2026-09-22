// 4-tier email discovery for the SOURCED -> ENRICHED pipeline stage.
// Zero-guessing rule: this module only ever returns emails it actually found
// in fetched content. It never constructs or infers an address.

import dns from "dns";

const FETCH_TIMEOUT_MS = 8000;
const MAX_PATHS_TO_TRY = 24;
const MX_LOOKUP_TIMEOUT_MS = 3000;

// Caps the ENTIRE discoverEmails() call for one lead, across every tier.
// Pipeline ticks process up to 10 leads in one 60s Vercel function
// (LEADS_PER_TICK in pipeline-runner.ts), so a single slow or unresponsive
// website must never be able to eat the whole tick — this is what makes
// discovery finish reliably instead of sometimes getting killed mid-run.
const DISCOVERY_DEADLINE_MS = 15000;
// How many candidate contact/about pages to fetch at once in tier 3, instead
// of one at a time — lets more of the time budget above turn into real
// attempts rather than waiting on one slow request after another.
const PATH_FETCH_CONCURRENCY = 6;

const CONTACT_LINK_KEYWORDS = ["contact", "about", "team", "reach", "support", "connect", "press", "media", "get-in-touch"];

const COMMON_PATHS = [
  "/contact",
  "/contact-us",
  "/contactus",
  "/about",
  "/about-us",
  "/aboutus",
  "/team",
  "/our-team",
  "/company",
  "/company/contact",
  "/get-in-touch",
  "/reach-us",
  "/support",
  "/help",
  "/info",
  "/connect",
  "/contacts",
  "/contact.html",
  "/contact.php",
  "/pages/contact",
  "/pages/contact-us",
  "/en/contact",
  "/press",
  "/media",
];

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const MAILTO_HREF_REGEX = /href=["']mailto:([^"'?]+)/gi;

const PLACEHOLDER_LOCAL_PARTS = new Set([
  "noreply",
  "no-reply",
  "donotreply",
  "example",
  "test",
  "someone",
  "youremail",
  "name",
]);

// IETF-reserved documentation domains (RFC 2606) plus the handful of
// placeholder domains template/boilerplate content commonly uses. A page
// that mentions these is showing a sample address, not a real contact —
// e.g. API docs on a company's own site routinely use jane@example.com.
const PLACEHOLDER_DOMAINS = new Set([
  "example.com",
  "example.org",
  "example.net",
  "example.edu",
  "test.com",
  "yourdomain.com",
  "yourcompany.com",
]);

type FetchedPage = { html: string; finalUrl: string };

// Returns the page's final URL alongside its HTML — a domain-level redirect
// (bare domain -> www, or an old domain -> a rebranded one, both common) means
// the page we actually got often isn't at the URL we requested, and relative
// links on it must be resolved against where it really ended up, not where we
// started (see how callers use finalUrl below).
//
// outerSignal, when given, is a shared deadline for the WHOLE discoverEmails()
// call (see DISCOVERY_DEADLINE_MS) — aborting it cancels this fetch too, even
// mid-flight, so the deadline is a hard cutoff rather than only checked
// between fetches (a fetch that had already started could otherwise still
// run its own full FETCH_TIMEOUT_MS past the deadline).
async function fetchText(url: string, outerSignal?: AbortSignal): Promise<FetchedPage | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const onOuterAbort = () => controller.abort();
  if (outerSignal) {
    if (outerSignal.aborted) controller.abort();
    else outerSignal.addEventListener("abort", onOuterAbort);
  }
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; OutboundControlRoom/1.0)" },
    });
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("text") && !contentType.includes("xml") && !contentType.includes("json")) return null;
    const html = await res.text();
    return { html, finalUrl: res.url || url };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
    if (outerSignal) outerSignal.removeEventListener("abort", onOuterAbort);
  }
}

function normalizeUrl(url: string): string {
  if (!/^https?:\/\//i.test(url)) return `https://${url}`;
  return url;
}

// Inline <script>/<style> blocks routinely contain unicode-escaped JSON or JS
// string literals (e.g. ">") that sit right next to unrelated text and
// can glue together into something that only *looks* like a stray email —
// found scanning real sites during testing. Structured data in scripts is
// already handled separately and correctly by extractEmailsFromJsonLd, so
// it's safe to exclude script/style contents here entirely.
function stripScriptsAndStyles(html: string): string {
  return html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "").replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
}

function extractEmailsFromText(html: string): string[] {
  const matches = stripScriptsAndStyles(html).match(EMAIL_REGEX) ?? [];
  return matches.map((m) => m.toLowerCase());
}

function extractEmailsFromMailtoLinks(html: string): string[] {
  const results: string[] = [];
  let match: RegExpExecArray | null;
  MAILTO_HREF_REGEX.lastIndex = 0;
  while ((match = MAILTO_HREF_REGEX.exec(html)) !== null) {
    const addr = decodeURIComponent(match[1]).split(",")[0].trim().toLowerCase();
    if (addr) results.push(addr);
  }
  return results;
}

function extractEmailsFromJsonLd(html: string): string[] {
  const results: string[] = [];
  const scriptRegex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptRegex.exec(html)) !== null) {
    try {
      const json = JSON.parse(match[1].trim());
      collectEmailFields(json, results);
    } catch {
      // malformed JSON-LD, skip
    }
  }
  return results;
}

function collectEmailFields(node: unknown, out: string[]): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) collectEmailFields(item, out);
    return;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key.toLowerCase() === "email" && typeof value === "string") {
      out.push(value.replace(/^mailto:/i, "").toLowerCase());
    } else if (typeof value === "object") {
      collectEmailFields(value, out);
    }
  }
}

function extractSitemapUrls(xml: string): string[] {
  const matches = xml.match(/<loc>([^<]+)<\/loc>/gi) ?? [];
  return matches.map((m) => m.replace(/<\/?loc>/gi, "").trim());
}

// True if two hosts are the company's own site — the same host, or one a
// subdomain of the other (bare domain vs www, or blog./careers./support.
// subdomains all still count as "their own website"). A genuinely different
// domain does not, even if the company's site redirected there itself: a
// guessed/discovered path can 302 off to a third-party contact-form SaaS, a
// tracking redirector, or (in the worst case) a hijacked/expired link, and
// none of those are "the company's own website" — only the homepage's own
// landing spot is trusted as the root of the site (see discoverEmails).
function isSameSite(hostA: string, hostB: string): boolean {
  const a = hostA.toLowerCase().replace(/^www\./, "");
  const b = hostB.toLowerCase().replace(/^www\./, "");
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

// A sitemap.xml is free-form XML — a listed <loc> could be malformed or,
// rarely, point off-site (a CDN, a shared multi-brand sitemap). Guards the
// URL parse and applies the same same-site rule before we ever fetch it.
function sameSiteUrl(url: string, rootHost: string): boolean {
  try {
    return isSameSite(new URL(url).hostname, rootHost);
  } catch {
    return false;
  }
}

// Finds the site's own contact/about/team links from its homepage nav or
// footer, instead of only guessing generic paths — a link the site actually
// publishes is more likely to be the real contact page than any fixed guess,
// and checking it first means fewer wasted fetches overall.
function extractContactLikeLinks(html: string, origin: string, rootHost: string): string[] {
  const scored: { url: string; score: number }[] = [];
  const anchorRegex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while ((match = anchorRegex.exec(html)) !== null) {
    const href = match[1];
    if (/^(mailto:|tel:|javascript:|#)/i.test(href)) continue;
    let resolved: URL;
    try {
      resolved = new URL(href, origin);
    } catch {
      continue;
    }
    if (!isSameSite(resolved.hostname, rootHost)) continue; // the company's own site (incl. subdomains) only
    resolved.hash = "";
    const linkText = match[2].replace(/<[^>]+>/g, " ").trim().toLowerCase();
    const haystack = `${resolved.pathname.toLowerCase()} ${linkText}`;
    const score = CONTACT_LINK_KEYWORDS.reduce((n, kw) => (haystack.includes(kw) ? n + 1 : n), 0);
    if (score > 0) scored.push({ url: resolved.toString(), score });
  }
  scored.sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const { url } of scored) {
    if (!seen.has(url)) {
      seen.add(url);
      out.push(url);
    }
  }
  return out;
}

function dedupeUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of urls) {
    if (!seen.has(u)) {
      seen.add(u);
      out.push(u);
    }
  }
  return out;
}

// Fetches candidate pages a few at a time (rather than strictly one after
// another) and stops as soon as either enough emails are found or the
// deadline passed in from discoverEmails() runs out. Discards anything a
// fetch redirected off the company's own site (see isSameSite) — this module
// only ever scrapes the company's own website, never wherever a link happens
// to lead.
async function fetchCandidates(
  urls: string[],
  found: string[],
  deadlineExceeded: () => boolean,
  deadlineSignal: AbortSignal,
  rootHost: string
): Promise<void> {
  let next = 0;
  async function worker(): Promise<void> {
    while (next < urls.length) {
      if (dedupe(found).length >= 3 || deadlineExceeded()) return;
      const url = urls[next++];
      const page = await fetchText(url, deadlineSignal);
      if (page && isSameSite(new URL(page.finalUrl).hostname, rootHost)) {
        found.push(...extractEmailsFromMailtoLinks(page.html));
        found.push(...extractEmailsFromText(page.html));
      }
    }
  }
  const workers = Array.from({ length: Math.min(PATH_FETCH_CONCURRENCY, urls.length) }, () => worker());
  await Promise.all(workers);
}

// A long pure-hex local part is a tracking/error-reporting identifier (e.g. a
// Sentry DSN public key embedded in page config, "ac4a4d99...@errors.site.com"),
// never something a person typed as their own address — found embedded in a
// real company's homepage config during testing.
const HEX_TOKEN_LOCAL_PART = /^[a-f0-9]{20,}$/i;

export function isPlausibleEmail(email: string): boolean {
  const [local, domain] = email.split("@");
  if (!local || !domain) return false;
  if (PLACEHOLDER_LOCAL_PARTS.has(local.toLowerCase())) return false;
  if (PLACEHOLDER_DOMAINS.has(domain.toLowerCase())) return false;
  if (HEX_TOKEN_LOCAL_PART.test(local)) return false;
  if (/\.(png|jpg|jpeg|gif|svg|webp|css|js)$/i.test(domain)) return false;
  return true;
}

function dedupe(emails: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of emails) {
    const clean = e.trim().toLowerCase().replace(/\.$/, "");
    if (clean && isPlausibleEmail(clean) && !seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  }
  return out;
}

const GENERIC_TITLE_SEGMENTS = new Set(["home", "homepage", "welcome", "index", "main"]);

export function extractCompanyName(html: string, fallbackHost: string): string {
  const ogSiteName = html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i);
  if (ogSiteName) return ogSiteName[1].trim();
  const title = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (title) {
    const segments = title[1]
      .split(/[-|·]/)
      .map((s) => s.trim())
      .filter(Boolean);
    // Titles like "Home | Acme Inc" put the generic word first — the company
    // name is the next segment, not the one we'd get by always taking [0].
    if (segments.length > 1 && GENERIC_TITLE_SEGMENTS.has(segments[0].toLowerCase())) {
      return segments[1];
    }
    return segments[0] ?? fallbackHost;
  }
  return fallbackHost;
}

export type DiscoveryResult = {
  emails: string[]; // up to 3, priority order
  companyName: string | null;
};

export async function discoverEmails(websiteUrlRaw: string): Promise<DiscoveryResult> {
  const websiteUrl = normalizeUrl(websiteUrlRaw);

  // A single shared deadline for the WHOLE call. Unlike a plain timestamp
  // check between fetches, aborting this signal cancels whatever fetch is
  // currently in flight too — otherwise a fetch that started just before the
  // deadline could still run its own full FETCH_TIMEOUT_MS past it, and that
  // overrun compounds across tiers (this is what let a real site take ~20s
  // against an intended 15s cap during testing).
  const deadlineController = new AbortController();
  const deadlineTimer = setTimeout(() => deadlineController.abort(), DISCOVERY_DEADLINE_MS);
  const deadlineSignal = deadlineController.signal;
  const deadlineExceeded = () => deadlineSignal.aborted;

  try {
    const found: string[] = [];
    let companyName: string | null = null;

    // Tier 1 + Tier 2: homepage regex scan + mailto href parsing. A domain-level
    // redirect (bare domain -> www, or a rebrand to a different domain) means
    // the page we actually land on can be at a different origin than the one
    // in the sheet — use THAT final origin for everything below, so relative
    // links on the real page resolve to real URLs instead of dead ones back on
    // the original domain.
    const homepage = await fetchText(websiteUrl, deadlineSignal);
    const origin = homepage ? new URL(homepage.finalUrl).origin : new URL(websiteUrl).origin;
    const host = homepage ? new URL(homepage.finalUrl).hostname : new URL(websiteUrl).hostname;
    if (homepage) {
      companyName = extractCompanyName(homepage.html, host);
      found.push(...extractEmailsFromMailtoLinks(homepage.html));
      found.push(...extractEmailsFromText(homepage.html));
    }

    // Tier 3: try the site's own contact/about links (found in its homepage
    // nav/footer) first, then fall back to guessing common paths for anything
    // still needed. Fetched a few at a time and bounded by the shared deadline
    // above, so one slow or unresponsive site can never stall the whole
    // pipeline tick.
    if (dedupe(found).length < 3 && !deadlineExceeded()) {
      const discoveredLinks = homepage ? extractContactLikeLinks(homepage.html, origin, host) : [];
      const guessedPaths = COMMON_PATHS.slice(0, MAX_PATHS_TO_TRY).map((path) => `${origin}${path}`);
      const candidates = dedupeUrls([...discoveredLinks, ...guessedPaths]).filter((u) => u !== (homepage?.finalUrl ?? websiteUrl));
      await fetchCandidates(candidates, found, deadlineExceeded, deadlineSignal, host);
    }

    // Tier 4: sitemap.xml + JSON-LD structured data — last resort, only if
    // still nothing found and there's still time left in the budget.
    if (dedupe(found).length < 1 && !deadlineExceeded()) {
      const sitemap = await fetchText(`${origin}/sitemap.xml`, deadlineSignal);
      if (sitemap && isSameSite(new URL(sitemap.finalUrl).hostname, host)) {
        const urls = extractSitemapUrls(sitemap.html)
          .filter((u) => sameSiteUrl(u, host))
          .slice(0, 10);
        for (const url of urls) {
          if (dedupe(found).length >= 3 || deadlineExceeded()) break;
          const page = await fetchText(url, deadlineSignal);
          if (page && isSameSite(new URL(page.finalUrl).hostname, host)) {
            found.push(...extractEmailsFromJsonLd(page.html));
            found.push(...extractEmailsFromMailtoLinks(page.html));
          }
        }
      }
      if (homepage) {
        found.push(...extractEmailsFromJsonLd(homepage.html));
      }
    }

    return { emails: dedupe(found).slice(0, 3), companyName };
  } finally {
    clearTimeout(deadlineTimer);
  }
}

const KNOWN_WORKSPACE_MX_EXCEPTIONS = ["gmail.com", "googlemail.com"];

export function isEmailUsableForDomain(email: string, websiteUrlRaw: string): boolean {
  if (!isPlausibleEmail(email)) return false;
  const [, domain] = email.split("@");
  const host = new URL(normalizeUrl(websiteUrlRaw)).hostname.replace(/^www\./, "");
  const emailDomain = domain.replace(/^www\./, "");

  if (emailDomain === host) return true;
  if (host.endsWith(emailDomain) || emailDomain.endsWith(host)) return true;
  // Known exception: companies on Google Workspace sometimes publish a
  // gmail.com contact address rather than one on their own domain.
  if (KNOWN_WORKSPACE_MX_EXCEPTIONS.includes(emailDomain)) return true;
  return false;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("DNS lookup timed out")), ms)),
  ]);
}

async function domainHasMxRecords(domain: string): Promise<"has_mx" | "no_records" | "inconclusive"> {
  try {
    const records = await withTimeout(dns.promises.resolveMx(domain), MX_LOOKUP_TIMEOUT_MS);
    return records.length > 0 ? "has_mx" : "no_records";
  } catch (err: any) {
    if (err?.code === "ENOTFOUND" || err?.code === "ENODATA") return "no_records";
    return "inconclusive"; // timeout, ESERVFAIL, network issue — don't treat as a real signal
  }
}

async function domainHasAddressRecord(domain: string): Promise<boolean> {
  try {
    const a = await withTimeout(dns.promises.resolve4(domain), MX_LOOKUP_TIMEOUT_MS);
    if (a.length > 0) return true;
  } catch {
    // fall through to IPv6
  }
  try {
    const aaaa = await withTimeout(dns.promises.resolve6(domain), MX_LOOKUP_TIMEOUT_MS);
    if (aaaa.length > 0) return true;
  } catch {
    // no address record either
  }
  return false;
}

export type MxStatus = "valid" | "no_mx" | "unknown";

// Confirms a domain can actually receive mail — either it has MX records, or
// (per RFC 5321 fallback behavior) an A/AAAA record SMTP can route to
// directly. Never flags "no_mx" on a DNS hiccup: an inconclusive lookup
// (timeout, resolver error) comes back "unknown" instead, so a transient
// network blip can never wrongly stall a lead.
async function checkDomainMxStatus(domain: string): Promise<MxStatus> {
  const mxResult = await domainHasMxRecords(domain);
  if (mxResult === "has_mx") return "valid";
  if (mxResult === "inconclusive") return "unknown";

  const hasFallback = await domainHasAddressRecord(domain);
  return hasFallback ? "valid" : "no_mx";
}

export async function checkMxStatus(email: string): Promise<MxStatus> {
  const domain = email.split("@")[1];
  if (!domain) return "unknown";
  return checkDomainMxStatus(domain);
}

export type MxSummary = {
  byEmail: Record<string, MxStatus>;
  validCount: number;
  total: number;
};

// Checks every candidate address, but only one DNS lookup per unique domain
// — e.g. support@ and sales@ on the same company domain share one check.
// Domains are looked up in parallel, so checking all 3 candidate slots costs
// the same latency as checking one.
export async function summarizeMxStatus(emails: string[]): Promise<MxSummary> {
  const unique = Array.from(new Set(emails.map((e) => e.trim()).filter(Boolean)));
  const domainOf = (email: string) => email.split("@")[1]?.toLowerCase();
  const uniqueDomains = Array.from(new Set(unique.map(domainOf).filter((d): d is string => !!d)));

  const entries = await Promise.all(uniqueDomains.map(async (d) => [d, await checkDomainMxStatus(d)] as const));
  const domainStatus = new Map(entries);

  const byEmail: Record<string, MxStatus> = {};
  let validCount = 0;
  for (const email of unique) {
    const domain = domainOf(email);
    const status = (domain && domainStatus.get(domain)) || "unknown";
    byEmail[email] = status;
    if (status === "valid") validCount++;
  }
  return { byEmail, validCount, total: unique.length };
}
