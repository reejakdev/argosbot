/**
 * Notion worker.
 *
 * Supports two modes (set in config.notion.mode):
 *   'agent'  — writes only to the agent's dedicated database (safest)
 *   'owner'  — writes to the owner's personal workspace (todos, notes)
 *   'both'   — can write to either
 *
 * Operations:
 *   createEntry()  — generic page creation (tasks, notes, tx reviews, deals)
 *   createTodo()   — quick todo in owner workspace with checkbox
 *   completeTodo() — mark a Notion page as done (check the checkbox)
 *   queryDatabase()— search entries by title
 */

import { Client } from '@notionhq/client';
import { createLogger } from '../logger.js';
import type { Config } from '../config/schema.js';
import type { WorkerResult } from './index.js';

const log = createLogger('notion-worker');

// ─── Templates ────────────────────────────────────────────────────────────────

const TEMPLATES: Record<string, { icon: string; description: string }> = {
  task:       { icon: '✅', description: 'Tracked task or follow-up' },
  todo:       { icon: '☑️',  description: 'Personal to-do item' },
  note:       { icon: '📝', description: 'General note or summary' },
  partner:    { icon: '🤝', description: 'Partner or client entry' },
  deal:       { icon: '💼', description: 'Deal or opportunity' },
  tx_review:  { icon: '🔐', description: 'Transaction review entry' },
};

// ─── Notion worker ────────────────────────────────────────────────────────────

export class NotionWorker {
  private client: Client | null = null;

  constructor(private config: Config) {
    if (config.notion) {
      this.client = new Client({ auth: config.notion.apiKey });
    }
  }

  // ── Create a page (generic) ─────────────────────────────────────────────────

  async createEntry(input: Record<string, unknown>): Promise<WorkerResult> {
    const dbType   = (input.database_type as string) ?? 'note';
    const template = TEMPLATES[dbType] ?? TEMPLATES.note;

    if (this.config.readOnly || !this.config.notion) {
      return {
        success: true,
        dryRun:  true,
        output:  `${template.icon} [DRAFT] ${dbType}: ${input.title}\n${String(input.content ?? '').slice(0, 200)}`,
        data: input,
      };
    }

    const targetDb = this.resolveDatabase(dbType);
    if (!targetDb) {
      return { success: false, dryRun: false, output: `No database configured for type "${dbType}". Check config.notion.` };
    }

    try {
      const properties: Record<string, unknown> = {
        Name: { title: [{ text: { content: input.title as string } }] },
      };

      // Add Type property if not a simple todo
      if (dbType !== 'todo') {
        properties['Type'] = { select: { name: dbType } };
      }

      // Checkbox for todo/task types
      if (dbType === 'todo' || dbType === 'task') {
        properties['Done'] = { checkbox: false };
      }

      // Tags
      if (input.tags && Array.isArray(input.tags)) {
        properties['Tags'] = {
          multi_select: (input.tags as string[]).map(tag => ({ name: tag })),
        };
      }

      // Priority
      if (input.priority) {
        properties['Priority'] = { select: { name: input.priority as string } };
      }

      // Due date
      if (input.due_date) {
        properties['Due'] = { date: { start: input.due_date as string } };
      }

      const page = await this.client!.pages.create({
        parent: { database_id: targetDb },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        icon: { emoji: template.icon } as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        properties: properties as any,
        children: input.content ? [
          {
            object: 'block' as const,
            type:   'paragraph' as const,
            paragraph: {
              rich_text: [{ type: 'text' as const, text: { content: String(input.content).slice(0, 2000) } }],
            },
          },
        ] : [],
      });

      const pageId = (page as { id: string }).id;
      log.info(`Notion page created: ${pageId} (${dbType})`);

      return {
        success: true,
        dryRun:  false,
        output:  `${template.icon} Created ${dbType}: ${input.title}`,
        data:    { pageId },
      };
    } catch (e) {
      log.error('Notion create failed', e);
      return { success: false, dryRun: false, output: String(e) };
    }
  }

  // ── Create a todo in owner workspace ────────────────────────────────────────

  async createTodo(input: {
    title: string;
    content?: string;
    due_date?: string;
    priority?: 'Low' | 'Medium' | 'High';
    tags?: string[];
  }): Promise<WorkerResult> {
    return this.createEntry({
      ...input,
      database_type: 'todo',
    });
  }

  // ── Mark a Notion page as done ──────────────────────────────────────────────

  async completeTodo(pageId: string): Promise<WorkerResult> {
    if (this.config.readOnly || !this.client) {
      return { success: true, dryRun: true, output: `[DRAFT] Would mark ${pageId} as done` };
    }

    try {
      await this.client.pages.update({
        page_id: pageId,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        properties: { Done: { checkbox: true } } as any,
      });

      return { success: true, dryRun: false, output: `✅ Marked as done: ${pageId}` };
    } catch (e) {
      log.error('Notion completeTodo failed', e);
      return { success: false, dryRun: false, output: String(e) };
    }
  }

  // ── Query a database by title ───────────────────────────────────────────────

  async queryDatabase(query: string, dbType?: 'agent' | 'owner'): Promise<WorkerResult> {
    if (!this.client || !this.config.notion) {
      return { success: false, dryRun: false, output: 'Notion not configured' };
    }

    const dbId = dbType === 'owner'
      ? this.config.notion.ownerDatabaseId
      : this.config.notion.agentDatabaseId;

    if (!dbId) {
      return { success: false, dryRun: false, output: `No ${dbType ?? 'agent'} database ID configured` };
    }

    try {
      const results = await this.client.databases.query({
        database_id: dbId,
        filter: { property: 'Name', title: { contains: query } },
        page_size: 10,
      });

      const items = results.results.map(p => {
        const page = p as unknown as { properties: { Name: { title: Array<{ plain_text: string }> } } };
        return page.properties.Name.title[0]?.plain_text ?? '(untitled)';
      });

      return {
        success: true,
        dryRun:  false,
        output:  items.length > 0 ? items.join('\n') : '(no results)',
        data:    results.results,
      };
    } catch (e) {
      log.error('Notion query failed', e);
      return { success: false, dryRun: false, output: String(e) };
    }
  }

  // ── Resolve which database to write to ──────────────────────────────────────

  private resolveDatabase(dbType: string): string | null {
    const n = this.config.notion!;
    const mode = n.mode ?? 'agent';

    // Personal/owner types → owner workspace if available
    if ((dbType === 'todo') && (mode === 'owner' || mode === 'both')) {
      return n.ownerDatabaseId ?? n.agentDatabaseId;
    }

    return n.agentDatabaseId;
  }
}
