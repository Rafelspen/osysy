// 4-tier email discovery for the SOURCED -> ENRICHED pipeline stage.
// Zero-guessing rule: this module only ever returns emails it actually found
// in fetched content. It never constructs or infers an address.

const FETCH_TIMEOUT_MS = 8000;
const MAX_PATHS_TO_TRY = 24;

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

async function fetchText(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (compatible; OutboundControlRoom/1.0)" },
    });
    if (!res.ok) return null;
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("text") && !contentType.includes("xml") && !contentType.includes("json")) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeUrl(url: string): string {
  if (!/^https?:\/\//i.test(url)) return `https://${url}`;
  return url;
}

function extractEmailsFromText(text: string): string[] {
  const matches = text.match(EMAIL_REGEX) ?? [];
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

export function isPlausibleEmail(email: string): boolean {
  const [local, domain] = email.split("@");
  if (!local || !domain) return false;
  if (PLACEHOLDER_LOCAL_PARTS.has(local.toLowerCase())) return false;
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

export function extractCompanyName(html: string, fallbackHost: string): string {
  const ogSiteName = html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i);
  if (ogSiteName) return ogSiteName[1].trim();
  const title = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (title) {
    return title[1]
      .split(/[-|·]/)[0]
      .trim();
  }
  return fallbackHost;
}

export type DiscoveryResult = {
  emails: string[]; // up to 3, priority order
  companyName: string | null;
};

export async function discoverEmails(websiteUrlRaw: string): Promise<DiscoveryResult> {
  const websiteUrl = normalizeUrl(websiteUrlRaw);
  const host = new URL(websiteUrl).hostname;

  const found: string[] = [];
  let companyName: string | null = null;

  // Tier 1 + Tier 2: homepage regex scan + mailto href parsing.
  const homepageHtml = await fetchText(websiteUrl);
  if (homepageHtml) {
    companyName = extractCompanyName(homepageHtml, host);
    found.push(...extractEmailsFromMailtoLinks(homepageHtml));
    found.push(...extractEmailsFromText(homepageHtml));
  }

  // Tier 3: guess common paths, scan each, until we have enough or run out.
  if (dedupe(found).length < 3) {
    const base = `${new URL(websiteUrl).origin}`;
    for (const path of COMMON_PATHS.slice(0, MAX_PATHS_TO_TRY)) {
      if (dedupe(found).length >= 3) break;
      const pageHtml = await fetchText(`${base}${path}`);
      if (pageHtml) {
        found.push(...extractEmailsFromMailtoLinks(pageHtml));
        found.push(...extractEmailsFromText(pageHtml));
      }
    }
  }

  // Tier 4: sitemap.xml + JSON-LD structured data.
  if (dedupe(found).length < 1) {
    const base = `${new URL(websiteUrl).origin}`;
    const sitemap = await fetchText(`${base}/sitemap.xml`);
    if (sitemap) {
      const urls = extractSitemapUrls(sitemap).slice(0, 10);
      for (const url of urls) {
        if (dedupe(found).length >= 3) break;
        const pageHtml = await fetchText(url);
        if (pageHtml) {
          found.push(...extractEmailsFromJsonLd(pageHtml));
          found.push(...extractEmailsFromMailtoLinks(pageHtml));
        }
      }
    }
    if (homepageHtml) {
      found.push(...extractEmailsFromJsonLd(homepageHtml));
    }
  }

  return { emails: dedupe(found).slice(0, 3), companyName };
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
