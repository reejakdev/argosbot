/**
 * notion_db_query — Structured query against a configured Notion database.
 *
 * Unlike `notion_search` (which does fulltext search across the workspace),
 * this skill queries a SPECIFIC database with optional filters on its
 * structured properties (Status, Type, etc.).
 *
 * Use it whenever the user asks a structured question like:
 *   - "what deployments are in progress?"
 *   - "list all open tasks for project X"
 *   - "which tokens are ready to launch?"
 *
 * It enumerates databases declared in `config.knowledge.sources` of type
 * 'notion' (sourceType=database) so the LLM can pick by name.
 *
 * Enabled via config:
 *   { "name": "notion_db_query", "enabled": true }
 *
 * Requires `notion.apiKey` (or NOTION_API_KEY env).
 */

import { registerSkill } from '../registry.js';

registerSkill({
  name: 'notion_db_query',
  description:
    'Query a configured Notion database with optional property filters. Returns matching rows with all their structured properties. Use this whenever you need a filtered list from a Notion database (e.g. "deployments in progress", "open tasks", "tokens ready to launch"). Much more accurate than notion_search for structured questions.',
  tool: {
    name: 'notion_db_query',
    description:
      'Query a Notion database by name with an optional status filter. Returns matching rows with all properties. Database names come from config.knowledge.sources (notion entries with sourceType=database). Common databases for Midas: "Token Launches", "Token Launches Parameters", "Tasks Tracker", "Projects". Returns up to 30 rows.',
    input_schema: {
      type: 'object',
      properties: {
        database_name: {
          type: 'string',
          description:
            'Name (or partial name) of the Notion database to query. Examples: "Token Launches", "Tasks Tracker". Case-insensitive substring match.',
        },
        status_filter: {
          type: 'string',
          description:
            'Optional status value to filter rows by. Examples: "In progress", "Done", "Ready", "Not started", "Paused". Partial case-insensitive match against the row\'s Status / Statut / État property.',
        },
        type_filter: {
          type: 'string',
          description:
            'Optional secondary filter on a Type / Category property. Examples: "Vault", "OFT", "Midas Issued". Partial case-insensitive match.',
        },
        limit: {
          type: 'number',
          description: 'Max rows to return (default 30, max 100).',
        },
      },
      required: ['database_name'],
    },
  },
  handler: async (input) => {
    const dbName = String(input.database_name ?? '').trim().toLowerCase();
    const statusFilter = String(input.status_filter ?? '').trim().toLowerCase();
    const typeFilter = String(input.type_filter ?? '').trim().toLowerCase();
    const limit = Math.min(100, Math.max(1, Number(input.limit ?? 30)));

    if (!dbName) return { success: false, output: 'Missing database_name input.' };

    const { getConfig } = await import('../../config/index.js');
    const config = getConfig();
    const apiKey = config.notion?.apiKey;
    if (!apiKey) {
      return { success: false, output: 'No Notion API key configured.' };
    }

    // Find matching DB sources from config.knowledge.sources
    type NotionDbSource = { name: string; pageId: string };
    const sources: NotionDbSource[] = (config.knowledge?.sources ?? [])
      .filter((s) => s.type === 'notion')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .filter((s) => (s as any).sourceType === 'database')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((s) => ({ name: (s as any).name as string, pageId: (s as any).pageId as string }));

    const matches = sources.filter((s) => s.name.toLowerCase().includes(dbName));
    if (matches.length === 0) {
      const available = sources.map((s) => `"${s.name}"`).join(', ');
      return {
        success: false,
        output: `No Notion database matches "${dbName}". Available: ${available || '(none configured)'}`,
      };
    }
    if (matches.length > 1) {
      const matched = matches.map((s) => `"${s.name}"`).join(', ');
      return {
        success: false,
        output: `Multiple Notion databases match "${dbName}": ${matched}. Please be more specific.`,
      };
    }

    const db = matches[0];

    try {
      const { Client } = await import('@notionhq/client');
      const client = new Client({ auth: apiKey });

      // Fetch all rows then filter client-side (avoids needing to know property names)
      const rows: unknown[] = [];
      let cursor: string | undefined;
      do {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const res = (await client.databases.query({
          database_id: db.pageId,
          page_size: 100,
          start_cursor: cursor,
        })) as any;
        rows.push(...res.results);
        cursor = res.has_more ? res.next_cursor ?? undefined : undefined;
        if (rows.length >= 200) break;
      } while (cursor);

      // Render each row as { title, status, type, props, url }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const renderProp = (prop: any): string => {
        const t = prop?.type;
        if (!t || prop[t] == null) return '';
        const v = prop[t];
        switch (t) {
          case 'title':
          case 'rich_text':
            return Array.isArray(v) ? v.map((r: { plain_text: string }) => r.plain_text).join('') : '';
          case 'select':
            return v?.name ?? '';
          case 'status':
            return v?.name ?? '';
          case 'multi_select':
            return Array.isArray(v) ? v.map((o: { name: string }) => o.name).join(', ') : '';
          case 'date':
            return v?.start ?? '';
          case 'checkbox':
            return v ? '☑' : '☐';
          case 'number':
          case 'url':
          case 'email':
            return String(v);
          case 'people':
            return Array.isArray(v) ? v.map((p: { name?: string; id?: string }) => p.name ?? p.id ?? '').filter(Boolean).join(', ') : '';
          case 'created_time':
          case 'last_edited_time':
            return String(v);
          default:
            return '';
        }
      };

      const filtered: Array<{
        title: string;
        status: string;
        type: string;
        url: string;
        props: Record<string, string>;
      }> = [];

      for (const row of rows) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const r = row as any;
        const props: Record<string, unknown> = r.properties ?? {};

        let title = '(untitled)';
        let status = '';
        let type = '';
        const rendered: Record<string, string> = {};

        for (const [key, p] of Object.entries(props)) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const val = renderProp(p as any);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          if ((p as any).type === 'title' && val) title = val;
          const lk = key.toLowerCase();
          if (!status && (lk === 'status' || lk === 'statut' || lk === 'état' || lk === 'etat')) {
            status = val;
          }
          if (!type && (lk === 'type' || lk === 'category' || lk === 'catégorie')) {
            type = val;
          }
          if (val) rendered[key] = val;
        }

        // Apply filters
        if (statusFilter && !status.toLowerCase().includes(statusFilter)) continue;
        if (typeFilter && !type.toLowerCase().includes(typeFilter)) continue;

        filtered.push({ title, status, type, url: r.url ?? '', props: rendered });
        if (filtered.length >= limit) break;
      }

      if (filtered.length === 0) {
        return {
          success: true,
          output: `Database "${db.name}" — no rows match status="${statusFilter || '*'}" type="${typeFilter || '*'}". Total scanned: ${rows.length}.`,
        };
      }

      const lines: string[] = [
        `**${db.name}** — ${filtered.length} row(s) match${statusFilter ? ` status="${statusFilter}"` : ''}${typeFilter ? ` type="${typeFilter}"` : ''} (scanned ${rows.length} total)`,
        '',
      ];
      for (const row of filtered) {
        const meta: string[] = [];
        if (row.status) meta.push(`status: ${row.status}`);
        if (row.type) meta.push(`type: ${row.type}`);
        const tag = meta.length ? ` _(${meta.join(' · ')})_` : '';
        lines.push(`### ${row.title}${tag}`);
        if (row.url) lines.push(`${row.url}`);
        for (const [k, v] of Object.entries(row.props)) {
          if (k.toLowerCase() === 'name' || k.toLowerCase() === 'title') continue;
          if (k.toLowerCase() === 'status' || k.toLowerCase() === 'statut') continue;
          if (k.toLowerCase() === 'type') continue;
          lines.push(`  - ${k}: ${v}`);
        }
        lines.push('');
      }

      return { success: true, output: lines.join('\n').trimEnd() };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { success: false, output: `Notion query failed: ${msg}` };
    }
  },
});
