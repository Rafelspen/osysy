import { google } from "googleapis";
import { query } from "./db";
import { encrypt, decrypt } from "./crypto";

export class GmailDisconnectedError extends Error {
  constructor() {
    super("Gmail connection expired or was revoked — reconnect Gmail on /connect");
    this.name = "GmailDisconnectedError";
  }
}

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.compose",
  // Read-only, used solely to read headers/labels of the one thread each lead's
  // outreach lives in, so follow-ups can be threaded (compose can't read threads).
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/spreadsheets",
];

export function createOAuthClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("Google OAuth env vars are not fully configured");
  }
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

export function getAuthUrl(): string {
  const client = createOAuthClient();
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // ensures a refresh_token is returned even on re-auth
    scope: GOOGLE_SCOPES,
  });
}

type AccountRow = {
  google_refresh_token: string | null;
  google_access_token: string | null;
  google_token_expiry: string | null;
  gmail_connected: boolean;
  sheet_url: string | null;
  sheet_id: string | null;
  sheet_connected: boolean;
};

export async function getAccountRow(): Promise<AccountRow | null> {
  const rows = await query<AccountRow>(
    "SELECT google_refresh_token, google_access_token, google_token_expiry, gmail_connected, sheet_url, sheet_id, sheet_connected FROM account_connection WHERE id = 1"
  );
  return rows[0] ?? null;
}

// Removes this app's access to the connected Google account and forgets the
// stored tokens, so a different account can be connected. The Sheet link is kept.
export async function disconnectGmail(): Promise<{ revoked: boolean }> {
  const account = await getAccountRow();
  let revoked = false;
  if (account?.google_refresh_token) {
    try {
      await createOAuthClient().revokeToken(decrypt(account.google_refresh_token));
      revoked = true;
    } catch {
      // Already revoked/expired, or Google unreachable — still clear locally.
    }
  }
  await query(
    `UPDATE account_connection SET
       google_refresh_token = NULL,
       google_access_token = NULL,
       google_token_expiry = NULL,
       gmail_connected = FALSE,
       updated_at = now()
     WHERE id = 1`
  );
  return { revoked };
}

export async function handleOAuthCallback(code: string): Promise<void> {
  const client = createOAuthClient();
  const { tokens } = await client.getToken(code);

  if (!tokens.refresh_token && !tokens.access_token) {
    throw new Error("Google did not return any tokens");
  }

  const encryptedRefresh = tokens.refresh_token ? encrypt(tokens.refresh_token) : undefined;

  await query(
    `UPDATE account_connection SET
       google_refresh_token = COALESCE($1, google_refresh_token),
       google_access_token = $2,
       google_token_expiry = $3,
       gmail_connected = TRUE,
       updated_at = now()
     WHERE id = 1`,
    [
      encryptedRefresh ?? null,
      tokens.access_token ?? null,
      tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
    ]
  );
}

// Returns an OAuth2 client with valid (refreshed if needed) credentials, and
// persists any refreshed access token back to the DB.
export async function getAuthorizedClient() {
  const account = await getAccountRow();
  if (!account || !account.google_refresh_token) {
    throw new Error("Gmail is not connected");
  }

  const client = createOAuthClient();
  const refreshToken = decrypt(account.google_refresh_token);
  client.setCredentials({
    refresh_token: refreshToken,
    access_token: account.google_access_token ?? undefined,
    expiry_date: account.google_token_expiry ? new Date(account.google_token_expiry).getTime() : undefined,
  });

  const expiry = account.google_token_expiry ? new Date(account.google_token_expiry).getTime() : 0;
  const needsRefresh = !account.google_access_token || expiry < Date.now() + 60_000;

  if (needsRefresh) {
    let credentials;
    try {
      ({ credentials } = await client.refreshAccessToken());
    } catch (err: any) {
      // Only a definitive "token is dead" answer flips the flag — a network
      // blip or Google outage must never mark a healthy connection as lost.
      if (err?.response?.data?.error === "invalid_grant" || String(err?.message).includes("invalid_grant")) {
        await query(`UPDATE account_connection SET gmail_connected = FALSE, google_access_token = NULL, updated_at = now() WHERE id = 1`);
        throw new GmailDisconnectedError();
      }
      throw err;
    }
    client.setCredentials(credentials);
    await query(
      `UPDATE account_connection SET google_access_token = $1, google_token_expiry = $2, updated_at = now() WHERE id = 1`,
      [credentials.access_token ?? null, credentials.expiry_date ? new Date(credentials.expiry_date).toISOString() : null]
    );
  }

  return client;
}
