/**
 * Knowledge source management commands for the Telegram bot.
 *
 * /sources           — list configured sources
 * /add_source <url>  — add a URL/raw GitHub source and index it immediately
 * /add_source github <owner/repo> [path1 path2 …]
 * /remove_source <index>
 * /refresh_sources   — force re-index all sources now
 */

import path from 'path';
import os   from 'os';
import { readFileSync, writeFileSync } from 'fs';
import { createLogger } from '../../logger.js';
import type { Config } from '../../config/schema.js';
import type { KnowledgeSource } from '../../config/schema.js';

const log = createLogger('knowledge-cmd');

function getCfgPath(): string {
  const dir = process.env.DATA_DIR ?? path.join(os.homedir(), '.argos');
  return path.join(dir.startsWith('~') ? path.join(os.homedir(), dir.slice(1)) : dir, 'config.json');
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(getCfgPath(), 'utf8'));
}

function saveConfig(data: Record<string, unknown>): void {
  writeFileSync(getCfgPath(), JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
}

// ─── /sources ─────────────────────────────────────────────────────────────────

export async function cmdSources(
  config: Config,
  notify: (text: string) => Promise<void>,
): Promise<void> {
  const sources = config.knowledge.sources;
  if (!sources.length) {
    await notify('📚 No knowledge sources configured.\n\nAdd one:\n`/add_source <url>`\n`/add_source github owner/repo`');
    return;
  }

  const lines = sources.map((s, i) => {
    switch (s.type) {
      case 'url':    return `${i + 1}. 🔗 *${s.name}*\n   ${s.url}`;
      case 'github': return `${i + 1}. 🐙 *${s.name ?? `${s.owner}/${s.repo}`}*\n   github:${s.owner}/${s.repo}`;
      case 'notion': return `${i + 1}. 📓 *${s.name}*\n   notion:${s.pageId}`;
      default:       return `${i + 1}. ${s.type}: ${s.name}`;
    }
  });

  await notify(`📚 *Knowledge sources (${sources.length})*\n\n${lines.join('\n\n')}`);
}

// ─── /add_source ──────────────────────────────────────────────────────────────

export async function cmdAddSource(
  args: string[],
  config: Config,
  notify: (text: string) => Promise<void>,
): Promise<void> {
  if (!args.length) {
    await notify(
      'Usage:\n' +
      '`/add_source <url>` — add a URL or raw GitHub file\n' +
      '`/add_source github <owner/repo> [path1 path2]` — add a GitHub repo',
    );
    return;
  }

  let newSource: KnowledgeSource;

  if (args[0].toLowerCase() === 'file') {
    // /add_source file /path/to/file.docx
    const filePath = args.slice(1).join(' ');
    if (!filePath) {
      await notify('Usage: `/add_source file /path/to/file.docx`\nFormats: txt, md, json, csv, docx, xlsx…');
      return;
    }
    const name = filePath.split('/').pop() ?? filePath;
    newSource = { type: 'file', name, filePath, refreshHours: 168 };
  } else if (args[0].toLowerCase() === 'github') {
    // /add_source github owner/repo [paths...]
    const repoArg = args[1];
    if (!repoArg?.includes('/')) {
      await notify('❌ Format: `/add_source github owner/repo`');
      return;
    }
    const [owner, repo] = repoArg.split('/');
    const paths = args.slice(2).length ? args.slice(2) : ['README.md'];
    newSource = { type: 'github', owner, repo, paths, refreshHours: 168 };
  } else {
    // /add_source <url>
    const url = args[0];
    if (!url.startsWith('http')) {
      await notify('❌ URL must start with http:// or https://');
      return;
    }
    // Derive a name from the URL
    const urlObj = new URL(url);
    const name = urlObj.pathname.split('/').filter(Boolean).pop() ?? urlObj.hostname;
    newSource = { type: 'url', name, url, refreshHours: 168 };
  }

  // Persist to config.json
  const raw = readConfig();
  const knowledge = (raw.knowledge as Record<string, unknown>) ?? {};
  const sources = (knowledge.sources as KnowledgeSource[]) ?? [];

  // Deduplicate
  const key = newSource.type === 'url' ? newSource.url
    : newSource.type === 'github' ? `${newSource.owner}/${newSource.repo}`
    : '';
  const alreadyExists = sources.some(s =>
    (s.type === 'url' && (s as { url?: string }).url === key) ||
    (s.type === 'github' && `${(s as { owner: string; repo: string }).owner}/${(s as { owner: string; repo: string }).repo}` === key),
  );
  if (alreadyExists) {
    await notify('⚠️ Source already configured.');
    return;
  }

  sources.push(newSource);
  knowledge.sources = sources;
  raw.knowledge = knowledge;
  saveConfig(raw);

  const label = newSource.type === 'url' ? (newSource as { url: string }).url
    : newSource.type === 'github' ? `github:${(newSource as { owner: string; repo: string }).owner}/${(newSource as { owner: string; repo: string }).repo}`
    : (newSource as { filePath: string }).filePath;

  await notify(`✅ Source added: ${label}\n\n_Indexing…_`);

  // Index immediately
  try {
    const { fetchUrl }    = await import('../../knowledge/connectors/url.js');
    const { fetchGitHub } = await import('../../knowledge/connectors/github.js');
    const { indexDocument } = await import('../../knowledge/indexer.js');

    let doc = null;
    if (newSource.type === 'url') {
      doc = await fetchUrl({ url: newSource.url, name: newSource.name, refreshDays: 7 });
    } else if (newSource.type === 'github') {
      doc = await fetchGitHub({
        owner: newSource.owner,
        repo:  newSource.repo,
        paths: newSource.paths,
        refreshDays: 7,
      });
    }

    if (doc) {
      await indexDocument(doc, config);
      await notify(`📚 *Indexed:* ${label}\n_Content is now searchable by Argos._`);
    } else {
      await notify(`⚠️ Source saved but indexing returned nothing. Check the path/URL.`);
    }
  } catch (e) {
    log.warn('Knowledge indexing failed', e);
    await notify(`⚠️ Source saved, but indexing failed: ${(e as Error).message}\n_Will retry on next refresh._`);
  }
}

// ─── /remove_source ───────────────────────────────────────────────────────────

export async function cmdRemoveSource(
  args: string[],
  config: Config,
  notify: (text: string) => Promise<void>,
): Promise<void> {
  const sources = config.knowledge.sources;
  if (!sources.length) {
    await notify('No knowledge sources to remove.');
    return;
  }

  if (!args.length) {
    await notify('Usage: `/remove_source <index>` (use /sources to see indices)');
    return;
  }

  const idx = parseInt(args[0], 10) - 1; // 1-based from user
  if (isNaN(idx) || idx < 0 || idx >= sources.length) {
    await notify(`❌ Invalid index. Use /sources to see the list (1–${sources.length}).`);
    return;
  }

  const removed = sources[idx];
  const raw = readConfig();
  const knowledge = raw.knowledge as Record<string, unknown>;
  (knowledge.sources as KnowledgeSource[]).splice(idx, 1);
  saveConfig(raw);

  const label = removed.type === 'url' ? removed.url
    : removed.type === 'github' ? `github:${removed.owner}/${removed.repo}`
    : removed.name;

  await notify(`🗑️ Source removed: ${label}`);
}

// ─── /refresh_sources ─────────────────────────────────────────────────────────

export async function cmdRefreshSources(
  config: Config,
  notify: (text: string) => Promise<void>,
): Promise<void> {
  const sources = config.knowledge.sources;
  if (!sources.length) {
    await notify('No knowledge sources configured.');
    return;
  }

  await notify(`🔄 Re-indexing ${sources.length} source(s)…`);

  try {
    const { loadKnowledge } = await import('../../knowledge/index.js');
    await loadKnowledge(config);
    await notify(`✅ All sources re-indexed.`);
  } catch (e) {
    await notify(`❌ Refresh failed: ${(e as Error).message}`);
  }
}
