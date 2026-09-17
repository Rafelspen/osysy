import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";

export type DraftFields = {
  to: string;
  cc?: string;
  subject: string;
  bodyHtml: string; // template body, e.g. "Dear team,<br><br>...<br><br>Best,<br>..."
};

function htmlToPlainText(html: string): string {
  return html
    .replace(/<br\s*\/?>\s*<br\s*\/?>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function encodeHeaderValue(value: string): string {
  // Only MIME-encode when non-ASCII is present; otherwise leave as-is.
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function buildRawMessage(fields: DraftFields): string {
  const boundary = `----=_Part_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const plainText = htmlToPlainText(fields.bodyHtml);
  // The HTML alternative intentionally mirrors the plain text almost
  // exactly (§5a): no fonts, colors, images, or tracking pixels.
  const htmlBody = fields.bodyHtml;

  const headers = [
    `To: ${fields.to}`,
    fields.cc ? `Cc: ${fields.cc}` : null,
    `Subject: ${encodeHeaderValue(fields.subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ].filter(Boolean);

  const message = [
    ...headers,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 7bit",
    "",
    plainText,
    "",
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: 7bit",
    "",
    htmlBody,
    "",
    `--${boundary}--`,
  ].join("\r\n");

  return Buffer.from(message)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function gmailClient(auth: OAuth2Client) {
  return google.gmail({ version: "v1", auth });
}

export async function createDraft(auth: OAuth2Client, fields: DraftFields): Promise<string> {
  const api = gmailClient(auth);
  const res = await api.users.drafts.create({
    userId: "me",
    requestBody: { message: { raw: buildRawMessage(fields) } },
  });
  if (!res.data.id) throw new Error("Gmail did not return a draft id");
  return res.data.id;
}

export async function updateDraft(auth: OAuth2Client, draftId: string, fields: DraftFields): Promise<void> {
  const api = gmailClient(auth);
  await api.users.drafts.update({
    userId: "me",
    id: draftId,
    requestBody: { message: { raw: buildRawMessage(fields) } },
  });
}

export type FetchedDraft = {
  id: string;
  to: string;
  cc: string;
  subject: string;
  bodyPlainText: string;
};

function decodeBase64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

export async function getDraft(auth: OAuth2Client, draftId: string): Promise<FetchedDraft | null> {
  const api = gmailClient(auth);
  try {
    const res = await api.users.drafts.get({ userId: "me", id: draftId, format: "full" });
    const message = res.data.message;
    if (!message) return null;

    const headerList = message.payload?.headers ?? [];
    const getHeader = (name: string) =>
      headerList.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";

    let bodyPlainText = "";
    const parts = message.payload?.parts ?? [];
    const plainPart = parts.find((p) => p.mimeType === "text/plain");
    if (plainPart?.body?.data) {
      bodyPlainText = decodeBase64Url(plainPart.body.data);
    } else if (message.payload?.body?.data) {
      bodyPlainText = decodeBase64Url(message.payload.body.data);
    }

    return {
      id: draftId,
      to: getHeader("To"),
      cc: getHeader("Cc"),
      subject: getHeader("Subject"),
      bodyPlainText,
    };
  } catch (err: any) {
    if (err?.code === 404 || err?.response?.status === 404) return null;
    throw err;
  }
}
