// Lightweight, non-blocking deliverability checklist (spec §5a). Findings are
// logged as warnings (last_error / pipeline_runs.errors) — they never rewrite
// or block the draft.

const TRIGGER_PHRASES = ["no cost", "guaranteed", "act now", "risk free", "limited time", "click here"];

export function checkSpamSignals(subject: string, body: string): string[] {
  const warnings: string[] = [];

  if (/[A-Z]{4,}/.test(subject)) {
    warnings.push("Subject contains an ALL-CAPS word");
  }
  if (subject.includes("!")) {
    warnings.push("Subject contains an exclamation point");
  }
  if (/^\s*(re|fwd)\s*:/i.test(subject)) {
    warnings.push('Subject spoofs a reply/forward prefix ("Re:"/"Fwd:")');
  }

  const dollarMentions = body.match(/\$\s?\d/g) ?? [];
  if (dollarMentions.length > 1) {
    warnings.push("Body stacks multiple dollar-amount mentions");
  }

  const lowerBody = body.toLowerCase();
  for (const phrase of TRIGGER_PHRASES) {
    if (lowerBody.includes(phrase)) {
      warnings.push(`Body contains trigger phrase "${phrase}"`);
    }
  }

  const linkCount = (body.match(/https?:\/\//gi) ?? []).length;
  if (linkCount > 1) {
    warnings.push(`Body contains ${linkCount} links (more than one)`);
  }

  return warnings;
}
