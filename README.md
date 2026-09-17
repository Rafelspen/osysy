# Outbound Campaign Control Room

Single-user control room for an automated cold-outreach pipeline. Leads live in a Google
Sheet; this app reads/advances them through pipeline stages and drafts personalized emails
in Gmail for manual review and send. Nothing is ever auto-sent.

## Stack

Next.js 14 (App Router, TypeScript) on Vercel, Postgres for app state (OAuth tokens,
templates, run logs — never lead data), Google Sheets API + Gmail API for everything
lead-facing.

## 1. Environment variables

Copy `.env.example` to `.env.local` and fill in:

| Var | Notes |
|---|---|
| `DATABASE_URL` | Vercel Postgres or Supabase Postgres connection string |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | From Google Cloud Console OAuth client |
| `GOOGLE_REDIRECT_URI` | Must exactly match a redirect URI registered in Cloud Console |
| `TOKEN_ENCRYPTION_KEY` | 32-byte key, base64. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `CRON_SECRET` | Any random string. Required in the `x-cron-secret` header on `POST /api/pipeline/tick` |

## 2. Google Cloud Console setup

1. Create a project (or reuse one) at console.cloud.google.com.
2. **APIs & Services -> Library**: enable "Google Sheets API" and "Gmail API".
3. **APIs & Services -> OAuth consent screen**: type "External" is fine for a single-user
   tool — add yourself as a test user so you don't need Google's app-verification review.
4. **APIs & Services -> Credentials -> Create Credentials -> OAuth client ID**, type "Web
   application". Add **both** redirect URIs you'll use:
   - `http://localhost:3000/api/oauth/google/callback` (local dev)
   - `https://<your-app>.vercel.app/api/oauth/google/callback` (production)
5. Copy the client ID/secret into your env vars. Scopes requested by the app at connect
   time: `gmail.compose` and `spreadsheets` (read/write) — no broader Gmail access is ever
   requested.

## 3. Database

**Recommended (matches "push to GitHub, connect to Vercel"): use Vercel's built-in Postgres
storage instead of installing Postgres locally.** One database serves both local dev and
production — no separate local install, no syncing two DBs.

1. Push this repo to GitHub (see §5 step 1) and import it into a Vercel project.
2. In the Vercel project: **Storage tab -> Create Database -> Postgres** (Neon-backed, free
   tier available). Connect it to your project — Vercel automatically adds `POSTGRES_URL`
   (and a few related vars) to every environment (Production/Preview/Development). This
   app reads that var automatically as a fallback if `DATABASE_URL` isn't set
   (`src/lib/db.ts`), so no renaming needed.
3. Pull those env vars down for local dev:
   ```bash
   npm install -g vercel   # if you don't have it
   vercel link             # links this folder to the Vercel project, run once
   vercel env pull .env.local
   ```
   This also pulls in anything else you've set in Vercel's dashboard (Google OAuth vars,
   `TOKEN_ENCRYPTION_KEY`, `CRON_SECRET` — see §1 and §2), so add those in the Vercel
   dashboard first if you want one `vercel env pull` to grab everything.
4. Run the migration (reads `DATABASE_URL`, falling back to `POSTGRES_URL_NON_POOLING` /
   `POSTGRES_URL`):
   ```bash
   npm run migrate
   ```

**Alternative**: any other Postgres works too (Supabase, a local install, Docker) — just
set `DATABASE_URL` in `.env.local` yourself and run `npm run migrate`.

## 4. Local dev

```bash
npm install
npm run dev
```

Open `http://localhost:3000/connect`, connect Gmail, paste your lead Sheet's URL. Then
visit `/templates` to set your first outreach template, `/add-lead` to add a lead, and
`/dashboard` to watch it move through stages — use the **Run pipeline now** button there
to trigger a tick manually instead of waiting on the scheduler.

## 5. Deploy

1. Push to a GitHub repo, import into Vercel.
2. Set the same env vars in Vercel's project settings (**use the production
   `GOOGLE_REDIRECT_URI`**, and add that exact URL as a redirect URI in Cloud Console too —
   see step 2 above). If you used Vercel Postgres (§3), the database vars are already set.
