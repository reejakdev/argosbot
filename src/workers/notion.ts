/**
 * Notion worker — full API coverage via @notionhq/client SDK.
 *
 * Operations:
 *   createEntry()       — create a page in a database (tasks, todos, notes, deals…)
 *   createTodo()        — quick todo shortcut
 *   updatePage()        — update properties / archive a page
 *   completeTodo()      — mark Done checkbox on a page
 *   getPage()           — retrieve a page with all properties
 *   getPageContent()    — retrieve all blocks (content) of a page
 *   appendBlocks()      — append blocks to a page (paragraphs, todos, headings, bullets, code…)
 *   updateBlock()       — update or delete a single block
 *   queryDatabase()     — query a database with optional filters + sorts
 *   searchWorkspace()   — full-text search across entire workspace
 *   createDatabase()    — create a new database inside a page
 *   updateDatabase()    — update database title / properties schema
 *   getDatabase()       — retrieve database metadata + schema
 *   createComment()     — add a comment to a page
 *   getUsers()          — list workspace members
 */

import { Client } from '@notionhq/client';
import { createLogger } from '../logger.js';
import type { Config } from '../config/schema.js';
import type { WorkerResult } from './index.js';

const log = createLogger('notion-worker');

// ─── Templates ────────────────────────────────────────────────────────────────

const TEMPLATES: Record<string, { icon: string }> = {
  task:      { icon: '✅' },
  todo:      { icon: '☑️' },
  note:      { icon: '📝' },
  partner:   { icon: '🤝' },
  deal:      { icon: '💼' },
  tx_review: { icon: '🔐' },
  project:   { icon: '📁' },
  meeting:   { icon: '📅' },
  doc:       { icon: '📄' },
};

// ─── Notion worker ────────────────────────────────────────────────────────────

export class NotionWorker {
  private client: Client | null = null;

  constructor(private config: Config) {
    if (config.notion?.apiKey) {
      this.client = new Client({ auth: config.notion.apiKey });
    }
  }

  private get notion() { return this.config.notion!; }

  private guard(): WorkerResult | null {
    if (this.config.readOnly) return { success: true, dryRun: true, output: '[read-only mode — no changes made]' };
    if (!this.client)         return { success: false, dryRun: false, output: 'Notion not configured (missing apiKey)' };
    return null;
  }

  // ── Create a page in a database ────────────────────────────────────────────

