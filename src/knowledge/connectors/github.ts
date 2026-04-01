/**
 * GitHub knowledge connector.
 * Fetches README and configured paths from a GitHub repository.
 */

import { createLogger } from '../../logger.js';
import type { ContextGitHub } from '../../config/schema.js';
import type { KnowledgeDocument } from '../types.js';

const log = createLogger('knowledge:github');

export async function fetchGitHub(source: ContextGitHub): Promise<KnowledgeDocument | null> {
  const repoLabel = source.name ?? `${source.owner}/${source.repo}`;
  log.info(`Fetching GitHub: ${source.owner}/${source.repo}`);

  try {
    const parts: string[] = [`# ${repoLabel}\nhttps://github.com/${source.owner}/${source.repo}\n`];
    const headers: Record<string, string> = {
      'Accept':     'application/vnd.github.v3.raw',
      'User-Agent': 'Argos/1.0',
    };

    if (process.env.GITHUB_TOKEN) {
      headers['Authorization'] = `token ${process.env.GITHUB_TOKEN}`;
    }

    for (const filePath of source.paths) {
      const url = `https://api.github.com/repos/${source.owner}/${source.repo}/contents/${filePath}`;
      try {
        const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
        if (!res.ok) continue;

        const body = await res.text();
        let content = body;
        try {
          const json = JSON.parse(body);
          if (json.encoding === 'base64' && json.content) {
            content = Buffer.from(json.content, 'base64').toString('utf8');
          }
        } catch {}

        parts.push(`\n## ${filePath}\n\n${content}`);
      } catch {
        log.debug(`Could not fetch ${source.owner}/${source.repo}/${filePath}`);
      }
    }

    const fullText = parts.join('\n');
    const isLarge  = fullText.length > 8000;

    return {
      key:      `github:${source.owner}/${source.repo}`,
      name:     repoLabel,
      content:  isLarge ? fullText.slice(0, 2000) + '\n\n[…full content indexed in vector store]' : fullText,
      tags:     ['context', 'github', source.owner, source.repo],
      fullText: isLarge ? fullText : undefined,
    };
  } catch (e) {
    log.warn(`GitHub fetch failed (${source.owner}/${source.repo}): ${e}`);
    return null;
  }
}