3. Make sure the migration has been run against whichever `DATABASE_URL`/`POSTGRES_URL`
   production is using (§3 step 4 covers this if you're on Vercel Postgres).
4. **Cron trigger** — pick one:
   - **Vercel Pro**: add a `crons` entry to `vercel.json` pointing at
     `/api/pipeline/tick` with schedule `* * * * *`, and set the `x-cron-secret` header via
     Vercel's cron config. Vercel Cron on the free Hobby plan only runs once/day, so this
     path needs Pro ($20/mo).
   - **Free (recommended default for this project)**: use the included
     `.github/workflows/pipeline-tick.yml`. Add two repo secrets — `APP_URL` (your deployed
     URL) and `CRON_SECRET` (matching the Vercel env var) — and GitHub Actions will hit the
     tick endpoint every minute for free.
5. First-time connect happens the same way as local dev: visit `/connect` on the deployed
   URL, connect Gmail, connect the Sheet.

## 6. How it works

`POST /api/pipeline/tick` (secret-gated) and `POST /api/pipeline/run-now` (same-origin
manual trigger from `/dashboard`, no secret — this app has no login system by design and
that route can only ever advance leads) both run the same logic in
`src/lib/pipeline-runner.ts`:

1. Acquire `pipeline_lock` (90s lease) — skips the run if another tick is still in flight.
2. Read all Sheet rows not yet `DRAFTED`, take up to 10.
3. Advance each lead exactly one stage (`src/lib/pipeline.ts`): `SOURCED -> ENRICHED`
   (email discovery), `ENRICHED -> VERIFIED` (sanity check), `VERIFIED -> OUTREACH`
   (render template + spam check), `OUTREACH -> QA` (create/update Gmail draft — dedup via
   the stored `gmail_draft_id`, never a second draft), `QA -> DRAFTED` (re-fetch the draft
   and confirm it matches before marking done).
4. Write updates back to the Sheet, log the run to `pipeline_runs`, release the lock.

A lead only ever moves one stage per tick, so each cron invocation stays fast and failures
are easy to isolate — a stuck lead just sits at its current stage with `last_error` set,
and retries on the next tick.

## 7. Deliverability — please read before touching the template

The single biggest lever on whether these land in an inbox or a spam folder is **not**
the template copy — it's keeping this looking like a human sending occasional plain
emails, not a mailer. The build deliberately:

- Sends **plain-text first**. The HTML alternative part exists only for clients that
  prefer it, and mirrors the plain text almost exactly — no fonts, colors, backgrounds,
  images, or logo.
- Has **zero tracking**: no open-tracking pixel, no link shorteners, no click tracking.
  This is one of the heaviest-weighted spam signals mail providers use — do not add it
  later "for analytics."
- Never attaches anything on first outreach.
- Never auto-sends. Every message is a Gmail **draft** you send manually, one at a time,
  from your real account — this is already close to best-case deliverability. Don't build
  a "send all drafts" button; that erodes the exact thing that makes this work.
- Runs a soft, non-blocking spam-signal checklist (`src/lib/spam-check.ts`) before each
  draft — ALL-CAPS/exclamation points in the subject, fake Re:/Fwd:, stacked dollar
  amounts, trigger phrases, more than one link — and logs warnings to `last_error`. It
  never rewrites your copy.

If you outgrow casual volume, the next lever is warming up the sending account (small
daily volume increasing over weeks), not template tweaks — not needed for this build.

Confirm SPF/DKIM/DMARC are set up for your sending domain if you're on Google Workspace
with a custom domain (a normal `@gmail.com` account already has these correctly
configured via Gmail's own servers) — a misconfigured domain is a bigger deliverability
risk than anything in the email body.

## 8. Sheet contract

Columns A–J, header row required, exact order:

| Col | Field | Filled by |
|---|---|---|
| A | Source | You |
| B | Company Name | Pipeline (SOURCED) |
| C | Website URL | You |
| D | Official Email/TO | Pipeline (ENRICHED) |
| E | Secondary Email/CC | Pipeline (ENRICHED) |
| F | Another Email | Pipeline (ENRICHED) |
| G | Email Name for greeting | Pipeline (SOURCED), defaults to Company Name |
| H | Pipeline Stage | Pipeline — `SOURCED / ENRICHED / VERIFIED / OUTREACH / QA / DRAFTED` |
| I | gmail_draft_id | Pipeline (OUTREACH) — dedup key, never create a 2nd draft |
| J | last_error | Pipeline — human-readable reason a lead is stuck |

Adding a lead via `/add-lead` writes A + C and sets H = `SOURCED`; everything else starts
blank and is filled by the pipeline.

## 9. Out of scope

Multi-user auth, actual email sending (always draft-only), compliance/opt-out automation
(worth adding before real volume — not part of this build), anything shared with another
project.
