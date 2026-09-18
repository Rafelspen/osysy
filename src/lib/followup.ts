import { OAuth2Client } from "google-auth-library";
import { LeadRow, updateLeadRow } from "./sheets";
import { createDraft, getDraft, getThreadMessages } from "./gmail";
import { getActiveTemplate, renderTemplate, type TemplateName } from "./templates";
import { leadRecipients } from "./pipeline";
import { errorMessage } from "./error";

export type FollowUpStep = 1 | 2 | 3;

export type FollowUpResult = { ok: boolean; status: number; message: string; threaded?: boolean };

const STEP_LABEL: Record<FollowUpStep, string> = { 1: "Follow-up 1", 2: "Follow-up 2", 3: "Final follow-up" };

function fail(status: number, message: string): FollowUpResult {
  return { ok: false, status, message };
}

function isScopeError(err: any): boolean {
  return (err?.code === 403 || err?.response?.status === 403) && /insufficient|scope|permission/i.test(String(err?.message));
}

// Drafts follow-up `step` as a reply in the lead's existing Gmail thread.
// Refuses unless the thread proves the previous email was actually sent, and
// unless nobody has replied (or bounced) yet. Never sends anything.
export async function draftFollowUp(
  auth: OAuth2Client,
  sheetId: string,
  lead: LeadRow,
  step: FollowUpStep
): Promise<FollowUpResult> {
  const label = STEP_LABEL[step];
  const draftKey = `followup${step}DraftId` as const;

  if (lead.stage.trim().toUpperCase() !== "DRAFTED") {
    return fail(409, "The first email hasn't been drafted yet — wait until this lead reaches DRAFTED.");
  }
  if (!lead.officialEmail.trim()) return fail(409, "This lead has no TO address.");

  const template = await getActiveTemplate(`follow_up_${step}` as TemplateName);
  if (!template) return fail(400, `Save the "${label}" template on the Templates page first.`);

  // Find the thread: stored at draft time, else recovered from the first draft if it still exists.
  let threadId = lead.threadId.trim();
  if (!threadId && lead.gmailDraftId.trim()) {
    const draft = await getDraft(auth, lead.gmailDraftId.trim());
    threadId = draft?.threadId ?? "";
  }
  if (!threadId) {
    return fail(
      409,
      "Can't find this lead's Gmail thread — its first email was drafted before follow-ups existed and has already been sent."
    );
  }

  let messages;
  try {
    messages = await getThreadMessages(auth, threadId);
  } catch (err) {
    if (isScopeError(err)) {
      return fail(403, "Gmail needs the new read permission for follow-ups — click Reconnect Gmail on the Connect page, then try again.");
    }
    return fail(500, `Couldn't read the Gmail thread: ${errorMessage(err)}`);
  }
  if (!messages) return fail(409, "The Gmail thread no longer exists (was the email deleted?).");

  const sent = messages.filter((m) => m.labelIds.includes("SENT") && !m.labelIds.includes("DRAFT"));
  const incoming = messages.filter((m) => !m.labelIds.includes("SENT") && !m.labelIds.includes("DRAFT"));

  if (sent.length < step) {
    return fail(
      409,
      step === 1
        ? "The first email hasn't been sent yet — send it from Gmail first, then draft the follow-up."
        : `Send the previous email in this thread first (${sent.length} of ${step} sent so far).`
    );
  }
  if (incoming.length > 0) {
    return fail(409, "The recipient already replied or the email bounced — no follow-up drafted. Check the thread in Gmail.");
  }

  const existingId = lead[draftKey].trim();
  if (existingId) {
    if (await getDraft(auth, existingId)) return fail(409, `${label} is already drafted — open it in Gmail.`);
    if (sent.length >= step + 1) return fail(409, `${label} was already sent.`);
    // The draft was deleted without being sent, so it's fine to draft it again.
  }

  const last = sent[sent.length - 1];
  if (!last.messageId) return fail(500, "The last sent email has no Message-ID header, so it can't be threaded.");
  const baseSubject = (sent[0].subject || "").replace(/^\s*((re|fwd?|aw)\s*:\s*)+/i, "").trim();
  if (!baseSubject) return fail(500, "Couldn't read the original subject from the thread.");

  const { to, cc } = leadRecipients(lead);
  const companyName = lead.companyName.trim() || lead.websiteUrl;
  const greetingName = lead.greetingName.trim() || companyName;
  const { bodyHtml } = renderTemplate(template, companyName, greetingName);

  const created = await createDraft(auth, {
    to,
    cc,
    subject: `Re: ${baseSubject}`,
    bodyHtml,
    threadId,
    inReplyTo: last.messageId,
    references: last.references ? `${last.references} ${last.messageId}` : last.messageId,
  });

  const updates: Partial<Omit<LeadRow, "rowNumber">> = { [draftKey]: created.id };
  if (!lead.threadId.trim()) updates.threadId = threadId;
  await updateLeadRow(auth, sheetId, lead.rowNumber, updates);

  const threaded = created.threadId === threadId;
  return {
    ok: true,
    status: 200,
    threaded,
    message: threaded
      ? `${label} drafted in the same Gmail thread.`
      : `${label} drafted, but Gmail did not attach it to the thread — check it in Gmail.`,
  };
}
