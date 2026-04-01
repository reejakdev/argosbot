/**
 * Notion knowledge connector.
 * Fetches a Notion page or database and converts it to readable text.
 */

import { createLogger } from '../../logger.js';
import type { ContextNotion, Config } from '../../config/schema.js';
import type { KnowledgeDocument } from '../types.js';

const log = createLogger('knowledge:notion');

export async function fetchNotion(source: ContextNotion, config: Config): Promise<KnowledgeDocument | null> {
  if (!config.notion?.apiKey) {
    log.warn('Notion context source configured but no API key — skipping');
    return null;
  }

  log.info(`Fetching Notion ${source.type}: ${source.name}`);

  try {
    const { Client } = await import('@notionhq/client');
    const client     = new Client({ auth: config.notion.apiKey });

    const content = source.type === 'database'
      ? await fetchNotionDatabase(client, source.pageId, source.name)
      : await fetchNotionPage(client, source.pageId, source.name);

    return {
      key:     `notion:${source.pageId}`,
      name:    source.name,
      content: content.slice(0, 8000),
      tags:    ['context', 'notion', source.name.toLowerCase().replace(/\s+/g, '_')],
    };
  } catch (e) {
    log.warn(`Notion fetch failed (${source.name}): ${e}`);
    return null;
  }
}

async function fetchNotionPage(
  client: InstanceType<typeof import('@notionhq/client').Client>,
  pageId: string,
  name: string,
): Promise<string> {
  const { results } = await client.blocks.children.list({ block_id: pageId, page_size: 50 });
  const lines: string[] = [`# ${name} (Notion page)\n`];

  for (const block of results) {
    const b    = block as Record<string, unknown>;
    const type = b.type as string;
    const data = b[type] as { rich_text?: Array<{ plain_text: string }> } | undefined;
    const text = data?.rich_text?.map(r => r.plain_text).join('') ?? '';
    if (!text) continue;

    switch (type) {
      case 'heading_1':            lines.push(`# ${text}`); break;
      case 'heading_2':            lines.push(`## ${text}`); break;
      case 'heading_3':            lines.push(`### ${text}`); break;
      case 'bulleted_list_item':   lines.push(`• ${text}`); break;
      case 'numbered_list_item':   lines.push(`- ${text}`); break;
      case 'to_do': {
        const checked = (data as { checked?: boolean }).checked ? '☑' : '☐';
        lines.push(`${checked} ${text}`);
        break;
      }
      default: lines.push(text);
    }
  }

  return lines.join('\n');
}

async function fetchNotionDatabase(
  client: InstanceType<typeof import('@notionhq/client').Client>,
  databaseId: string,
  name: string,
): Promise<string> {
  const { results } = await client.databases.query({
    database_id: databaseId,
    page_size:   30,
    filter: { property: 'archived', checkbox: { equals: false } },
  }).catch(() => client.databases.query({ database_id: databaseId, page_size: 30 }));

  const lines: string[] = [`# ${name} (Notion database)\n`];

  for (const page of results) {
    const p = page as unknown as {
      properties: Record<string, {
        type:      string;
        title?:    Array<{ plain_text: string }>;
        rich_text?: Array<{ plain_text: string }>;
        checkbox?: boolean;
        select?:   { name: string };
        date?:     { start: string };
      }>;
    };

    let title = '(untitled)';
    for (const prop of Object.values(p.properties)) {
      if (prop.type === 'title' && prop.title?.length) {
        title = prop.title.map(r => r.plain_text).join('');
        break;
      }
    }

    const doneProps = Object.entries(p.properties)
      .filter(([, v]) => v.type === 'checkbox')
      .map(([, v]) => (v.checkbox ? '☑' : '☐'));
    const statusProp = Object.entries(p.properties)
      .filter(([, v]) => v.type === 'select' && v.select)
      .map(([, v]) => v.select!.name)[0];

    const prefix = doneProps[0] ?? '';
    const suffix = statusProp ? ` [${statusProp}]` : '';
    lines.push(`${prefix} ${title}${suffix}`);
  }

  return lines.join('\n');
}
