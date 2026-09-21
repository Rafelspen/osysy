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
   time: `gmail.compose` (drafts), `gmail.readonly` (only used to read the headers/labels of
   the one thread each lead's outreach lives in, so follow-ups can be threaded — `gmail.compose`
   cannot read threads) and `spreadsheets` (read/write). Add all three under the consent
   screen's Data Access page.

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

Columns A–K, header row required, exact order:

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
| J | last_error | Pipeline — human-readable reason a lead is stuck, or a standing warning (e.g. domain mismatch) that persists once raised |
| K | mx_status | Pipeline (ENRICHED) — `"X/Y valid"`, e.g. `2/3 valid`: of the Y non-empty addresses across D/E/F, X have a domain confirmed able to receive mail (MX, or A/AAAA fallback per RFC 5321), deduped by domain and checked once. The chosen TO address specifically failing (confirmed no mail servers at all) blocks progression; an inconclusive DNS lookup (timeout) never does |

| L | gmail_thread_id | Pipeline (OUTREACH) — the Gmail thread of the first draft; follow-ups reply inside it |
| M | followup_1_draft_id | Dashboard button "Follow-up 1" — dedup key |
| N | followup_2_draft_id | Dashboard button "Follow-up 2" — dedup key |
| O | followup_3_draft_id | Dashboard button "Final follow-up" — dedup key |

If you connected your Sheet before these columns existed, add the header `mx_status` to K1 yourself — the pipeline writes to K regardless, but the column won't have a label until you add it. Headers L1:O1 are filled in automatically the first time a follow-up button is used, if all four are empty.

### Follow-ups

Follow-up drafts are created from the dashboard's **Action** column, never automatically and never sent. A follow-up is refused unless the thread proves the previous email was actually sent, and unless nobody has replied or bounced. It is drafted as `Re: <original subject>` with `In-Reply-To`/`References` set from the last sent message, which is what makes Gmail attach it to the same thread. Leads whose first email was drafted and already sent before column L existed can't be recovered, so their follow-ups can't be threaded.

Adding a lead via `/add-lead` writes A + C and sets H = `SOURCED`; everything else starts
blank and is filled by the pipeline.

## 9. Out of scope

Multi-user auth, actual email sending (always draft-only), compliance/opt-out automation
(worth adding before real volume — not part of this build), anything shared with another
project.

## 10. Connect your business Gmail (step by step)

This app is **single-account**: it holds one Google connection at a time. Connecting your business
account replaces whichever account was connected before (for example a personal Gmail used for testing).
Your leads, templates and Sheet are not affected.

Below, `https://obsys-silk.vercel.app` is the production address. If you later add a custom domain, use
that everywhere instead.

### 10.1 Choose how the Google app is set up

| | Option A — Internal (recommended for your own Workspace) | Option B — External |
|---|---|---|
| Who can connect | Only accounts in your Workspace organization (e.g. `@sesinf.net`) | Any Google account you list as a test user |
| Weekly reconnect | **No** — the 7-day token limit only applies to External apps in "Testing" | **Yes**, about every 7 days while in "Testing" |
| Google verification | Not needed | Needed to publish (see section 2 and the privacy/terms pages) |
| Requirement | The Google Cloud **project must belong to your Workspace organization** | None |
| Good for | Running this for your own business | Testing with a personal Gmail, or later selling the app |

If you use a personal `@gmail.com` account, only Option B exists. The steps below cover both; the
difference is one setting in step 3.

### 10.2 Google Cloud Console

Do this signed in as the account that will own the project (for Option A, your business admin account).

