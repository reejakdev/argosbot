/**
 * URL knowledge connector.
 * Fetches a web page or plain-text document and extracts readable text.
 */

import { createLogger } from '../../logger.js';
import type { ContextUrl } from '../../config/schema.js';
import type { KnowledgeDocument } from '../types.js';

const log = createLogger('knowledge:url');

export async function fetchUrl(source: ContextUrl): Promise<KnowledgeDocument | null> {
  log.info(`Fetching URL: ${source.url}`);
  try {
    const res = await fetch(source.url, {
      headers: { 'User-Agent': 'Argos/1.0 (knowledge loader)' },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const contentType = res.headers.get('content-type') ?? '';
    let text: string;

    if (contentType.includes('text/html')) {
      text = extractTextFromHtml(await res.text());
    } else {
      text = await res.text();
    }

    const header = `[${source.name}]\nSource: ${source.url}\n\n`;
    const isLarge = text.length > 8000;

    return {
      key: `url:${source.url}`,
      name: source.name,
      content:
        header +
        (isLarge ? text.slice(0, 2000) + '\n\n[…full content indexed in vector store]' : text),
      tags: ['context', 'url', source.name.toLowerCase().replace(/\s+/g, '_')],
      fullText: isLarge ? header + text : undefined,
    };
  } catch (e) {
    log.warn(`URL fetch failed (${source.url}): ${e}`);
    return null;
  }
}

function extractTextFromHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s{3,}/g, '\n\n')
    .trim();
}
