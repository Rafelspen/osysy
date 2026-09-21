import { OAuth2Client } from "google-auth-library";
import { LeadRow } from "./sheets";
import { discoverEmails, isEmailUsableForDomain, isPlausibleEmail, summarizeMxStatus } from "./email-discovery";
import { getActiveTemplate, renderTemplate } from "./templates";
import { checkSpamSignals } from "./spam-check";
import { createDraft, updateDraft, getDraft } from "./gmail";
import { errorMessage } from "./error";
import { normalizeEmail, overallVerdict, parseStore, undeliverableSet } from "./verification-store";

export type StageResult = {
  rowNumber: number;
  updates: Partial<Omit<LeadRow, "rowNumber">>;
};

// TO is column D; CC is columns E and F, deduped, skipping blanks and the TO.
// Addresses that ZeroBounce/Hunter/Clay results (dashboard) mark undeliverable are
// never CC'd. If the TO itself is undeliverable, it is replaced by the first
// address from E/F that isn't (one that checked out as deliverable is preferred
// over one that was never checked or came back risky/unknown). If there is no
// usable replacement, TO stays as it is. The Sheet is never changed.
export function leadRecipients(lead: LeadRow): { to: string; cc: string | undefined } {
  const store = parseStore(lead.emailVerified);
  const undeliverable = undeliverableSet(lead.emailVerified);
  const isBad = (e: string) => undeliverable.has(e.toLowerCase());

  let to = lead.officialEmail.trim();
  const others = [lead.secondaryEmail.trim(), lead.anotherEmail.trim()].filter(
    (e, i, all) =>
      e && e.toLowerCase() !== to.toLowerCase() && all.findIndex((x) => x.toLowerCase() === e.toLowerCase()) === i
  );

  if (to && isBad(to)) {
    const usable = others.filter((e) => !isBad(e));
    const replacement = usable.find((e) => overallVerdict(store[normalizeEmail(e)]) === "deliverable") ?? usable[0];
    if (replacement) to = replacement;
  }

  const ccList = others.filter((e) => e.toLowerCase() !== to.toLowerCase() && !isBad(e));
  return { to, cc: ccList.length ? ccList.join(", ") : undefined };
}

const DOMAIN_WARNING_PREFIX = "domain mismatch warning:";

// Once a domain-mismatch warning is raised at ENRICHED, keep it visible in
// last_error through every later stage (even on success) instead of letting
// each stage's own status overwrite it — it's a standing "double check this
// address" flag for the lead's lifetime, not a transient error.
function withCarriedWarning(lead: LeadRow, newMessage: string): string {
  const carried = lead.lastError.trim().startsWith(DOMAIN_WARNING_PREFIX) ? lead.lastError.trim() : "";
  if (newMessage && carried) return `${newMessage}; ${carried}`;
  return newMessage || carried;
}

