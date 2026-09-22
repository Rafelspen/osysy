// Who a draft is addressed to. Pure (no server imports) so the pipeline, the
// follow-up drafter and the dashboard's lead-details popup all use the same rule.

import { leadEmails, normalizeEmail, overallVerdict, parseStore, undeliverableSet } from "./verification-store";

export type RecipientFields = {
  officialEmail: string;
  secondaryEmail: string;
  anotherEmail: string;
  emailVerified: string;
};

// TO is column D; CC is columns E and F, deduped, skipping blanks and the TO.
// Addresses that ZeroBounce/Hunter/Clay results (dashboard) mark undeliverable are
// never CC'd. If the TO itself is undeliverable, it is replaced by the first
// address from E/F that isn't (one that checked out as deliverable is preferred
// over one that was never checked or came back risky/unknown). If there is no
// usable replacement, TO stays as it is. The Sheet is never changed.
export function leadRecipients(lead: RecipientFields): { to: string; cc: string | undefined } {
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

export type AddressRole = "to" | "cc" | "left-out";

// What each of the lead's addresses would be in a draft made right now.
export function addressRoles(lead: RecipientFields): Array<{ email: string; role: AddressRole }> {
  const { to, cc } = leadRecipients(lead);
  const ccSet = new Set((cc ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean));
  return leadEmails(lead).map((email) => {
    const key = email.trim().toLowerCase();
    const role: AddressRole = key === to.toLowerCase() ? "to" : ccSet.has(key) ? "cc" : "left-out";
    return { email, role };
  });
}

// Informational only (the pipeline's own check runs on the server): does the
// address's domain look like the lead's website?
export function emailMatchesWebsite(email: string, websiteUrl: string): boolean | null {
  const domain = email.split("@")[1]?.trim().toLowerCase().replace(/^www\./, "");
  if (!domain) return null;
  let host = "";
  try {
    const raw = websiteUrl.trim();
    host = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
  if (!host) return null;
  if (domain === host || host.endsWith(domain) || domain.endsWith(host)) return true;
  // Same exception the pipeline makes: a company on Google Workspace may list a Gmail address.
  if (domain === "gmail.com" || domain === "googlemail.com") return true;
  return false;
}

// Gmail-style addresses can't be tied to a company website.
export function isFreeMailAddress(email: string): boolean {
  const domain = email.split("@")[1]?.trim().toLowerCase();
  return domain === "gmail.com" || domain === "googlemail.com";
}
