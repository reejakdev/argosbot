/**
 * Local filesystem knowledge connector — glob-based multi-file indexing.
 *
 * Supports glob patterns and exact file paths, all relative to HOME or absolute.
 * Useful for:
 *   - Argos's own config (`~/.argos/.config.json`)
 *   - Self-description (`~/.argos/argos-self.md`)
 *   - Source code (`src/**\/*.ts`) for self-awareness
 *   - Local reference docs, runbooks, SOPs
 *
 * Security:
 *   - All paths confined to HOME directory (path traversal blocked)
 *   - Files larger than MAX_FILE_SIZE are skipped
 *   - Binary files skipped (non-text extensions unless force: true)
 *
 * Config example:
 *   {
 *     type: 'local',
 *     name: 'Argos self',
 *     paths: ['~/.argos/argos-self.md', '~/.argos/.config.json'],
 *     refreshHours: 1
 *   }
 */

import { readFileSync, existsSync, statSync, globSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createLogger } from '../../logger.js';
import type { KnowledgeDocument } from '../types.js';

const log = createLogger('knowledge:local');

const MAX_FILE_SIZE = 500_000; // 500 KB per file
const MAX_TOTAL_SIZE = 2_000_000; // 2 MB total for the whole batch
const MAX_FILES = 200;

const TEXT_EXTENSIONS = new Set([
  '.md',
  '.txt',
  '.ts',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.jsonc',
  '.yaml',
  '.yml',
  '.toml',
  '.env',
  '.sh',
  '.bash',
  '.zsh',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.sql',
  '.html',
  '.xml',
  '.csv',
  '.log',
  '.conf',
  '.ini',
  '.cfg',
]);

// ─── Public API ───────────────────────────────────────────────────────────────

export async function fetchLocal(opts: {
  paths: string[]; // glob patterns or exact paths
  name: string;
  refreshDays?: number;
}): Promise<KnowledgeDocument | null> {
  const home = os.homedir();
  const files: Array<{ resolved: string; rel: string }> = [];

  for (const pattern of opts.paths) {
    const expanded = expandTilde(pattern);

    // Resolve base for relative patterns
    const isAbsolute = path.isAbsolute(expanded);
    const base = isAbsolute ? '/' : path.join(home, '.argos');
    const absPattern = isAbsolute ? expanded : path.join(base, expanded);

    let matches: string[];
    try {
      matches = (globSync(absPattern) as string[]).filter((m) => {
        try {
          return statSync(m).isFile();
        } catch {
          return false;
        }
      });
    } catch {
      // Not a glob — try as exact path
      matches = existsSync(absPattern) ? [absPattern] : [];
    }

    for (const m of matches) {
      const resolved = path.normalize(m);
      // Security: must stay inside HOME
      if (!resolved.startsWith(home + path.sep) && resolved !== home) {
        log.warn(`Blocked path outside HOME: ${resolved}`);
        continue;
      }
      // Block secrets and dotenv files at root level (allow in subdirs is okay)
      if (path.basename(resolved) === '.env' && path.dirname(resolved) === home) {
        log.warn(`Skipping root .env file`);
        continue;
      }
      if (!files.find((f) => f.resolved === resolved)) {
        files.push({ resolved, rel: resolved.replace(home + path.sep, '~/') });
      }
    }
  }

  if (!files.length) {
    log.debug(`No files matched for "${opts.name}"`);
    return null;
  }

  if (files.length > MAX_FILES) {
    log.warn(`Too many files (${files.length}) — capping at ${MAX_FILES}`);
    files.splice(MAX_FILES);
  }

  const parts: string[] = [];
  let totalSize = 0;

  for (const { resolved, rel } of files) {
    try {
      const stat = statSync(resolved);
      if (!stat.isFile()) continue;
      if (stat.size > MAX_FILE_SIZE) {
        log.debug(`Skipping large file (${(stat.size / 1024).toFixed(0)} KB): ${rel}`);
        continue;
      }

      const ext = path.extname(resolved).toLowerCase();
      if (ext && !TEXT_EXTENSIONS.has(ext)) {
        log.debug(`Skipping binary file: ${rel}`);
        continue;
      }

      const text = readFileSync(resolved, 'utf8');
      if (totalSize + text.length > MAX_TOTAL_SIZE) {
        log.debug(`Total size limit reached — stopping at ${rel}`);
        break;
      }

      totalSize += text.length;
      parts.push(`### ${rel}\n\`\`\`${ext.slice(1) || 'text'}\n${text}\n\`\`\``);
    } catch (e) {
      log.warn(`Failed to read ${rel}: ${e}`);
    }
  }

  if (!parts.length) return null;

  const content =
    `[${opts.name}]\nFiles: ${files.length} | Total: ${(totalSize / 1024).toFixed(0)} KB\n\n` +
    parts.join('\n\n');
  const isLarge = content.length > 8000;

  log.info(
    `Local connector "${opts.name}": ${files.map((f) => f.rel).join(', ')} (${(totalSize / 1024).toFixed(0)} KB)`,
  );

  return {
    key: `local:${opts.name.toLowerCase().replace(/\s+/g, '_')}`,
    name: opts.name,
    content: isLarge
      ? content.slice(0, 4000) + '\n\n[…full content indexed in vector store]'
      : content,
    tags: ['local', 'self', opts.name.toLowerCase().replace(/\s+/g, '_')],
    fullText: isLarge ? content : undefined,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function expandTilde(p: string): string {
  return p.startsWith('~/')
    ? path.join(os.homedir(), p.slice(2))
    : p.startsWith('~')
      ? os.homedir()
      : p;
}
