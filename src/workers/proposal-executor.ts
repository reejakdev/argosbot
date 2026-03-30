/**
 * Proposal executor — executes approved proposals.
 *
 * When a proposal is approved:
 * 1. write_file → write directly
 * 2. Other actions → build a prompt from the action details and run an LLM agent
 *    with tools (Notion API, web search, etc.) to execute the plan
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { createLogger } from '../logger.js';
import { getDb } from '../db/index.js';
import type { LLMConfig } from '../llm/index.js';

const log = createLogger('executor');

function getDataDir(): string {
  const dir = process.env.DATA_DIR ?? path.join(os.homedir(), '.argos');
  return dir.startsWith('~') ? path.join(os.homedir(), dir.slice(1)) : dir;
}

export interface ExecutionResult {
  success: boolean;
  results: string[];
  errors: string[];
}

/**
 * Execute all actions in an approved proposal.
 */
export async function executeApprovedProposal(
  proposalId: string,
  llmConfig: LLMConfig,
  notifyUser: (text: string) => Promise<void>,
): Promise<ExecutionResult> {
  const db = getDb();
  const proposal = db.prepare(
    "SELECT id, plan, actions, context_summary FROM proposals WHERE id = ?"
  ).get(proposalId) as { id: string; plan: string; actions: string; context_summary: string } | undefined;

  if (!proposal) {
    return { success: false, results: [], errors: ['Proposal not found'] };
  }

  const actions = JSON.parse(proposal.actions) as Array<Record<string, unknown>>;
  const results: string[] = [];
  const errors: string[] = [];

  for (const action of actions) {
    const tool = (action.tool ?? action.action) as string;
    const details = (action.details ?? '') as string;
    const input = (action.input ?? {}) as Record<string, unknown>;

    log.info(`Executing action: ${tool}`, { proposalId });

    try {
      switch (tool) {
        case 'write_file': {
          const relPath = input.path as string;
          const content = input.content as string;
          const normalized = path.normalize(relPath);
          if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
            errors.push(`Security: path traversal blocked for ${relPath}`);
            break;
          }
          const fullPath = path.join(getDataDir(), normalized);
          fs.mkdirSync(path.dirname(fullPath), { recursive: true });
          fs.writeFileSync(fullPath, content, 'utf8');
          results.push(`✅ File written: ${relPath}`);
          log.info(`File written: ${fullPath}`);
          break;
        }

        case 'Create Notion database':
        case 'Create Notion page':
        case 'notion': {
          const result = await executeWithAgent(
            `Execute this Notion action:\n${details}\n\nUse the available tools to complete this task.`,
            llmConfig,
          );
          results.push(`✅ Notion: ${result}`);
          break;
        }

        default: {
          // Generic action — use LLM agent to figure out how to execute
          const result = await executeWithAgent(
            `Execute this action: ${tool}\nDetails: ${details}\n\nContext: ${proposal.context_summary}`,
            llmConfig,
          );
          results.push(`✅ ${tool}: ${result}`);
          break;
        }
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      errors.push(`❌ ${tool}: ${errMsg}`);
      log.error(`Action failed: ${tool}`, { error: errMsg, proposalId });
    }
  }

  // Update proposal status
  const finalStatus = errors.length === 0 ? 'executed' : 'partial';
  db.prepare("UPDATE proposals SET status = ?, executed_at = ? WHERE id = ?")
    .run(finalStatus, Date.now(), proposalId);

  // Notify user
  const summary = [
    `📋 Proposal executed: ${proposal.plan}`,
    '',
    ...results,
    ...errors,
  ].join('\n');

  await notifyUser(summary).catch(() => {});

  return { success: errors.length === 0, results, errors };
}

/**
 * Use an LLM agent with tools to execute a complex action.
 */
async function executeWithAgent(prompt: string, llmConfig: LLMConfig): Promise<string> {
  const { runToolLoop } = await import('../llm/tool-loop.js');
  const { callAnthropicBearerRaw } = await import('../llm/index.js');
  const { BUILTIN_TOOLS, executeBuiltinTool } = await import('../llm/builtin-tools.js');
  const { getMcpTools, executeMcpTool } = await import('../mcp/client.js');

  const notionKey = process.env.NOTION_API_KEY;
  const tools = [...BUILTIN_TOOLS, ...getMcpTools()];

  // Executor: approved actions execute DIRECTLY — no more proposals!
  const executor = async (name: string, input: Record<string, unknown>) => {
    // write_file — execute directly (already approved)
    if (name === 'write_file') {
      const relPath = path.normalize(input.path as string);
      if (relPath.startsWith('..') || path.isAbsolute(relPath)) {
        return { output: 'Security: path traversal blocked', error: true };
      }
      const fullPath = path.join(getDataDir(), relPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, input.content as string, 'utf8');
      return { output: `File written: ${relPath}` };
    }

    // create_proposal — BLOCK in executor (prevents infinite proposal loop)
    if (name === 'create_proposal') {
      return { output: 'Already executing an approved proposal — no need to create another one. Use the available tools directly.', error: true };
    }

    // MCP tools — execute directly (all Notion etc. goes through MCP)
    if (name.startsWith('mcp_')) {
      return executeMcpTool(name, input);
    }

    // All other builtin tools (search, memory, etc.)
    return executeBuiltinTool(name, input);
  };

  const messages = [
    { role: 'system' as const, content: 'You are an execution agent. Complete the requested action using available tools. Be precise and report what you did.' },
    { role: 'user' as const, content: prompt },
  ];

  const response = await runToolLoop(llmConfig, messages[0].content, messages, tools, executor, callAnthropicBearerRaw);
  return response.content || 'Action completed (no output)';
}

