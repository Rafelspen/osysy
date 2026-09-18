import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";

export type DraftFields = {
  to: string;
  cc?: string;
  subject: string;
  bodyHtml: string; // template body, e.g. "Dear team,<br><br>...<br><br>Best,<br>..."
  // Set only for follow-ups. Gmail attaches a draft to an existing thread only
  // when threadId is given, the subject matches, and In-Reply-To/References
  // carry the Message-ID of the message being replied to.
  threadId?: string;
  inReplyTo?: string;
  references?: string;
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
    fields.inReplyTo ? `In-Reply-To: ${fields.inReplyTo}` : null,
    fields.references ? `References: ${fields.references}` : null,
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

export async function createDraft(
  auth: OAuth2Client,
  fields: DraftFields
): Promise<{ id: string; threadId: string }> {
  const api = gmailClient(auth);
  const res = await api.users.drafts.create({
    userId: "me",
    requestBody: { message: { raw: buildRawMessage(fields), threadId: fields.threadId } },
  });
  if (!res.data.id) throw new Error("Gmail did not return a draft id");
  return { id: res.data.id, threadId: res.data.message?.threadId ?? "" };
}

export async function updateDraft(
  auth: OAuth2Client,
  draftId: string,
  fields: DraftFields
): Promise<{ threadId: string }> {
  const api = gmailClient(auth);
  const res = await api.users.drafts.update({
    userId: "me",
    id: draftId,
    requestBody: { message: { raw: buildRawMessage(fields), threadId: fields.threadId } },
  });
  return { threadId: res.data.message?.threadId ?? "" };
}

export type ThreadMessage = {
  id: string;
  labelIds: string[];
  messageId: string; // RFC 2822 Message-ID header, with angle brackets
  references: string;
  subject: string;
};

// Reads only headers and labels of one thread (format=metadata) — never
// message bodies. Needs the gmail.readonly scope; gmail.compose alone cannot
// read threads. Returns null if the thread no longer exists.
export async function getThreadMessages(auth: OAuth2Client, threadId: string): Promise<ThreadMessage[] | null> {
  const api = gmailClient(auth);
  try {
    const res = await api.users.threads.get({
      userId: "me",
      id: threadId,
      format: "metadata",
      metadataHeaders: ["Message-ID", "References", "Subject"],
    });
    return (res.data.messages ?? []).map((m) => {
      const headers = m.payload?.headers ?? [];
      const get = (name: string) => headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
      return {
        id: m.id ?? "",
        labelIds: m.labelIds ?? [],
        messageId: get("Message-ID"),
        references: get("References"),
        subject: get("Subject"),
      };
    });
  } catch (err: any) {
    if (err?.code === 404 || err?.response?.status === 404) return null;
    throw err;
  }
}

export type FetchedDraft = {
  id: string;
  threadId: string;
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
      threadId: message.threadId ?? "",
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
