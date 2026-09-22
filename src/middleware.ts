import { NextRequest, NextResponse } from "next/server";

// A single username/password gate in front of the whole app (every page and API route),
// checked once here rather than in each route — the simplest way to keep this dashboard
// from being open to anyone who finds the URL, without building real multi-user accounts.
//
// Off by default: if BASIC_AUTH_USER/BASIC_AUTH_PASSWORD aren't set (e.g. local dev), the
// app behaves exactly as before — no login, no change. Set both in Vercel (Production, as
// normal variables) to turn it on.
//
// A few paths are never gated, because the caller isn't a browser that could have already
// signed in:
//   - /api/pipeline/tick — called by your scheduler with its own CRON_SECRET header, not
//     a username/password. Gating it would silently stop every automatic pipeline run.
//   - /api/oauth/google/callback — Google redirects here itself after you approve access;
//     it's protected by Google's own one-time authorization code, not this login.
//   - /privacy, /terms — kept public on purpose (see README §"branding"/Google verification):
//     Google's OAuth review, and anyone who receives a drafted email, can read these without
//     needing your dashboard password.
export const PUBLIC_PATHS = new Set(["/api/pipeline/tick", "/api/oauth/google/callback", "/privacy", "/terms"]);

// Pure — decodes a "Basic <base64>" Authorization header and checks it against the
// configured credentials. Split out from middleware() so it's unit-testable without a
// real Next.js request/response (see the test suite for this file).
export function checkBasicAuth(header: string | null, user: string, pass: string): boolean {
  if (!header?.startsWith("Basic ")) return false;
  try {
    const decoded = atob(header.slice(6));
    const sep = decoded.indexOf(":");
    if (sep === -1) return false;
    return decoded.slice(0, sep) === user && decoded.slice(sep + 1) === pass;
  } catch {
    return false; // malformed base64
  }
}

function unauthorized(): NextResponse {
  return new NextResponse("Authentication required.", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="obsys", charset="UTF-8"' },
  });
}

export function middleware(req: NextRequest): NextResponse {
  if (PUBLIC_PATHS.has(req.nextUrl.pathname)) return NextResponse.next();

  const user = process.env.BASIC_AUTH_USER;
  const pass = process.env.BASIC_AUTH_PASSWORD;
  if (!user || !pass) return NextResponse.next(); // not configured — stay open, as before

  if (checkBasicAuth(req.headers.get("authorization"), user, pass)) return NextResponse.next();
  return unauthorized();
}

export const config = {
  // Everything except Next.js' own static/image assets and the favicon — those never carry
  // lead data and gating them just adds an extra round trip on every page load.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
