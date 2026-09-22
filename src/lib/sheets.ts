import { google, sheets_v4 } from "googleapis";
import { OAuth2Client } from "google-auth-library";

export const PIPELINE_STAGES = ["SOURCED", "ENRICHED", "VERIFIED", "OUTREACH", "QA", "DRAFTED"] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export type LeadRow = {
  rowNumber: number; // 1-indexed sheet row, header is row 1
  source: string;
  companyName: string;
  websiteUrl: string;
  officialEmail: string;
  secondaryEmail: string;
  anotherEmail: string;
  greetingName: string;
  stage: string;
  gmailDraftId: string;
  lastError: string;
  mxStatus: string; // "" (not yet checked) | "X/Y valid"
  threadId: string; // Gmail thread of the first outreach draft
  followup1DraftId: string;
  followup2DraftId: string;
  followup3DraftId: string;
  emailVerified: string; // JSON of per-address results from ZeroBounce/Hunter/Clay — see verification-store.ts
  abVariant: string; // "" (not yet drafted) | "A" | "B" — see templates.ts; set once, at the first draft, then reused
};

const HEADER = [
  "Source",
  "Company Name",
  "Website URL",
  "Official Email/TO",
  "Secondary Email/CC",
  "Another Email",
  "Email Name for greeting",
  "Pipeline Stage",
  "gmail_draft_id",
  "last_error",
  "mx_status",
  "gmail_thread_id",
  "followup_1_draft_id",
  "followup_2_draft_id",
  "followup_3_draft_id",
  "email_verified",
  "ab_variant",
];

// Ranges omit a sheet name on purpose: the Sheets Values API defaults to the
// first visible tab when none is given, so this works regardless of what the
// user names their tab.
const DATA_RANGE = "A2:Q";
const FULL_RANGE = "A1:Q";

export function extractSheetId(url: string): string {
  const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!match) {
    throw new Error("Could not extract a spreadsheet ID from that URL");
  }
  return match[1];
}

function client(auth: OAuth2Client): sheets_v4.Sheets {
  return google.sheets({ version: "v4", auth });
}

// Verifies read+write access and that the header row matches the expected
// contract. Writes the header if the sheet is empty. Throws on failure.
export async function validateSheetAccess(auth: OAuth2Client, sheetId: string): Promise<void> {
  const api = client(auth);
  const res = await api.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: FULL_RANGE,
  });

  const rows = res.data.values ?? [];
  if (rows.length === 0) {
    await api.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: FULL_RANGE,
      valueInputOption: "RAW",
      requestBody: { values: [HEADER] },
    });
    return;
  }

  // Confirm write access without mutating existing content.
  await api.spreadsheets.values.get({ spreadsheetId: sheetId, range: "A1" });
}

// Sheets connected before the newer columns existed have no labels for L:Q. Fill in
// only the labels that are empty — nothing that already has text is touched.
export async function ensureHeaders(auth: OAuth2Client, sheetId: string): Promise<void> {
  const api = client(auth);
  const res = await api.spreadsheets.values.get({ spreadsheetId: sheetId, range: "L1:Q1" });
  const existing = res.data.values?.[0] ?? [];
  const columns = ["L", "M", "N", "O", "P", "Q"];
  const data = columns
    .map((col, i) => ({ range: `${col}1`, values: [[HEADER[11 + i]]], missing: !String(existing[i] ?? "").trim() }))
    .filter((d) => d.missing)
    .map(({ range, values }) => ({ range, values }));
  if (data.length === 0) return;
  await api.spreadsheets.values.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: { valueInputOption: "RAW", data },
  });
}

// Reads one cell fresh (used right before writing a merged value back, so two quick
// edits to the same row don't overwrite each other).
export async function readCell(auth: OAuth2Client, sheetId: string, a1: string): Promise<string> {
  const res = await client(auth).spreadsheets.values.get({ spreadsheetId: sheetId, range: a1 });
  return String(res.data.values?.[0]?.[0] ?? "");
}

export async function readLeadRows(auth: OAuth2Client, sheetId: string): Promise<LeadRow[]> {
  const api = client(auth);
  const res = await api.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: DATA_RANGE,
  });
  const rows = res.data.values ?? [];

  return rows
    .map((row, idx) => ({
      rowNumber: idx + 2,
      source: row[0] ?? "",
      companyName: row[1] ?? "",
      websiteUrl: row[2] ?? "",
      officialEmail: row[3] ?? "",
      secondaryEmail: row[4] ?? "",
      anotherEmail: row[5] ?? "",
      greetingName: row[6] ?? "",
      stage: row[7] ?? "",
      gmailDraftId: row[8] ?? "",
      lastError: row[9] ?? "",
      mxStatus: row[10] ?? "",
      threadId: row[11] ?? "",
      followup1DraftId: row[12] ?? "",
      followup2DraftId: row[13] ?? "",
      followup3DraftId: row[14] ?? "",
      emailVerified: row[15] ?? "",
      abVariant: row[16] ?? "",
    }))
    .filter((r) => r.source || r.websiteUrl || r.companyName); // skip fully blank trailing rows
}

export async function appendLeadRow(
  auth: OAuth2Client,
  sheetId: string,
  data: { source: string; websiteUrl: string }
): Promise<void> {
  const api = client(auth);
  await api.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: DATA_RANGE,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [[data.source, "", data.websiteUrl, "", "", "", "", "SOURCED", "", "", "", "", "", "", "", "", ""]],
    },
  });
}

// Partial update of a single lead row. Only provided fields are written.
export async function updateLeadRow(
  auth: OAuth2Client,
  sheetId: string,
  rowNumber: number,
  updates: Partial<Omit<LeadRow, "rowNumber">>
): Promise<void> {
  const api = client(auth);
  const columnMap: Record<string, string> = {
    source: "A",
    companyName: "B",
    websiteUrl: "C",
    officialEmail: "D",
    secondaryEmail: "E",
    anotherEmail: "F",
    greetingName: "G",
    stage: "H",
    gmailDraftId: "I",
    lastError: "J",
    mxStatus: "K",
    threadId: "L",
    followup1DraftId: "M",
    followup2DraftId: "N",
    followup3DraftId: "O",
    emailVerified: "P",
    abVariant: "Q",
  };

  const data: sheets_v4.Schema$ValueRange[] = Object.entries(updates)
    .filter(([, v]) => v !== undefined)
    .map(([key, value]) => ({
      range: `${columnMap[key]}${rowNumber}`,
      values: [[value ?? ""]],
    }));

  if (data.length === 0) return;

  await api.spreadsheets.values.batchUpdate({
    spreadsheetId: sheetId,
    requestBody: {
      valueInputOption: "RAW",
      data,
    },
  });
}
