# Outbound Campaign Control Room

Single-user control room for an automated cold-outreach pipeline. Leads live in a Google
Sheet; this app reads/advances them through pipeline stages and drafts personalized emails
in Gmail for manual review and send. Nothing is ever auto-sent.

> **Setting this up on new accounts, or having an AI agent do it?** Go straight to [section 12](#12-fresh-install-on-new-accounts-person--browser-agent). Google-specific steps are in section 10, agent rules in section 11.

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
| `CRON_SECRET` | Any random string. Sent as the `x-cron-secret` header (or as a Bearer token by Vercel Cron) to `/api/pipeline/tick` |

## 2. Google Cloud Console setup

> This is the short version. The complete, current walkthrough (including the Internal setup for a Workspace
> account) is **section 10.2**.

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
4. The tables are created **automatically on every build** (`npm run build` runs the migration first, and simply
   skips it if no database is connected yet). To run it by hand instead (reads `DATABASE_URL`, falling back to `POSTGRES_URL_NON_POOLING` /
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
3. The database tables are created automatically by each build (§3 step 4), so there is nothing to run by hand.
   Check `/api/health` on the deployed address to confirm `database.tables_ready` is true.
4. **Automatic runs — pick a scheduler.** Something has to call the pipeline regularly. The endpoint
   `/api/pipeline/tick` accepts the secret as `x-cron-secret: <CRON_SECRET>` (POST) **or** as
   `Authorization: Bearer <CRON_SECRET>` (GET, which is what Vercel Cron sends).

   | Scheduler | Cost | How reliable | Setup |
   |---|---|---|---|
   | **Vercel Pro cron** | Vercel Pro plan | Best — runs every minute, on time | Add `"crons": [{"path": "/api/pipeline/tick", "schedule": "* * * * *"}]` to `vercel.json`. Vercel sends the Bearer header itself because a `CRON_SECRET` variable exists. **Only on Pro** — a per-minute cron makes a Hobby deployment fail. |
   | **External scheduler** (for example cron-job.org) | Free tier | Good — runs when it says | Create a job that calls `POST <your address>/api/pipeline/tick` every 1–5 minutes with the header `x-cron-secret: <CRON_SECRET>`. The person types the secret. |
   | **GitHub Actions** (`.github/workflows/pipeline-tick.yml`) | Free on a public repo | **Poor for timing** — see below | Add repo secrets `APP_URL` and `CRON_SECRET`. |

   **Measured on the first install:** the GitHub schedule is set to every minute, but GitHub started it only
   about every 2–6 hours (31 runs in four days). Every run succeeded; they were just rare. GitHub throttles
   high-frequency schedules and gives no timing guarantee. Keep it as a free backup if you like, but for timely
   drafts use Vercel Pro cron or an external scheduler. **No scheduler is needed at low volume:** the dashboard's
   **Run pipeline now** button does one step for every waiting lead, and **Run until done** repeats it
   automatically until every lead is `DRAFTED` (it stops on its own if leads get stuck, and has a Stop button).
   And `/api/health` shows `cron_looks_alive` so you can see whether automatic runs are really happening.
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

Columns A–P, header row required, exact order:

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
| P | email_verified | Dashboard verification buttons (section 13) — JSON of per-address results from ZeroBounce / Hunter / Clay |

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

Below, `https://obsys-silk.vercel.app` is the production address of the first install. On a new install use your own stable address everywhere it appears (see section 12). If you later add a custom domain, use
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
difference is the Audience choice in Step 3 of 10.2 (plus the test-user step, Step 5).

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
4. You return to `/connect` with "Gmail connected", and the page shows **Connected as `<the address>`**.
   To switch accounts later, click **Disconnect Gmail** on that page (it also revokes this app's access in
   the Google account), then **Connect Gmail** again and choose the other account. The Sheet link is kept,
   so the new account must be able to open that Sheet.
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

## 12. Fresh install on new accounts (person + browser agent)

Use this section to set the whole project up from zero on **new business accounts** (GitHub, Vercel,
Google Workspace), with a person working alongside an AI agent that drives the browser (for example
Claude in Chrome). It is written so an agent can follow it top to bottom. Sections 10 and 11 hold the
details for the Google side; this section is the order of operations.

Throughout, **`$APP`** means the stable address you choose in Phase 2 (for example
`https://your-name.vercel.app`, no trailing slash). Replace `obsys-silk.vercel.app` in sections 10 and 11
with it — that address belonged to the first install.

### 12.1 Who does what

An agent can navigate, read screens, and fill in non-secret settings. Anything that is a **secret, a
credential, a legal acceptance, or an identity check is done by the person.** The agent stops and says what
is needed.

| Person only | Agent can do |
|---|---|
| Create accounts and sign in (GitHub, Vercel, Google); 2-factor prompts; CAPTCHAs | Open the right pages, read what is on screen, tell the person the next click |
| Authorize GitHub for Vercel; accept Neon/marketplace terms and any terms of service | Create the Vercel project settings, add the domain, enable the Google APIs, set the audience, add the three scopes, add the redirect URI |
| **Type or paste every secret**: `GOOGLE_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY`, `CRON_SECRET` (and the Client ID) into Vercel and GitHub fields | Check that variables **exist** (names only) and that the app sees them, using `$APP/api/health` |
| Approve Google's consent screen when connecting Gmail | Compare `$APP/api/health` and the OAuth redirect against the expected values, and report anything red |
| Any payment or plan upgrade | Run the verification commands in each phase |

### 12.2 Decisions before starting

| Decision | Recommendation |
|---|---|
| **Repo visibility** | **Public.** The repo contains no secrets (they live in Vercel and GitHub secrets). A public repo also gets unlimited free GitHub Actions minutes, whereas a private one has a small monthly allowance that a once-a-minute schedule would use up in about a day and a half. If it must be private, do not rely on GitHub Actions for the schedule — use Vercel Pro cron or an external scheduler (section 5, step 4). |
| **Vercel plan** | Hobby is fine for setting up and testing, but Vercel's Hobby plan is meant for personal, non-commercial use — check their current terms and use **Pro** for a business account. |
| **Google audience** | **Internal**, with the Cloud project under your Workspace organization (section 10.1). No weekly reconnect, no verification. |
| **Address** | Choose the stable address in Phase 2 **before** creating the Google OAuth client, because the redirect address is registered there. |

### 12.3 Every variable, and where it lives

| Name | Where it goes | How you get it |
|---|---|---|
| `DATABASE_URL` and the other `POSTGRES_*` / `PG*` names | Vercel | Added **automatically** by the Neon integration in Phase 2. **Never add `DATABASE_URL` by hand** — a hand-made one blocks the integration from connecting. |
| `GOOGLE_CLIENT_ID` | Vercel | Google Cloud, Phase 4 (section 10.2, Step 7) |
| `GOOGLE_CLIENT_SECRET` | Vercel | Google Cloud, same step. Shown once — copy it then. |
| `GOOGLE_REDIRECT_URI` | Vercel | `$APP/api/oauth/google/callback` — identical to the redirect URI registered in Google |
| `TOKEN_ENCRYPTION_KEY` | Vercel | Generate below (32 random bytes, base64) |
| `CRON_SECRET` | Vercel **and** the GitHub repo secret of the same name | Generate below. Must be **identical** in both places. |
| `APP_URL` | GitHub repo secret only | `$APP` |

Generate the two random values on any computer with Node.js (nothing is stored or sent anywhere):

```bash
npm run gen:secrets
```

No Node? Any of these produce the same kind of value:

```bash
openssl rand -base64 32     # TOKEN_ENCRYPTION_KEY
openssl rand -hex 24        # CRON_SECRET
```
```powershell
# PowerShell, TOKEN_ENCRYPTION_KEY
$b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b); [Convert]::ToBase64String($b)
```

Rules that prevent the problems seen during the first setup:

- Save Vercel variables as **normal** variables. Do **not** tick "Sensitive": those values did not reach the
  running app.
- After adding or changing any Vercel variable, **redeploy**, then re-check `$APP/api/health`.
- Do not paste secrets into chat, documents or code.

### 12.4 Runbook

Check `$APP/api/health` at the end of each phase (see 12.6). It returns only true/false values and counts.

**Phase 0 — Accounts (person).** Have ready: the business Google account (a Workspace admin, for the
Internal setup), a new GitHub account and a new Vercel account (signing up to Vercel with GitHub is easiest).

**Phase 1 — Put the code in the new GitHub account (person; agent can navigate).**
1. On the new GitHub account open `https://github.com/new/import`, paste the URL of the existing repository,
   name the new repository (for example `obsys`) and set it **Public** (see 12.2). GitHub copies it.
   Alternative: create an empty repository and push a local copy to it.
2. Confirm the new repository shows the files and that **Actions** is available (if GitHub shows
   "I understand my workflows, go ahead and enable them", the person clicks it).

**Phase 2 — Vercel: project, stable address, database, secrets.**
1. *(person)* Vercel → **Add New → Project → Import Git Repository**; authorize GitHub when asked and pick
   the new repository. Click **Deploy**. The first build succeeds even without a database — the setup pages
   will simply say what is missing.
   *Known pitfall:* an imported project can come up with **Framework Preset = Other**. Then Vercel treats the
   repo as a plain project and the build fails with a message about a `functions` pattern that "doesn't match
   any Serverless Functions". `vercel.json` in this repo already contains `{"framework": "nextjs"}`, which
   overrides the preset, so no dashboard change is needed — but if you ever see that error, check that file.
2. *(agent)* **Stable address:** every Vercel project already has a short production address of the form
   `<project-name>.vercel.app` (see **Settings → Domains**). It is public and always follows the newest
   production build, so nothing goes stale. Use it as `$APP`. If you want a different name, **Add** another
   `.vercel.app` name there and assign it to **Production**.
   Do **not** use the longer addresses `<project>-<team>.vercel.app`, `<project>-git-main-<team>.vercel.app`
   or the per-deployment ones: on a new account these sit behind a Vercel login page, so Google and the
   scheduler can't reach them.
   *Verify:* `curl -s -o /dev/null -w "%{http_code}\n" $APP/api/health` must print `200`. If it redirects to a
   Vercel login page, you are on one of the protected addresses (or open **Settings → Deployment Protection**
   and make production reachable without login).
3. *(person accepts terms; agent navigates)* **Database:** Project → **Storage → Create Database → Neon →
   Free plan**, region the same as the functions (for example `iad1`), authentication **off**, connect it to
   **all environments**. The person accepts Neon's terms. This adds `DATABASE_URL` and the other database
   variables by itself.
4. *(agent)* **Redeploy** (Deployments → the newest one → Redeploy). Each build applies the database tables
   automatically. *Verify:* `$APP/api/health` shows `database.reachable: true` and
   `database.tables_ready: true`.
5. *(person)* Add `TOKEN_ENCRYPTION_KEY` and `CRON_SECRET` (12.3) under **Settings → Environment Variables**
   for Production (normal variables). The agent then checks the **names** exist.

**Phase 3 — The scheduler (person types secrets; agent navigates).** Choose from section 5, step 4:
1. **Recommended:** Vercel Pro cron, or an external scheduler such as cron-job.org set to call
   `POST $APP/api/pipeline/tick` every 1–5 minutes with the header `x-cron-secret: <CRON_SECRET>`
   (the person types the secret into the scheduler).
2. **Optional free backup:** GitHub Actions. Repository → **Settings → Secrets and variables → Actions → New
   repository secret**: `APP_URL` = `$APP` (no trailing slash) and `CRON_SECRET` = the same value as in
   Vercel. Then **Actions → Pipeline Tick → Run workflow**; it must finish **green** (red usually means a secret
   is missing or differs from Vercel's). Expect its automatic schedule to fire only every few hours.
3. *Verify:* once Gmail and the Sheet are connected (Phase 6), `$APP/api/health` shows
   `cron_looks_alive: true` when the scheduler is working. `false` means runs are not arriving often enough.

**Phase 4 — Google Cloud (agent navigates; person copies the secret).** Follow section 10.2 (Steps 1–7) using
`$APP/api/oauth/google/callback` as the redirect URI, audience **Internal** (section 10.1). The person copies
the Client ID and Client secret at the end of Step 7.

**Phase 5 — Give Vercel the Google values (person pastes; agent checks).**
1. The person adds `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `GOOGLE_REDIRECT_URI` (12.3) in Vercel,
   then the agent redeploys.
2. *Verify:* `$APP/api/health` → every `env.*` value is `true`, including
   `google_redirect_uri_matches_this_address`, and `ready_to_connect_gmail: true`.
   Also `curl -sI $APP/api/oauth/google | grep -i '^location'` should show the new `client_id`, the same
   `redirect_uri`, and all three scopes.

**Phase 6 — Connect (person approves).**
1. Open `$APP/connect` → **Connect Gmail** → choose the business account → approve the three permissions.
   The page then shows **Connected as `<address>`**.
2. Create a blank Google Sheet in the business account (`sheets.new`), copy its URL, paste it under
   **Google Sheet** → **Save & Validate**. The header row (columns A–O) is written automatically.
3. *Verify:* `$APP/api/health` → `fully_connected: true`.

**Phase 7 — Templates and a test lead (person; agent can navigate).**
1. `$APP/templates`: edit and **Save** all four templates (first outreach and the three follow-ups). Replace
   the sample signature name in the defaults. Consider adding one plain opt-out line
   (section 7 / deliverability).
2. `$APP/add-lead`: add a test lead, then use **Run pipeline now** on the dashboard until it reaches
   `DRAFTED`. Open Gmail → Drafts, send the first email to yourself, then use **Follow-up 1** and confirm the
   draft sits in the same thread.

**Phase 8 — Final check.** `$APP/api/health` → `ok: true`, `fully_connected: true` and `cron_looks_alive: true`. Also check the sending domain's records (section 10.8).

### 12.5 Prompt to give the browser agent

Copy this, fill in the two placeholders, and open these tabs first: the new **Vercel** project, the new
**GitHub** repository, **Google Cloud Console** (signed in as the business account), and the app's `$APP`.

```text
You are helping set up the "obsys" project on new accounts. Read the repository README, section 12
("Fresh install on new accounts") and follow it phase by phase, using sections 10 and 11 for the Google
details. My stable address is: <PASTE $APP HERE>. My business Google account is: <PASTE ADDRESS HERE>.

Rules:
- Do the navigation and the non-secret settings yourself.
- Never type, paste or store any secret, key or password — GOOGLE_CLIENT_SECRET, TOKEN_ENCRYPTION_KEY,
  CRON_SECRET, database URLs. When one is needed, stop, say exactly which field, and wait for me.
- Do not sign in for me, accept terms, approve Google's consent screen, or pay for anything. Stop and ask.
- After each phase, open <$APP>/api/health and report every value that is false or unexpected before moving on.
- Do not click Redeploy on an old deployment; only redeploy the newest one.
- If something doesn't match this README, stop and describe what you see instead of guessing.
```

### 12.6 Reading `/api/health`

`GET $APP/api/health` returns JSON with no secret values:

| Field | Meaning |
|---|---|
| `ok` / `ready_to_connect_gmail` | Every required variable is set and the database tables exist |
| `env.*` | Each variable present. `token_encryption_key_valid` = 32 bytes. `google_redirect_uri_shape_ok` = https and the right path. `google_redirect_uri_matches_this_address` = it matches the address you opened |
| `database.reachable` / `tables_ready` | The database answers and the tables were created by the build |
| `connection.gmail_connected` / `sheet_connected` | Gmail and the Sheet are linked |
| `fully_connected` | Both are linked and the setup is complete |
| `templates` | Whether the first-outreach template and how many follow-up templates are saved |
| `last_pipeline_run` | Minutes since the last run and its status |
| `cron_looks_alive` | `true` if a run happened in the last 15 minutes; `null` until Gmail and the Sheet are connected; `false` means the GitHub schedule is not firing |
| `version` | The commit this deployment was built from |

## 13. Email verification (ZeroBounce, Hunter, Clay)

**Two different questions.** The **MX/Domain** column only proves an address's *domain* can receive mail. It cannot
tell a real mailbox from a made-up one at the same domain. The **Email Verified** column answers the second
question — "does this exact mailbox exist?" — by asking a verification service. That has to be an outside
service, because a hosting platform like Vercel cannot make the mail-server connection needed to check it.

**Nothing is checked automatically.** The pipeline never spends verification credits. You choose which addresses
to check, and with which service, from the dashboard — so the free monthly credits go where you want them.

### 13.1 Using it

1. **Hover** the badge in a lead's **Email Verified** column (or click it). A popup lists that lead's addresses.
2. **Click an address** to select it. Selected addresses appear in the **Selected emails** panel on the left of
   the dashboard (it also remembers your selection if you reload the page).
3. In the same row, click **ZeroBounce**, **Hunter** or **Clay**. That service checks the lead's selected addresses.
4. The result shows immediately: on the badge (for example `2/3 verified`, green / amber / red), in the popup, and
   as small chips (`ZB`, `H`, `Clay`) next to each address in the panel — hover a chip for the service's exact
   wording and the time.

The buttons are greyed out with an explanation when: no address is selected, the service isn't set up, or another
check is running.

### 13.2 The three services

| Service | How it runs | Free allowance | Setup |
|---|---|---|---|
| **ZeroBounce** | Automatic (API) | about 100 checks a month (check current terms) | Variable `ZEROBOUNCE_API_KEY` |
| **Hunter** | Automatic (API) | about 50 checks a month (check current terms) | Variable `HUNTER_API_KEY` |
| **Clay** | **Manual** — see below | Clay's own credits | Nothing to configure |

**Why Clay is manual.** Clay has no "verify this address and answer me" API. It can only receive data through a
table webhook and send results out through an HTTP action, and Clay's pricing lists **webhooks and HTTP API as
unavailable on the Free and Launch plans** (they start at the Growth plan). So on a free Clay plan the app cannot
call it. Instead, the **Clay** button copies the selected addresses and opens Clay in a new tab; you run Clay's
own email verification there, then choose the result under **Clay result** for that address in the left panel
(`deliverable`, `risky`, `undeliverable` or `unknown`). It is stored and shown exactly like the other services.
If you upgrade to a Clay plan with webhooks later, an automatic connection can be added the same way as the
other two.

### 13.3 What the results mean

Each service's own answer is turned into one of four results, and the original wording is kept in the chip's tooltip.

| Result | ZeroBounce says | Hunter says |
|---|---|---|
| **Deliverable** | `valid` | `valid` |
| **Undeliverable** | `invalid`, `spamtrap` | `invalid` |
| **Risky** | `catch-all`, `abuse`, `do_not_mail` | `accept_all`, `disposable` |
| **Unknown** | `unknown` | `unknown`, `webmail`, or an unclear mail-server answer |

When several services checked the same address, the **safest answer wins**: undeliverable, then risky, then
unknown, then deliverable. The badge shows how many of the lead's addresses are deliverable
(`2/3 verified`); it is **red** if any address is undeliverable, **green** if all are deliverable, **amber**
otherwise, and grey **Not checked** before any check.

**What it changes.** Only one thing: an address that is **undeliverable** is left out of the **CC** line when a
draft is created or updated and when a follow-up is drafted. Drafts that already exist are not touched. Nothing
else is automatic — a risky or unknown address is never removed for you.

### 13.4 Credits

- Each ZeroBounce or Hunter check uses about **one credit per address** (ZeroBounce does not charge for
  `unknown` results).
- An address a service has already checked is **never checked again by that service** — the saved result is used and
  no credit is spent. To check it again, use **reset results** under that address in the left panel (or
  reset it in the Sheet).
- At most 3 addresses are checked per click, and only addresses that belong to that lead.
- If a service runs out of credits or rejects the key, you get a clear message and nothing is saved for the
  failed addresses; successful ones are still saved.

### 13.5 Setting it up

1. Create a free account with ZeroBounce and/or Hunter and copy the API key from its settings page. (The person
   does this and types the key; an agent must not — section 11.1.)
2. In Vercel → **Settings → Environment Variables**, add for **Production**, as **normal** (not Sensitive) variables:
   `ZEROBOUNCE_API_KEY` and/or `HUNTER_API_KEY`.
3. **Redeploy.** Open `$APP/api/health`: under `email_verifiers`, the service should show `configured: true`.
   (The health page reports only whether a key exists, never the key.)
4. **Test with an address you know is fake** on a real domain, for example `nobody-1234@yourcompany.com`: select
   it, click the service button, and confirm the result is `Undeliverable`.

### 13.6 How results are stored

Results live in the Sheet, in column **P** (`email_verified`), as JSON keyed by lower-case address, for example
`{"a@x.com":{"hunter":{"v":"deliverable","raw":"valid","t":"2026-09-22T10:00:00.000Z"}}}`. The app manages this
cell — edit it by hand only to delete results (an unreadable cell is treated as "nothing checked", never as an
error). Because the results are in the Sheet, every browser sees the same badge, and the Sheet remains the source
of truth.

### 13.7 Safety notes

- These buttons **spend your credits**, and — like the rest of this app — the dashboard has no login. The check
  endpoint therefore refuses cross-site requests, refuses any address that isn't on that lead, limits each request
  to 3 addresses, and skips addresses a service already checked, so the most an outsider could spend is one credit
  per distinct address already in your Sheet. Add a login before the app is public.
- API keys stay on the server and are never put in messages, logs or the health page.

### 13.8 Adding another API service (for developers)

`src/lib/email-verifier.ts` holds one small function per service that calls the service and maps its answer to
`deliverable` / `undeliverable` / `risky` / `unknown` (see `verifyZeroBounce` and `verifyHunter`), plus the
service's entry in `META` (label, environment variable name). Add the service's id to `ProviderId` and
`PROVIDER_IDS` in `src/lib/verification-store.ts`, add its short chip label in
`src/app/dashboard/verification.tsx`, and extend `isApiProvider`. Every failure must be thrown as a `VerifierError`
with a message that never contains the key.
