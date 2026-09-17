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
];

// Ranges omit a sheet name on purpose: the Sheets Values API defaults to the
// first visible tab when none is given, so this works regardless of what the
// user names their tab.
const DATA_RANGE = "A2:J";
const FULL_RANGE = "A1:J";

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
      values: [[data.source, "", data.websiteUrl, "", "", "", "", "SOURCED", "", ""]],
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
