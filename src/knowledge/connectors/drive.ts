/**
 * Google Drive knowledge connector.
 *
 * Auth: Service Account JSON key (downloaded from GCP Console).
 * The service account email must be shared on each folder/file you want to fetch.
 *
 * Supported formats:
 *   Google Docs   → exported as text/plain
 *   Google Sheets → exported as text/csv
 *   text/*        → downloaded directly
 *   PDFs + others → skipped (binary, no text extraction)
 *
 * Config:
 *   config.googleDrive.serviceAccountKeyPath — path to the JSON key file
 *
 * Source config:
 *   folderId  — fetch all readable files inside the folder
 *   fileIds   — fetch specific files by ID (can be combined with folderId)
 */

import { readFileSync } from 'fs';
import { createLogger } from '../../logger.js';
import type { Config } from '../../config/schema.js';
import type { KnowledgeDocument } from '../types.js';

const log = createLogger('knowledge:drive');

const EXPORTABLE: Record<string, string> = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
};

interface DriveSource {
  name: string;
  folderId?: string;
  fileIds?: string[];
  refreshDays: number;
}

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

// ─── JWT / access token ───────────────────────────────────────────────────────

async function getAccessToken(keyPath: string): Promise<string> {
  const raw = readFileSync(keyPath, 'utf-8');
  const key = JSON.parse(raw) as ServiceAccountKey;
  const { GoogleAuth } = await import('googleapis-common');

  const auth = new GoogleAuth({
    keyFile: keyPath,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
  });

  const client = await auth.getClient();
  const token = await client.getAccessToken();
  if (!token.token) throw new Error('Failed to obtain Drive access token');
  return token.token;
  void key; // key read for validation above
}

// ─── Drive API helpers ────────────────────────────────────────────────────────

async function driveGet(path: string, token: string, binary = false): Promise<string | null> {
  const res = await fetch(`https://www.googleapis.com/drive/v3/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20_000),
  });

  if (!res.ok) {
    log.warn(`Drive API error ${res.status} on ${path}`);
    return null;
  }

  return binary ? null : res.text();
}

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
}

async function listFolder(folderId: string, token: string): Promise<DriveFile[]> {
  const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
  const fields = encodeURIComponent('files(id,name,mimeType)');
  const raw = await driveGet(`files?q=${q}&fields=${fields}&pageSize=100`, token);
  if (!raw) return [];

  const json = JSON.parse(raw) as { files?: DriveFile[] };
  return json.files ?? [];
}

async function getFileMeta(fileId: string, token: string): Promise<DriveFile | null> {
  const raw = await driveGet(`files/${fileId}?fields=id,name,mimeType`, token);
  if (!raw) return null;
  return JSON.parse(raw) as DriveFile;
}

async function exportFile(file: DriveFile, token: string): Promise<string | null> {
  const exportMime = EXPORTABLE[file.mimeType];

  if (exportMime) {
    // Google Workspace format — use export endpoint
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${file.id}/export?mimeType=${encodeURIComponent(exportMime)}`,
      { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) },
    );
    if (!res.ok) {
      log.warn(`Export failed for "${file.name}": HTTP ${res.status}`);
      return null;
    }
    return res.text();
  }

  if (file.mimeType.startsWith('text/')) {
    // Plain text file — download directly
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      log.warn(`Download failed for "${file.name}": HTTP ${res.status}`);
      return null;
    }
    return res.text();
  }

  // Binary (PDF, images…) — skip
  log.debug(`Skipping unsupported format: "${file.name}" (${file.mimeType})`);
  return null;
}

// ─── Main export ──────────────────────────────────────────────────────────────

export async function fetchGoogleDrive(
  source: DriveSource,
  config: Config,
): Promise<KnowledgeDocument | null> {
  if (!config.googleDrive?.serviceAccountKeyPath) {
    log.warn(
      'google-drive source configured but googleDrive.serviceAccountKeyPath is missing — skipping',
    );
    return null;
  }

  log.info(`Fetching Google Drive: ${source.name}`);

  let token: string;
  try {
    token = await getAccessToken(config.googleDrive.serviceAccountKeyPath);
  } catch (e) {
    log.warn(`Drive auth failed: ${e}`);
    return null;
  }

  // Collect files from folder + explicit fileIds
  const files: DriveFile[] = [];

  if (source.folderId) {
    const folderFiles = await listFolder(source.folderId, token);
    files.push(...folderFiles);
    log.debug(`Drive folder ${source.folderId}: ${folderFiles.length} file(s)`);
  }

  for (const fileId of source.fileIds ?? []) {
    if (files.some((f) => f.id === fileId)) continue; // already in folder listing
    const meta = await getFileMeta(fileId, token);
    if (meta) files.push(meta);
  }

  if (files.length === 0) {
    log.warn(`No files found for Drive source "${source.name}"`);
    return null;
  }

  // Export each file and concatenate
  const parts: string[] = [`# ${source.name} (Google Drive)\n`];
  let exported = 0;

  for (const file of files) {
    const content = await exportFile(file, token);
    if (!content?.trim()) continue;
    parts.push(`## ${file.name}\n\n${content.trim()}`);
    exported++;
  }

  if (exported === 0) {
    log.warn(
      `Drive source "${source.name}": no exportable content (${files.length} file(s) all unsupported format)`,
    );
    return null;
  }

  let combined = parts.join('\n\n');
  const MAX_BYTES = 500 * 1024;
  if (combined.length > MAX_BYTES) {
    log.warn(
      `[knowledge:drive] document ${source.name} truncated from ${Math.round(combined.length / 1024)} KB to 500 KB`,
    );
    combined = combined.slice(0, MAX_BYTES);
  }
  log.info(
    `[knowledge:drive] fetched ${exported} docs, ~${Math.round(combined.length / 1024)} KB`,
  );
  combined = combined.slice(0, 20_000); // cap at 20k chars for content field
  log.info(`Drive "${source.name}": exported ${exported}/${files.length} file(s)`);

  return {
    key: `gdrive:${source.folderId ?? source.fileIds?.[0] ?? source.name}`,
    name: source.name,
    content: combined,
    tags: ['context', 'google-drive', source.name.toLowerCase().replace(/\s+/g, '_')],
  };
}