  async createEntry(input: Record<string, unknown>): Promise<WorkerResult> {
    const g = this.guard();
    if (g?.dryRun) return { ...g, output: `[DRAFT] Would create: ${input.title}` };
    if (g)         return g;

    const dbType   = (input.database_type as string) ?? 'note';
    const template = TEMPLATES[dbType] ?? TEMPLATES.note;
    const targetDb = this.resolveDatabase(dbType, input.database_id as string | undefined);
    if (!targetDb) return { success: false, dryRun: false, output: `No database configured for type "${dbType}". Pass database_id or set config.notion.ownerDatabaseId.` };

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const properties: Record<string, any> = {
        Name: { title: [{ text: { content: String(input.title ?? '') } }] },
      };
      if (dbType !== 'todo')                             properties['Type']     = { select: { name: dbType } };
      if (dbType === 'todo' || dbType === 'task')        properties['Done']     = { checkbox: false };
      if (input.status)                                  properties['Status']   = { select: { name: input.status } };
      if (input.tags && Array.isArray(input.tags))       properties['Tags']     = { multi_select: (input.tags as string[]).map(t => ({ name: t })) };
      if (input.priority)                                properties['Priority'] = { select: { name: input.priority } };
      if (input.due_date)                                properties['Due']      = { date: { start: input.due_date } };
      if (input.assignee)                                properties['Assignee'] = { rich_text: [{ text: { content: String(input.assignee) } }] };
      // Allow arbitrary extra properties via input.properties
      if (input.properties && typeof input.properties === 'object') {
        Object.assign(properties, input.properties);
      }

      // Build children blocks
      const children: unknown[] = [];
      if (input.content) {
        children.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: String(input.content).slice(0, 2000) } }] } });
      }
      if (input.blocks && Array.isArray(input.blocks)) {
        children.push(...input.blocks);
      }

      const page = await this.client!.pages.create({
        parent: { database_id: targetDb },
        icon:   { emoji: template.icon } as never,
        properties,
        children: children as never,
      });

      const pageId = (page as { id: string }).id;
      log.info(`Notion page created: ${pageId} (${dbType})`);
      return { success: true, dryRun: false, output: `${template.icon} Created ${dbType}: ${input.title}`, data: { pageId } };
    } catch (e) {
      log.error('Notion createEntry failed', e);
      return { success: false, dryRun: false, output: String(e) };
    }
  }

  // ── Update page properties ─────────────────────────────────────────────────

  async updatePage(input: {
    page_id: string;
    properties?: Record<string, unknown>;
    archived?: boolean;
    icon?: string;
  }): Promise<WorkerResult> {
    const g = this.guard(); if (g) return g;
    try {
      await this.client!.pages.update({
        page_id:    input.page_id,
        archived:   input.archived,
        icon:       input.icon ? { emoji: input.icon } as never : undefined,
        properties: input.properties as never ?? {},
      });
      return { success: true, dryRun: false, output: `✅ Page updated: ${input.page_id}` };
    } catch (e) {
      log.error('Notion updatePage failed', e);
      return { success: false, dryRun: false, output: String(e) };
    }
  }

  // ── Get page properties ────────────────────────────────────────────────────

  async getPage(pageId: string): Promise<WorkerResult> {
    if (!this.client) return { success: false, dryRun: false, output: 'Notion not configured' };
    try {
      const page = await this.client.pages.retrieve({ page_id: pageId });
      const p    = page as unknown as { properties: Record<string, unknown>; url: string };
      const title = extractTitle(p.properties);
      return { success: true, dryRun: false, output: `📄 ${title}\nURL: ${p.url}`, data: page };
    } catch (e) {
      return { success: false, dryRun: false, output: String(e) };
    }
  }

  // ── Get page content (blocks) ──────────────────────────────────────────────

  async getPageContent(pageId: string): Promise<WorkerResult> {
    if (!this.client) return { success: false, dryRun: false, output: 'Notion not configured' };
    try {
      const blocks = await this.client.blocks.children.list({ block_id: pageId, page_size: 100 });
      const text   = blocksToText(blocks.results as never);
      return { success: true, dryRun: false, output: text || '(empty page)', data: blocks.results };
    } catch (e) {
      return { success: false, dryRun: false, output: String(e) };
    }
  }

  // ── Append blocks to a page ────────────────────────────────────────────────

  async appendBlocks(input: {
    page_id: string;
    blocks: unknown[];
  }): Promise<WorkerResult> {
    const g = this.guard(); if (g) return g;
    try {
      await this.client!.blocks.children.append({
        block_id: input.page_id,
        children: input.blocks as never,
      });
      return { success: true, dryRun: false, output: `✅ Appended ${input.blocks.length} block(s) to ${input.page_id}` };
    } catch (e) {
      log.error('Notion appendBlocks failed', e);
      return { success: false, dryRun: false, output: String(e) };
    }
  }

  // ── Update / delete a block ────────────────────────────────────────────────

  async updateBlock(input: {
    block_id: string;
    content?: Record<string, unknown>;
    archived?: boolean;
  }): Promise<WorkerResult> {
    const g = this.guard(); if (g) return g;
    try {
      if (input.archived) {
        await this.client!.blocks.delete({ block_id: input.block_id });
        return { success: true, dryRun: false, output: `🗑️ Block deleted: ${input.block_id}` };
      }
      await (this.client!.blocks as never as { update: (p: unknown) => Promise<unknown> }).update({
        block_id: input.block_id,
        ...input.content,
      });
      return { success: true, dryRun: false, output: `✅ Block updated: ${input.block_id}` };
    } catch (e) {
      return { success: false, dryRun: false, output: String(e) };
    }
  }

  // ── Mark todo done ─────────────────────────────────────────────────────────

  async completeTodo(pageId: string): Promise<WorkerResult> {
    return this.updatePage({ page_id: pageId, properties: { Done: { checkbox: true } } });
  }

  async createTodo(input: { title: string; content?: string; due_date?: string; priority?: 'Low' | 'Medium' | 'High'; tags?: string[] }): Promise<WorkerResult> {
    return this.createEntry({ ...input, database_type: 'todo' });
  }

  // ── Query database ─────────────────────────────────────────────────────────

  async queryDatabase(input: {
    database_id?: string;
    db_type?: string;
    filter?: unknown;
    sorts?: unknown[];
    limit?: number;
    query?: string; // convenience: title contains
  }): Promise<WorkerResult> {
    if (!this.client) return { success: false, dryRun: false, output: 'Notion not configured' };

    const dbId = input.database_id ?? this.resolveDatabase(input.db_type ?? 'agent');
    if (!dbId) return { success: false, dryRun: false, output: 'No database ID — pass database_id or configure config.notion' };

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const params: any = { database_id: dbId, page_size: input.limit ?? 20 };
      if (input.filter) {
        params.filter = input.filter;
      } else if (input.query) {
        params.filter = { property: 'Name', title: { contains: input.query } };
      }
      if (input.sorts) params.sorts = input.sorts;

      const results = await this.client.databases.query(params);
      const items   = results.results.map(p => {
        const page  = p as unknown as { id: string; properties: Record<string, unknown> };
        const title = extractTitle(page.properties);
        return `[${page.id.slice(-8)}] ${title}`;
      });

      return {
        success: true, dryRun: false,
        output:  items.length > 0 ? items.join('\n') : '(no results)',
        data:    results.results,
      };
    } catch (e) {
      log.error('Notion queryDatabase failed', e);
      return { success: false, dryRun: false, output: String(e) };
    }
  }

  // ── Full-text workspace search ─────────────────────────────────────────────

  async searchWorkspace(input: { query: string; filter_type?: 'page' | 'database'; limit?: number }): Promise<WorkerResult> {
    if (!this.client) return { success: false, dryRun: false, output: 'Notion not configured' };
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const params: any = { query: input.query, page_size: input.limit ?? 10 };
      if (input.filter_type) params.filter = { value: input.filter_type, property: 'object' };

      const results = await this.client.search(params);
      const items   = results.results.map(r => {
        const obj   = r as unknown as { id: string; object: string; properties?: Record<string, unknown>; title?: Array<{ plain_text: string }>; url: string };
        const title = obj.properties ? extractTitle(obj.properties) : (obj.title?.[0]?.plain_text ?? '(untitled)');
        return `[${obj.object}] ${title} — ${obj.url}`;
      });

      return {
        success: true, dryRun: false,
        output:  items.length > 0 ? items.join('\n') : '(no results)',
        data:    results.results,
      };
    } catch (e) {
      return { success: false, dryRun: false, output: String(e) };
    }
  }

  // ── Create a database ──────────────────────────────────────────────────────

  async createDatabase(input: {
    parent_page_id: string;
    title: string;
    properties?: Record<string, unknown>;
    icon?: string;
  }): Promise<WorkerResult> {
    const g = this.guard(); if (g) return g;
    try {
      const defaultProps = {
        Name:     { title: {} },
        Done:     { checkbox: {} },
        Priority: { select: { options: [{ name: 'High', color: 'red' }, { name: 'Medium', color: 'yellow' }, { name: 'Low', color: 'blue' }] } },
        Tags:     { multi_select: { options: [] } },
        Due:      { date: {} },
      };

      const db = await this.client!.databases.create({
        parent:     { type: 'page_id', page_id: input.parent_page_id },
        icon:       input.icon ? { emoji: input.icon } as never : undefined,
        title:      [{ type: 'text', text: { content: input.title } }],
        properties: (input.properties ?? defaultProps) as never,
      });

      const dbId = (db as { id: string }).id;
      log.info(`Notion database created: ${dbId}`);
      return { success: true, dryRun: false, output: `📁 Database created: ${input.title}`, data: { databaseId: dbId } };
    } catch (e) {
      log.error('Notion createDatabase failed', e);
      return { success: false, dryRun: false, output: String(e) };
    }
  }

  // ── Get database metadata ──────────────────────────────────────────────────

  async getDatabase(databaseId: string): Promise<WorkerResult> {
    if (!this.client) return { success: false, dryRun: false, output: 'Notion not configured' };
    try {
      const db      = await this.client.databases.retrieve({ database_id: databaseId });
      const d       = db as unknown as { title: Array<{ plain_text: string }>; properties: Record<string, unknown>; url: string };
      const title   = d.title?.[0]?.plain_text ?? '(untitled)';
      const props   = Object.keys(d.properties).join(', ');
      return { success: true, dryRun: false, output: `📁 ${title}\nProperties: ${props}\nURL: ${d.url}`, data: db };
    } catch (e) {
      return { success: false, dryRun: false, output: String(e) };
    }
  }

  // ── Update database schema/title ───────────────────────────────────────────

  async updateDatabase(input: {
    database_id: string;
    title?: string;
    properties?: Record<string, unknown>;
  }): Promise<WorkerResult> {
    const g = this.guard(); if (g) return g;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const params: any = { database_id: input.database_id };
      if (input.title)      params.title = [{ type: 'text', text: { content: input.title } }];
      if (input.properties) params.properties = input.properties;
      await this.client!.databases.update(params);
      return { success: true, dryRun: false, output: `✅ Database updated: ${input.database_id}` };
    } catch (e) {
      return { success: false, dryRun: false, output: String(e) };
    }
  }

  // ── Create a comment ───────────────────────────────────────────────────────

  async createComment(input: { page_id: string; content: string }): Promise<WorkerResult> {
    const g = this.guard(); if (g) return g;
    try {
      await (this.client! as never as { comments: { create: (p: unknown) => Promise<unknown> } }).comments.create({
        parent:     { page_id: input.page_id },
        rich_text:  [{ type: 'text', text: { content: input.content } }],
      });
      return { success: true, dryRun: false, output: `💬 Comment added to ${input.page_id}` };
    } catch (e) {
      return { success: false, dryRun: false, output: String(e) };
    }
  }

  // ── List workspace users ───────────────────────────────────────────────────

  async getUsers(): Promise<WorkerResult> {
    if (!this.client) return { success: false, dryRun: false, output: 'Notion not configured' };
    try {
      const users = await this.client.users.list({});
      const items = (users.results as Array<{ name: string; id: string; type: string }>).map(u => `${u.name} (${u.type}) — ${u.id}`);
      return { success: true, dryRun: false, output: items.join('\n'), data: users.results };
    } catch (e) {
      return { success: false, dryRun: false, output: String(e) };
    }
  }

  // ── Resolve database ID ────────────────────────────────────────────────────

  private resolveDatabase(dbType: string, explicitId?: string): string | null {
    if (explicitId) return explicitId;
    const n    = this.notion;
    const mode = n.mode ?? 'both';
    if ((dbType === 'todo' || dbType === 'task') && (mode === 'owner' || mode === 'both')) {
      return n.ownerDatabaseId ?? n.agentDatabaseId ?? null;
    }
    return n.agentDatabaseId ?? n.ownerDatabaseId ?? null;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extractTitle(properties: Record<string, unknown>): string {
  for (const val of Object.values(properties)) {
    const v = val as { title?: Array<{ plain_text: string }> };
    if (v?.title?.[0]?.plain_text) return v.title[0].plain_text;
  }
  return '(untitled)';
}

function blocksToText(blocks: Array<{ type: string; [key: string]: unknown }>): string {
  return blocks.map(b => {
    const content = (b[b.type] as { rich_text?: Array<{ plain_text: string }> })?.rich_text?.map(r => r.plain_text).join('') ?? '';
    const prefix  = b.type === 'heading_1' ? '# ' : b.type === 'heading_2' ? '## ' : b.type === 'heading_3' ? '### ' : b.type === 'to_do' ? '- [ ] ' : b.type === 'bulleted_list_item' ? '- ' : '';
    return content ? `${prefix}${content}` : '';
  }).filter(Boolean).join('\n');
}