async function executeNotionTool(
  name: string,
  input: Record<string, unknown>,
  apiKey: string,
): Promise<{ output: string; error?: boolean }> {
  try {
    const { Client } = await import('@notionhq/client');
    const notion = new Client({ auth: apiKey });

    switch (name) {
      case 'notion_search': {
        const results = await notion.search({
          query: input.query as string,
          page_size: 5,
        });
        const items = results.results.map((r: Record<string, unknown>) => {
          const title = ((r as Record<string, unknown>).properties as Record<string, { title?: Array<{ plain_text: string }> }>)?.Name?.title?.[0]?.plain_text
            ?? ((r as Record<string, unknown>).properties as Record<string, { title?: Array<{ plain_text: string }> }>)?.title?.title?.[0]?.plain_text
            ?? r.id;
          return `- ${title} (${r.object}: ${r.id})`;
        });
        return { output: items.length > 0 ? items.join('\n') : 'No results found.' };
      }

      case 'notion_create_database': {
        const parentId = input.parent_page_id as string | undefined;
        const title = input.title as string;
        let properties: Record<string, unknown> = {
          Name: { title: {} },
          Status: { select: { options: [{ name: 'To Do' }, { name: 'In Progress' }, { name: 'Done' }] } },
          Notes: { rich_text: {} },
        };

        if (input.properties) {
          try { properties = { Name: { title: {} }, ...JSON.parse(input.properties as string) }; } catch { /* use default */ }
        }

        let resolvedParent = parentId;
        if (!resolvedParent || resolvedParent === 'root' || resolvedParent === 'workspace') {
          const searchResult = await notion.search({ page_size: 1 });
          if (searchResult.results.length > 0) {
            resolvedParent = searchResult.results[0].id;
          } else {
            return { output: 'No accessible Notion pages found. Share a page with the Argos integration first.', error: true };
          }
        }
        const parent = { page_id: resolvedParent };

        const db = await notion.databases.create({
          parent: parent as { page_id: string },
          title: [{ type: 'text', text: { content: title } }],
          properties: properties as Parameters<typeof notion.databases.create>[0]['properties'],
        });

        return { output: `Database created: "${title}" (ID: ${db.id})` };
      }

      case 'notion_create_page': {
        const parentId = input.parent_id as string;
        const title = input.title as string;
        const content = input.content as string | undefined;
        const databaseId = input.database_id as string | undefined;

        // If adding to a database, create a DB entry (not a page)
        if (databaseId) {
          const props: Record<string, unknown> = {
            Name: { title: [{ text: { content: title } }] },
          };
          // Add optional properties
          if (input.status) props.Status = { select: { name: input.status as string } };
          if (input.priority) props.Priority = { select: { name: input.priority as string } };
          if (input.due) props.Due = { date: { start: input.due as string } };

          const page = await notion.pages.create({
            parent: { database_id: databaseId },
            properties: props as Parameters<typeof notion.pages.create>[0]['properties'],
          });
          return { output: `Entry added to database: "${title}" (ID: ${page.id})` };
        }

        // Regular page creation
        let resolvedParentId = parentId;
        if (!parentId || parentId === 'workspace' || parentId === 'root') {
          const searchResult = await notion.search({ page_size: 1 });
          if (searchResult.results.length > 0) {
            resolvedParentId = searchResult.results[0].id;
          } else {
            return { output: 'No accessible Notion pages found.', error: true };
          }
        }

        const page = await notion.pages.create({
          parent: { page_id: resolvedParentId } as Parameters<typeof notion.pages.create>[0]['parent'],
          properties: {
            title: { title: [{ text: { content: title } }] },
          },
          ...(content && {
            children: [{
              object: 'block' as const,
              type: 'paragraph' as const,
              paragraph: { rich_text: [{ type: 'text' as const, text: { content } }] },
            }],
          }),
        });

        return { output: `Page created: "${title}" (ID: ${page.id})` };
      }

      case 'notion_archive_page': {
        const pageId = input.page_id as string;
        await notion.pages.update({ page_id: pageId, archived: true });
        return { output: `Page archived: ${pageId}` };
      }

      default:
        return { output: `Unknown Notion tool: ${name}`, error: true };
    }
  } catch (e) {
    return { output: `Notion error: ${e instanceof Error ? e.message : String(e)}`, error: true };
  }
}