function companyNameOrFallback(lead: LeadRow, discovered: string | null): string {
  if (lead.companyName.trim()) return lead.companyName.trim();
  if (discovered) return discovered;
  try {
    return new URL(/^https?:\/\//i.test(lead.websiteUrl) ? lead.websiteUrl : `https://${lead.websiteUrl}`).hostname;
  } catch {
    return lead.websiteUrl;
  }
}

async function advanceSourced(lead: LeadRow): Promise<StageResult> {
  if (!lead.websiteUrl.trim()) {
    return { rowNumber: lead.rowNumber, updates: { lastError: "no website URL provided" } };
  }

  let discovery;
  try {
    discovery = await discoverEmails(lead.websiteUrl);
  } catch (err: any) {
    return { rowNumber: lead.rowNumber, updates: { lastError: `email discovery failed: ${errorMessage(err)}` } };
  }

  const companyName = companyNameOrFallback(lead, discovery.companyName);
  const greetingName = lead.greetingName.trim() || companyName;

  if (discovery.emails.length === 0) {
    return {
      rowNumber: lead.rowNumber,
      updates: {
        companyName,
        greetingName,
        stage: "ENRICHED",
        lastError: "no verifiable email found",
      },
    };
  }

  return {
    rowNumber: lead.rowNumber,
    updates: {
      companyName,
      greetingName,
      officialEmail: discovery.emails[0] ?? "",
      secondaryEmail: discovery.emails[1] ?? "",
      anotherEmail: discovery.emails[2] ?? "",
      stage: "ENRICHED",
      lastError: "",
    },
  };
}

async function advanceEnriched(lead: LeadRow): Promise<StageResult> {
  const candidates = [lead.officialEmail, lead.secondaryEmail, lead.anotherEmail].filter((e) => e.trim());

  // Prefer an email whose domain matches the website; otherwise fall back to
  // any plausibly real address found on the site (see the domain-mismatch
  // warning below — it's a judgment call a human can still verify).
  const domainMatch = candidates.find((e) => isEmailUsableForDomain(e, lead.websiteUrl));
  const looseMatch = domainMatch ? undefined : candidates.find((e) => isPlausibleEmail(e));
  const chosen = domainMatch ?? looseMatch;

  if (!chosen) {
    return {
      rowNumber: lead.rowNumber,
      updates: { lastError: "no usable TO address (invalid format or placeholder)" },
    };
  }

  // Check every candidate address found (not just the chosen TO), deduped by
  // domain — gives visibility into all 3 slots (e.g. "2/3 valid") even
  // though only `chosen` drives what's actually drafted.
  const mxSummary = await summarizeMxStatus(candidates);
  const chosenMxStatus = mxSummary.byEmail[chosen] ?? "unknown";
  const mxStatus = `${mxSummary.validCount}/${mxSummary.total} valid`;

  if (chosenMxStatus === "no_mx") {
    // Unlike a domain mismatch, this is a hard technical fact, not a
    // judgment call — the domain cannot receive mail at all. Stay at
    // ENRICHED rather than draft something guaranteed to bounce.
    const updates: StageResult["updates"] = {
      lastError: `${chosen} domain has no mail servers configured (no MX/A records) — likely undeliverable`,
      mxStatus,
    };
    if (chosen !== lead.officialEmail) updates.officialEmail = chosen;
    return { rowNumber: lead.rowNumber, updates };
  }

  const updates: StageResult["updates"] = {
    stage: "VERIFIED",
    lastError: domainMatch ? "" : `domain mismatch warning: ${chosen} does not match website domain — verify before sending`,
    mxStatus,
  };
  if (chosen !== lead.officialEmail) updates.officialEmail = chosen;
  return { rowNumber: lead.rowNumber, updates };
}

async function advanceVerified(lead: LeadRow): Promise<StageResult> {
  const template = await getActiveTemplate();
  if (!template) {
    return { rowNumber: lead.rowNumber, updates: { lastError: withCarriedWarning(lead, "no active template configured") } };
  }

  const companyName = lead.companyName.trim() || lead.websiteUrl;
  const greetingName = lead.greetingName.trim() || companyName;
  const { subject, bodyHtml } = renderTemplate(template, companyName, greetingName);
  const warnings = checkSpamSignals(subject, bodyHtml);

  return {
    rowNumber: lead.rowNumber,
    updates: {
      stage: "OUTREACH",
      lastError: withCarriedWarning(lead, warnings.length ? `deliverability warning: ${warnings.join("; ")}` : ""),
    },
  };
}

async function advanceOutreach(auth: OAuth2Client, lead: LeadRow): Promise<StageResult> {
  const template = await getActiveTemplate();
  if (!template) {
    return { rowNumber: lead.rowNumber, updates: { lastError: withCarriedWarning(lead, "no active template configured") } };
  }
  if (!lead.officialEmail.trim()) {
    return {
      rowNumber: lead.rowNumber,
      updates: { stage: "ENRICHED", lastError: withCarriedWarning(lead, "TO address missing, reverted for re-verification") },
    };
  }

  const companyName = lead.companyName.trim() || lead.websiteUrl;
  const greetingName = lead.greetingName.trim() || companyName;
  const { subject, bodyHtml } = renderTemplate(template, companyName, greetingName);
  const { to, cc } = leadRecipients(lead);
  const fields = { to, cc, subject, bodyHtml };

  try {
    if (lead.gmailDraftId.trim()) {
      const { threadId } = await updateDraft(auth, lead.gmailDraftId.trim(), fields);
      const updates: StageResult["updates"] = { stage: "QA", lastError: withCarriedWarning(lead, "") };
      if (threadId && threadId !== lead.threadId) updates.threadId = threadId;
      return { rowNumber: lead.rowNumber, updates };
    }
    const { id: draftId, threadId } = await createDraft(auth, fields);
    return {
      rowNumber: lead.rowNumber,
      updates: { gmailDraftId: draftId, threadId, stage: "QA", lastError: withCarriedWarning(lead, "") },
    };
  } catch (err: any) {
    return {
      rowNumber: lead.rowNumber,
      updates: { lastError: withCarriedWarning(lead, `Gmail draft error: ${errorMessage(err)}`) },
    };
  }
}

async function advanceQA(auth: OAuth2Client, lead: LeadRow): Promise<StageResult> {
  if (!lead.gmailDraftId.trim()) {
    return {
      rowNumber: lead.rowNumber,
      updates: { stage: "OUTREACH", lastError: withCarriedWarning(lead, "missing draft id, will recreate") },
    };
  }

  const template = await getActiveTemplate();
  if (!template) {
    return { rowNumber: lead.rowNumber, updates: { lastError: withCarriedWarning(lead, "no active template configured") } };
  }

  const companyName = lead.companyName.trim() || lead.websiteUrl;
  const greetingName = lead.greetingName.trim() || companyName;
  const { subject, bodyHtml } = renderTemplate(template, companyName, greetingName);

  let draft;
  try {
    draft = await getDraft(auth, lead.gmailDraftId.trim());
  } catch (err: any) {
    return {
      rowNumber: lead.rowNumber,
      updates: { lastError: withCarriedWarning(lead, `Gmail lookup failed: ${errorMessage(err)}`) },
    };
  }

  if (!draft) {
    return {
      rowNumber: lead.rowNumber,
      updates: { stage: "OUTREACH", gmailDraftId: "", lastError: withCarriedWarning(lead, "draft not found in Gmail, will retry") },
    };
  }

  // Same recipients the draft was built from (leadRecipients swaps an undeliverable
  // TO for a usable one and drops undeliverable CCs), so a correct draft never fails QA.
  const recipients = leadRecipients(lead);
  const toMatches = draft.to.toLowerCase().includes(recipients.to.toLowerCase());
  const subjectMatches = draft.subject.trim() === subject.trim();
  const expectedCc = (recipients.cc ?? "").split(",").map((e) => e.trim()).filter(Boolean);
  const ccMatches = expectedCc.every((e) => draft.cc.toLowerCase().includes(e.toLowerCase()));

  if (toMatches && subjectMatches && ccMatches) {
    return { rowNumber: lead.rowNumber, updates: { stage: "DRAFTED", lastError: withCarriedWarning(lead, "") } };
  }

  return {
    rowNumber: lead.rowNumber,
    updates: { stage: "OUTREACH", lastError: withCarriedWarning(lead, "draft mismatch (To/Subject), will retry") },
  };
}

export async function advanceLead(auth: OAuth2Client, lead: LeadRow): Promise<StageResult> {
  switch (lead.stage.trim().toUpperCase()) {
    case "SOURCED":
      return advanceSourced(lead);
    case "ENRICHED":
      return advanceEnriched(lead);
    case "VERIFIED":
      return advanceVerified(lead);
    case "OUTREACH":
      return advanceOutreach(auth, lead);
    case "QA":
      return advanceQA(auth, lead);
    default:
      // "" (new row not yet stamped) or DRAFTED/unknown — treat blank as SOURCED, else no-op.
      if (!lead.stage.trim()) return advanceSourced(lead);
      return { rowNumber: lead.rowNumber, updates: {} };
  }
}
