/**
 * Knowledge layer — sources d'entreprise.
 *
 * Charge et indexe les documents internes (Notion, GitHub, Drive, Linear, URLs).
 * Stocke localement via SQLite (mémoires permanentes) + LanceDB (vector search).
 * Ne part jamais dans le cloud par défaut (indexLocally: true).
 *
 * v1 — knowledge personnel : ton Notion, tes repos GitHub
 * v2 — knowledge layérisé  : shared company + personal layer par user
 *       Tables partagées    : knowledge_shared_*
 *       Tables personnelles : knowledge_user_{userId}_*
 */

import { createLogger } from '../logger.js';
import type { Config, KnowledgeSource } from '../config/schema.js';
import { fetchUrl }    from './connectors/url.js';
import { fetchGitHub } from './connectors/github.js';
import { fetchNotion } from './connectors/notion.js';
import { fetchFile }   from './connectors/file.js';
import { fetchLinear } from './connectors/linear.js';
import { fetchLocal }  from './connectors/local.js';
import { indexDocument, isStale } from './indexer.js';
import type { KnowledgeDocument } from './types.js';

export type { KnowledgeDocument, KnowledgeConnector } from './types.js';

const log = createLogger('knowledge');

// ─── Dispatch par type de source ─────────────────────────────────────────────

async function fetchSource(source: KnowledgeSource, config: Config): Promise<KnowledgeDocument | null> {
  switch (source.type) {
    case 'url':
      return fetchUrl({
        url:         source.url,
        name:        source.name,
        refreshDays: source.refreshHours / 24,
      });

    case 'github':
      return fetchGitHub({
        owner:       source.owner,
        repo:        source.repo,
        paths:       source.paths,
        name:        source.name,
        refreshDays: source.refreshHours / 24,
      });

    case 'notion':
      return fetchNotion({
        pageId:      source.pageId,
        name:        source.name,
        type:        source.sourceType,
        refreshDays: source.refreshHours / 24,
      }, config);

    case 'file':
      return fetchFile({
        filePath:    source.filePath,
        name:        source.name,
        refreshDays: source.refreshHours / 24,
      });

    case 'linear':
      return fetchLinear({
        teamId:      source.teamId,
        name:        source.name,
        refreshDays: source.refreshHours / 24,
      }, config);

    case 'local':
      return fetchLocal({
        paths:       source.paths,
        name:        source.name,
        refreshDays: source.refreshHours / 24,
      });

    case 'google-drive':
      log.warn(`Connector 'google-drive' not yet implemented — skipping "${source.name}"`);
      return null;
  }
}

function sourceKey(source: KnowledgeSource): string {
  switch (source.type) {
    case 'url':          return `url:${source.url}`;
    case 'github':       return `github:${source.owner}/${source.repo}`;
    case 'notion':       return `notion:${source.pageId}`;
    case 'file':         return `file:${source.filePath}`;
    case 'local':        return `local:${source.name.toLowerCase().replace(/\s+/g, '_')}`;
    case 'linear':       return `linear:${source.teamId}`;
    case 'google-drive': return `gdrive:${source.folderId}`;
  }
}

// ─── Chargement initial ───────────────────────────────────────────────────────

export async function loadKnowledge(config: Config): Promise<void> {
  const sources = config.knowledge.sources;
  if (!sources.length) {
    log.debug('No knowledge sources configured');
    return;
  }

  log.info(`Loading ${sources.length} knowledge source(s)…`);

  const results = await Promise.allSettled(sources.map(s => fetchSource(s, config)));

  let loaded = 0;
  for (const result of results) {
    if (result.status === 'fulfilled' && result.value) {
      await indexDocument(result.value, config);
      loaded++;
    } else if (result.status === 'rejected') {
      log.warn('Knowledge source failed', result.reason);
    }
  }

  log.info(`Knowledge sources loaded: ${loaded}/${sources.length}`);
}

// ─── Refresh des sources périmées ────────────────────────────────────────────

export async function refreshStaleKnowledge(config: Config): Promise<void> {
  const now     = Date.now();
  const sources = config.knowledge.sources;

  const stale = sources.filter(s => isStale(sourceKey(s), s.refreshHours / 24, now));
  if (!stale.length) return;

  log.info(`Refreshing ${stale.length} stale knowledge source(s)…`);

  const results = await Promise.allSettled(stale.map(s => fetchSource(s, config)));
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) await indexDocument(r.value, config);
  }
}

// ─── Backward-compat ─────────────────────────────────────────────────────────

/** @deprecated use loadKnowledge */
export const loadContextSources = loadKnowledge;
/** @deprecated use refreshStaleKnowledge */
export const refreshStaleContextSources = refreshStaleKnowledge;
