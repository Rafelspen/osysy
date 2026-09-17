import { NextResponse } from "next/server";

// TEMPORARY diagnostic route — reports the shape of DB/Google env vars
// without ever exposing credentials, to debug a "connects to localhost"
// issue in production. Delete this file once resolved.
export const dynamic = "force-dynamic";

function describeConnectionString(raw: string | undefined) {
  if (!raw) return { present: false };
  try {
    const url = new URL(raw);
    return {
      present: true,
      length: raw.length,
      protocol: url.protocol,
      host: url.hostname,
      port: url.port,
      pathname: url.pathname,
    };
  } catch {
    return { present: true, length: raw.length, parseError: true, startsWith: raw.slice(0, 12) };
  }
}

export async function GET() {
  return NextResponse.json({
    DATABASE_URL: describeConnectionString(process.env.DATABASE_URL),
    POSTGRES_URL: describeConnectionString(process.env.POSTGRES_URL),
    GOOGLE_CLIENT_ID_present: !!process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET_present: !!process.env.GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI: process.env.GOOGLE_REDIRECT_URI ?? null,
    TOKEN_ENCRYPTION_KEY_present: !!process.env.TOKEN_ENCRYPTION_KEY,
    CRON_SECRET_present: !!process.env.CRON_SECRET,
    VERCEL_ENV: process.env.VERCEL_ENV ?? null,
  });
}
