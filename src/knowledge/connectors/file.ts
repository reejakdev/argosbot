/**
 * Local file knowledge connector.
 *
 * Supports:
 *   Text:  .txt .md .ts .js .json .csv .yaml .yml .toml
 *   Word:  .docx (via mammoth — extracts clean text)
 *   Excel: .xlsx .xls (via xlsx/SheetJS — all sheets as CSV)
 *
 * Paths resolved relative to ~/.argos/ or as absolute.
 * Path traversal outside HOME is blocked.
 */

import { readFileSync, existsSync, statSync } from 'fs';
import path from 'path';
import os from 'os';
import { createLogger } from '../../logger.js';
import type { KnowledgeDocument } from '../types.js';

const log = createLogger('knowledge:file');

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB (docx/xlsx can be larger)

const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.ts',
  '.js',
  '.json',
  '.csv',
  '.yaml',
  '.yml',
  '.toml',
  '.env',
  '.sh',
  '.py',
]);

export async function fetchFile(opts: {
  filePath: string;
  name: string;
  refreshDays?: number;
}): Promise<KnowledgeDocument | null> {
  const resolved = resolvePath(opts.filePath);
  if (!resolved) {
    log.warn(`File path blocked (outside HOME or traversal attempt): ${opts.filePath}`);
    return null;
  }

  if (!existsSync(resolved)) {
    log.warn(`File not found: ${resolved}`);
    return null;
  }

  const stat = statSync(resolved);
  if (!stat.isFile()) {
    log.warn(`Not a file: ${resolved}`);
    return null;
  }

  if (stat.size > MAX_FILE_SIZE) {
    log.warn(`File too large (${(stat.size / 1024 / 1024).toFixed(1)} MB): ${resolved}`);
    return null;
  }

  const ext = path.extname(resolved).toLowerCase();

  try {
    let text: string;

    if (ext === '.docx') {
      text = await extractDocx(resolved);
    } else if (ext === '.xlsx' || ext === '.xls') {
      text = extractExcel(resolved);
    } else if (TEXT_EXTENSIONS.has(ext) || ext === '') {
      text = readFileSync(resolved, 'utf8');
    } else {
      // Try as text anyway
      text = readFileSync(resolved, 'utf8');
    }

    const header = `[${opts.name}]\nSource: ${resolved}\n\n`;
    const isLarge = text.length > 8000;

    log.info(`Indexed file: ${resolved} (${text.length} chars)`);

    return {
      key: `file:${resolved}`,
      name: opts.name,
      content:
        header +
        (isLarge ? text.slice(0, 2000) + '\n\n[…full content indexed in vector store]' : text),
      tags: ['context', 'file', ext.slice(1) || 'txt'],
      fullText: isLarge ? header + text : undefined,
    };
  } catch (e) {
    log.warn(`File read failed (${resolved}): ${e}`);
    return null;
  }
}

async function extractDocx(filePath: string): Promise<string> {
  const mammoth = (await import('mammoth')).default;
  const result = await mammoth.extractRawText({ path: filePath });
  return result.value;
}

function extractExcel(filePath: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const XLSX = require('xlsx') as typeof import('xlsx');
  const workbook = XLSX.readFile(filePath);
  const parts: string[] = [];
  for (const sheetName of workbook.SheetNames) {
    const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName]);
    parts.push(`=== Sheet: ${sheetName} ===\n${csv}`);
  }
  return parts.join('\n\n');
}

function resolvePath(filePath: string): string | null {
  const home = os.homedir();
  const dataDir = process.env.DATA_DIR ?? path.join(home, '.argos');

  // Expand ~ shorthand
  const expanded = filePath.startsWith('~/') ? path.join(home, filePath.slice(2)) : filePath;

  // Resolve relative paths from data dir
  const resolved = path.isAbsolute(expanded)
    ? path.normalize(expanded)
    : path.normalize(path.join(dataDir, expanded));

  // Block anything outside HOME
  if (!resolved.startsWith(home + path.sep) && resolved !== home) {
    return null;
  }

  return resolved;
}
