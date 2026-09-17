import { OAuth2Client } from "google-auth-library";
import { LeadRow } from "./sheets";
import { discoverEmails, isEmailUsableForDomain, isPlausibleEmail } from "./email-discovery";
import { getActiveTemplate, renderTemplate } from "./templates";
import { checkSpamSignals } from "./spam-check";
import { createDraft, updateDraft, getDraft } from "./gmail";
import { errorMessage } from "./error";

export type StageResult = {
  rowNumber: number;
  updates: Partial<Omit<LeadRow, "rowNumber">>;
};

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

  // Prefer an email whose domain matches the website — no warning needed.
  const domainMatch = candidates.find((e) => isEmailUsableForDomain(e, lead.websiteUrl));
  if (domainMatch) {
    const updates: StageResult["updates"] = { stage: "VERIFIED", lastError: "" };
    if (domainMatch !== lead.officialEmail) updates.officialEmail = domainMatch;
    return { rowNumber: lead.rowNumber, updates };
  }

  // Nothing matched the website's domain, but a plausibly real address was
  // still found on the site (not a placeholder/malformed string) — let it
  // through as a warning rather than getting stuck, since every draft is
  // reviewed by hand before it's ever sent. Covers legitimate cases like a
  // rebrand using a different domain for email than the website.
  const looseMatch = candidates.find((e) => isPlausibleEmail(e));
  if (looseMatch) {
    const updates: StageResult["updates"] = {
      stage: "VERIFIED",
      lastError: `domain mismatch warning: ${looseMatch} does not match website domain — verify before sending`,
    };
    if (looseMatch !== lead.officialEmail) updates.officialEmail = looseMatch;
    return { rowNumber: lead.rowNumber, updates };
  }

  return {
    rowNumber: lead.rowNumber,
    updates: { lastError: "no usable TO address (invalid format or placeholder)" },
  };
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
  const cc = lead.secondaryEmail.trim() && lead.secondaryEmail.trim() !== lead.officialEmail.trim() ? lead.secondaryEmail.trim() : undefined;
  const fields = { to: lead.officialEmail.trim(), cc, subject, bodyHtml };

  try {
    if (lead.gmailDraftId.trim()) {
      await updateDraft(auth, lead.gmailDraftId.trim(), fields);
      return { rowNumber: lead.rowNumber, updates: { stage: "QA", lastError: withCarriedWarning(lead, "") } };
    }
    const draftId = await createDraft(auth, fields);
    return {
      rowNumber: lead.rowNumber,
      updates: { gmailDraftId: draftId, stage: "QA", lastError: withCarriedWarning(lead, "") },
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

  const toMatches = draft.to.toLowerCase().includes(lead.officialEmail.trim().toLowerCase());
  const subjectMatches = draft.subject.trim() === subject.trim();

  if (toMatches && subjectMatches) {
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
