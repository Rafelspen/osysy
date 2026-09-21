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

### 10.2 Google Cloud Console — from start to finish

Google renames and rearranges console screens from time to time. If a label below differs slightly,
look for the closest match; the order of the steps stays the same.

**Before you start**

- Open a **private/incognito window** and sign in **only** with the business account that will own the
  project (for example `rafael@sesinf.net`). Being signed in to several Google accounts at once is the most
  common cause of "wrong project" and "access denied" surprises.
- The first time you open the console it asks you to accept the Terms of Service. Accept, choose your
  country, and continue.
- Have these ready: the production address `https://obsys-silk.vercel.app` (you are keeping the
  `vercel.app` address, so nothing needs to be bought or registered) and the email address that will connect.

**Step 1 — Create the project**

1. Go to [console.cloud.google.com](https://console.cloud.google.com).
2. Click the project picker at the top (it may say "Select a project"), then **New project**.
3. **Project name**: `obsys`.
4. **Location / Organization**: this is the important field.
   - **Option A (Internal):** it must show your organization, for example `sesinf.net`. Google creates
     that organization automatically the first time a Workspace admin signs in to the console. If the field
     only offers "No organization", Internal is not possible for this account — use Option B instead.
   - **Option B (External):** any location works.
5. Click **Create**, wait a few seconds, then make sure the project picker at the top now shows `obsys`.
   Every step below must happen inside this project.

**Step 2 — Turn on the two APIs**

1. Menu (three lines, top left) → **APIs & Services → Library**.
2. Search for **Gmail API**, open it, click **Enable**.
3. Go back to the Library, search for **Google Sheets API**, open it, click **Enable**.
4. Check: **APIs & Services → Enabled APIs & services** lists both.

**Step 3 — Set up the consent screen ("Google Auth Platform")**

1. Menu → **Google Auth Platform** (or type it into the search bar at the top). If it shows a
   **Get started** button, click it and go through the four screens:
   1. **App information** — App name: `obsys`. User support email: pick your address. **Next**.
   2. **Audience** — choose **Internal** (Option A) or **External** (Option B). **Next**.
      If **Internal** is greyed out, the project is not inside your organization; go back to Step 1 and create
      it under the organization.
   3. **Contact information** — your email address (Google sends notices here). **Next**.
   4. **Finish** — tick the box agreeing to the Google API Services User Data Policy, then **Continue**
      and **Create**.
2. You now see a left-hand menu with **Overview, Branding, Audience, Clients, Data Access** (and possibly
   **Verification Center**). The next steps use those pages.

**Step 4 — Branding (optional)**

Open **Branding**. The app name and support email are already filled in. **Leave the home page, privacy
policy and terms of service links empty.** Those links are only needed for Google's verification, and
Google can only verify a domain you own — it cannot verify a `vercel.app` address. An Internal app needs no
verification, and an External test-mode app does not need it either. Do not add any "Authorized domains".

**Step 5 — Option B only: add yourself as a test user**

1. Open **Audience**.
2. Confirm **Publishing status** says **Testing**. Leave it there.
3. Under **Test users**, click **Add users**, enter the exact address you will connect
   (for example `rafael@sesinf.net`), and **Save**.

Skip this step for Option A (Internal): everyone in your organization can connect and there is no test-user list.

**Step 6 — Add the three permissions (scopes)**

1. Open **Data Access** and click **Add or remove scopes**.
2. In the panel, use **Manually add scopes** (a text box near the bottom) and paste these three, one per
   line:
   ```
   https://www.googleapis.com/auth/gmail.compose
   https://www.googleapis.com/auth/gmail.readonly
   https://www.googleapis.com/auth/spreadsheets
   ```
3. Click **Add to table**, confirm all three appear in the table, then **Update** and finally **Save**.
4. Google marks the Gmail scopes as "restricted" and the Sheets scope as "sensitive". That is expected. It
   only matters for verification (needed when publishing an External app to other people); an Internal app
   is not verified.

What each one is used for: `gmail.compose` creates and updates your drafts; `gmail.readonly` is used only
to read the headers and labels of the one thread each lead's outreach lives in, so follow-ups land in the
same thread; `spreadsheets` reads and writes your lead Sheet.

**Step 7 — Create the OAuth client (this produces the Client ID and secret)**

1. Open **Clients** and click **Create client**.
2. **Application type**: **Web application**. **Name**: `obsys web`.
3. **Authorized JavaScript origins**: leave empty.
4. **Authorized redirect URIs**: click **Add URI** and paste exactly:
   ```
   https://obsys-silk.vercel.app/api/oauth/google/callback
   ```
   It must match character for character — `https`, no trailing slash, no spaces. (For local development
   you can add a second URI, `http://localhost:3000/api/oauth/google/callback`.)
5. Click **Create**. A window shows the **Client ID** and the **Client secret**.
6. **Copy both now, or click Download JSON.** Google may not show the secret again later. If you lose it,
   open the client and add a new secret.
7. Keep the secret private. It goes only into Vercel (Step 8) — do not paste it into chat, email, a
   document, or the code.

**Step 8 — Put the credentials into Vercel**

Follow section 10.4 (the Client ID, the Client secret, and the redirect URI from Step 7, then redeploy).

**Step 9 — Checklist before connecting**

- [ ] Project `obsys` is selected and, for Option A, sits under your organization.
- [ ] Gmail API and Google Sheets API both show as enabled.
- [ ] Audience is **Internal** (Option A), or **External + Testing with your address as a test user** (Option B).
- [ ] Data Access lists all three scopes.
- [ ] The OAuth client's redirect URI is exactly `https://obsys-silk.vercel.app/api/oauth/google/callback`.
- [ ] `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_REDIRECT_URI` are set in Vercel for Production and
      the site was redeployed.

**If the address ever changes.** The redirect URI must equal the address you open the app at. If Vercel
gives you a different address later, update it in three places: the OAuth client's redirect URI (Step 7),
`GOOGLE_REDIRECT_URI` in Vercel, and redeploy. Until you do, Google shows `redirect_uri_mismatch`.

### 10.3 Workspace admin console (Workspace accounts only)

If Google shows "This app is blocked" or "Access blocked: admin policy" when you connect, your
organization restricts third-party apps:

1. [admin.google.com](https://admin.google.com) → **Security → Access and data control → API controls**.
2. **App access control → Manage Third-Party App Access → Add app → OAuth App Name Or Client ID**.
3. Paste the Client ID from Step 7 of 10.2, choose it, and set access to **Trusted**.

### 10.4 Vercel environment variables

In the Vercel project: **Settings → Environment Variables**. Set these for **Production**
(create them as normal variables — do not tick "Sensitive", which stopped them reaching the running app
during setup):

| Variable | Value |
|---|---|
| `GOOGLE_CLIENT_ID` | Client ID from Step 7 of 10.2 |
| `GOOGLE_CLIENT_SECRET` | Client secret from Step 7 of 10.2 |
| `GOOGLE_REDIRECT_URI` | `https://obsys-silk.vercel.app/api/oauth/google/callback` (same as the redirect URI in Step 7 of 10.2) |

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
| Follow-up says "Gmail needs the new read permission" | The connection predates `gmail.readonly`. Add the scope (Step 6 of 10.2) and click **Reconnect Gmail**. |
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