1. Open [console.cloud.google.com](https://console.cloud.google.com) and create a project (name it `obsys`).
   For **Option A**, check that the *Location / Organization* on the create screen is your organization
   (e.g. `sesinf.net`), not "No organization".
2. **APIs & Services → Library**: enable **Gmail API** and **Google Sheets API**.
3. Open **Google Auth Platform** (older UI: *OAuth consent screen*):
   - **Audience / User type**: pick **Internal** (Option A) or **External** (Option B). If *Internal* is
     greyed out, the project is not inside your organization — create it again under the organization.
   - **Option B only**: under *Test users* add the exact Google address you will connect
     (for example `rafael@sesinf.net`). Keep publishing status on **Testing**.
   - **Branding**: app name `obsys`, and your support email. Leave the home page, privacy and terms link
     fields empty unless you are submitting for verification (Google can only verify domains you own, not
     `vercel.app` addresses).
4. **Data Access → Add or remove scopes**: add all three, then save:
   - `https://www.googleapis.com/auth/gmail.compose`
   - `https://www.googleapis.com/auth/gmail.readonly`
   - `https://www.googleapis.com/auth/spreadsheets`
5. **Clients → Create client** (older UI: *Credentials → Create credentials → OAuth client ID*):
   - Application type: **Web application**
   - **Authorized redirect URI**: `https://obsys-silk.vercel.app/api/oauth/google/callback`
     (exact match, no trailing slash). For local development also add `http://localhost:3000/api/oauth/google/callback`.
   - Copy the **Client ID** and **Client secret**.

### 10.3 Workspace admin console (Workspace accounts only)

If Google shows "This app is blocked" or "Access blocked: admin policy" when you connect, your
organization restricts third-party apps:

1. [admin.google.com](https://admin.google.com) → **Security → Access and data control → API controls**.
2. **App access control → Manage Third-Party App Access → Add app → OAuth App Name Or Client ID**.
3. Paste the Client ID from step 5, choose it, and set access to **Trusted**.

### 10.4 Vercel environment variables

In the Vercel project: **Settings → Environment Variables**. Set these for **Production**
(create them as normal variables — do not tick "Sensitive", which stopped them reaching the running app
during setup):

| Variable | Value |
|---|---|
| `GOOGLE_CLIENT_ID` | Client ID from step 5 |
| `GOOGLE_CLIENT_SECRET` | Client secret from step 5 |
| `GOOGLE_REDIRECT_URI` | `https://obsys-silk.vercel.app/api/oauth/google/callback` (same as step 5) |

`DATABASE_URL`, `TOKEN_ENCRYPTION_KEY` and `CRON_SECRET` stay as they are. Changing the client ID or
secret invalidates any earlier Google connection, so you will reconnect in the next step.

Then **redeploy** (Deployments → the latest one → Redeploy) and make sure the live address points at that
deployment (see 10.7).

### 10.5 Connect in the app

1. Open `https://obsys-silk.vercel.app/connect`.
2. Click **Connect Gmail** (or **Reconnect Gmail**) and pick your **business** account.
3. Google lists three permissions — manage drafts, read email (used only for the headers of threads this
   app created), and Google Sheets. Approve them. (Option B shows an "unverified app / testing" screen:
   choose *Continue*.)
4. You return to `/connect` with "Gmail connected".
5. Make sure the business account can open your lead Sheet: the Sheet must be owned by that account, or
   shared with it as **Editor**.
6. Paste the Sheet URL under **Google Sheet** and click **Save & Validate**. A blank Sheet gets its header
   row written automatically; an existing one must already have the header row from section 8.

### 10.6 Check it works

1. `/add-lead`: add one test lead (a company whose site shows a contact email).
2. `/dashboard`: click **Run pipeline now** about six times, or wait for the automatic run. The lead should
   move to `DRAFTED`.
3. Open Gmail → Drafts and confirm the draft (To/Cc, subject, body).
4. Send that first email to yourself or a test address, then click **Follow-up 1** on the dashboard
   (after saving the follow-up templates on `/templates`). The follow-up should appear as a draft inside
   the same thread.

### 10.7 Troubleshooting

| What you see | Cause and fix |
|---|---|
| `Error 403: access_denied` / "has not completed verification" | Option B and the account isn't a test user — add it under Test users. |
| "Access blocked: admin policy" / "app is blocked" | Workspace admin restriction — do 10.3. |
| `redirect_uri_mismatch` | The redirect URI in Google and `GOOGLE_REDIRECT_URI` differ. Make them identical (scheme, host, path). |
| "Google OAuth env vars are not fully configured" | A variable is missing/empty for Production, or you didn't redeploy after setting it. Re-save as a normal variable and redeploy. |
| Red banner "Gmail is disconnected" on the dashboard | The connection expired or was revoked (Option B every ~7 days; any option after a password change). Click **Reconnect Gmail**. |
| Follow-up says "Gmail needs the new read permission" | The connection predates `gmail.readonly`. Add the scope (step 4) and click **Reconnect Gmail**. |
| Follow-up says the first email hasn't been sent | Send it from Gmail first; the app only threads onto an email that was really sent. |
| Sheet error like "not found" / 403 on Save & Validate | The connected account can't open the Sheet — share it as Editor. |
| Live site shows old code after a deploy | The `obsys-silk.vercel.app` alias didn't move. Run `npx vercel alias set <newest-deployment-url> obsys-silk.vercel.app`. A custom domain follows new deploys automatically. |

### 10.8 Deliverability check for the business domain

Before sending real volume, confirm the domain's records (replace the domain):

```bash
node -e "const d=require('dns').promises,x='sesinf.net',t=async n=>(await d.resolveTxt(n)).map(a=>a.join(''));(async()=>{console.log('MX',JSON.stringify(await d.resolveMx(x)));console.log('SPF',await t(x));console.log('DMARC',await t('_dmarc.'+x));console.log('DKIM',await t('google._domainkey.'+x))})()"
```

You want Google MX records, an SPF record containing `include:_spf.google.com`, a DMARC record, and a
`google._domainkey` DKIM record. Then send 3–5 test emails to other inboxes and, in Gmail's
**Show original**, confirm `SPF`, `DKIM` and `DMARC` all say `PASS`. Start at 10–20 emails a day and
increase slowly over a few weeks.

## 11. Instructions for an AI agent

Use this section when an AI coding agent (for example Claude Code) is asked to help connect a Google
account to this deployment. It tells the agent what it can do itself, what it must hand to the human,
and how to verify each step. Replace `$APP` with the production address (`https://obsys-silk.vercel.app`).

### 11.1 Rules

The agent **must not**:

- type, paste or store any secret — Google client secret, `TOKEN_ENCRYPTION_KEY`, `CRON_SECRET`, database
  URL — into any field, CLI command (`vercel env add`), file or message. The human enters these.
- sign in to Google, click through a consent screen, accept terms, create the OAuth client, or change
  Workspace admin settings. These need the human's own account.
- print secret values: never `cat .env.local`, and never echo variables that hold credentials.

The agent **may**: read the repo, run read-only Vercel and DNS commands, call the app's public endpoints,
check deployments and aliases, and tell the human exactly what to do next. When it hands off, it should
say precisely what the human must click or paste, then wait.

### 11.2 Runbook

1. **Confirm which setup is intended.** Ask: is the Google account a Workspace business account (Option A
   Internal is possible) or a personal Gmail (Option B)? Which address will connect? Use section 10.1.
2. **Hand off 10.2 to the human** (Cloud project, APIs, audience, scopes, OAuth client, redirect URI).
   Ask them to confirm they have a Client ID and secret, without sending the secret.
3. **Hand off 10.4 to the human** (Vercel variables). Then check the names exist without reading values:
   ```bash
   npx vercel env ls
   ```
   Required names for Production: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`,
   `TOKEN_ENCRYPTION_KEY`, `CRON_SECRET`, `DATABASE_URL`.
4. **Make sure the newest code is live.**
   ```bash
   npx vercel ls --format json     # newest deployment should be READY
   npx vercel alias ls             # which deployment obsys-silk points to
   ```
   If the alias points at an older deployment than the newest READY one, run
   `npx vercel alias set <newest-ready-url> obsys-silk.vercel.app`. Never redeploy an old commit from
   the dashboard — it moves production backwards. If Vercel is slow to build a push,
   `npx vercel deploy --prod --non-interactive` deploys the current working tree directly.
5. **Verify the OAuth client without seeing secrets.** The login redirect exposes only public values:
   ```bash
   curl -sI $APP/api/oauth/google | grep -i '^location'
   ```
   Decode the `Location` URL and check that `client_id` is the new client's ID, `redirect_uri` equals
   `$APP/api/oauth/google/callback`, and `scope` contains `gmail.compose`, `gmail.readonly` and
   `spreadsheets`. If the redirect goes to `/connect?error=...` the env vars are not visible to the running
   deployment — redeploy and re-check.
6. **Hand off 10.5 to the human**: open `$APP/connect`, click Connect Gmail, choose the business account,
   approve. Wait for them to say it's done.
7. **Verify the connection.**
   ```bash
   curl -s $APP/api/leads
   ```
   Expect `"connected":true` with no `"gmailDisconnected":true` and no `"error"`. If the dashboard shows the
   red Reconnect banner, the token was rejected — see 10.7.
8. **Verify the pipeline** with the manual trigger (needs no secret):
   ```bash
   curl -s -X POST $APP/api/pipeline/run-now
   ```
   `leadsProcessed` should be a number and `errors` should not mention Gmail or Sheets access.
9. **Check the sending domain** with the command in 10.8 and report SPF, DKIM and DMARC status.
10. **Follow-up test (with the human).** After they add a test lead, send its first email from Gmail and
    save the follow-up templates, ask them to click Follow-up 1 and confirm the draft sits inside the
    same thread.

### 11.3 Stop and ask the human when

- Google shows `access_denied`, "app is blocked" or `redirect_uri_mismatch` — report the exact message and
  point to the matching row in 10.7.
- `npx vercel env ls` is missing a required name.
- Any step would require entering a secret, signing in to Google or accepting terms.
- The production alias points at a build older than the latest commit and moving it is not authorized.
