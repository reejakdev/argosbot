/**
 * Telegram management plugin.
 *
 * Encapsulates all Telegram-specific tooling so the core Argos pipeline
 * stays channel-agnostic. This plugin can be reused in any Argos-compatible
 * system that runs a Telegram channel.
 *
 * Provides three tools Claude can use in the planner:
 *
 *   telegram_add_chat    — add a chat to the monitored list
 *   telegram_ignore_chat — suppress discovery notifications for a chat
 *   telegram_list_chats  — inspect the current monitored list
 *
 * Worker execution happens after owner approval, exactly like all other
 * proposal actions. No Telegram-specific code touches the generic pipeline.
 */

import { addMonitoredChat, ignoreChat, getConfig } from '../../config/index.js';
import type { WorkerResult } from '../../workers/index.js';

// ─── Plugin metadata ──────────────────────────────────────────────────────────

export const TELEGRAM_PLUGIN = {
  name: 'telegram',
  description: 'Manage monitored Telegram chats',
  version: '1.0.0',
} as const;

// ─── Tool definitions (fed to Claude in the planner) ─────────────────────────

export const TELEGRAM_TOOLS = [
  {
    name: 'telegram_add_chat',
    description: 'Add a Telegram chat to the monitored list so Argos processes its messages',
    input_schema: {
      type: 'object' as const,
      properties: {
        chatId: {
          type: 'string',
          description: 'Telegram chat ID (numeric string, negative for groups)',
        },
        name: { type: 'string', description: 'Display name for this chat' },
        isGroup: { type: 'boolean', description: 'Whether this is a group / channel (vs a DM)' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional topic tags (e.g. ["#ops", "#deposits"])',
        },
      },
      required: ['chatId', 'name'],
    },
  },
  {
    name: 'telegram_ignore_chat',
    description:
      'Permanently ignore a Telegram chat — suppresses all future discovery notifications',
    input_schema: {
      type: 'object' as const,
      properties: {
        chatId: { type: 'string', description: 'Telegram chat ID to ignore' },
      },
      required: ['chatId'],
    },
  },
  {
    name: 'telegram_list_chats',
    description: 'List all currently monitored Telegram chats',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  },
] as const;

// ─── Worker dispatch ──────────────────────────────────────────────────────────

/** Route a telegram_* tool call to its worker. Called after owner approval. */
export function executeTelegramTool(tool: string, input: Record<string, unknown>): WorkerResult {
  switch (tool) {
    case 'telegram_add_chat':
      return executeAddChat(input);
    case 'telegram_ignore_chat':
      return executeIgnoreChat(input);
    case 'telegram_list_chats':
      return executeListChats();
    default:
      return { success: false, output: `Unknown telegram tool: ${tool}`, dryRun: false };
  }
}

// ─── Workers ──────────────────────────────────────────────────────────────────

function executeAddChat(input: Record<string, unknown>): WorkerResult {
  const chatId = String(input.chatId ?? '');
  const name = String(input.name ?? chatId);
  const isGroup = Boolean(input.isGroup ?? chatId.startsWith('-'));
  const tags = Array.isArray(input.tags) ? (input.tags as string[]) : [];

  if (!chatId) {
    return { success: false, output: 'telegram_add_chat: chatId is required', dryRun: false };
  }

  addMonitoredChat(chatId, name, isGroup, tags);

  return {
    success: true,
    dryRun: false,
    output: `Chat "${name}" (${chatId}) added — messages will now be processed`,
    data: { chatId, name, isGroup, tags },
  };
}

function executeIgnoreChat(input: Record<string, unknown>): WorkerResult {
  const chatId = String(input.chatId ?? '');

  if (!chatId) {
    return { success: false, output: 'telegram_ignore_chat: chatId is required', dryRun: false };
  }

  ignoreChat(chatId);

  return {
    success: true,
    dryRun: false,
    output: `Chat ${chatId} ignored — no further discovery notifications`,
  };
}

function executeListChats(): WorkerResult {
  const monitoredChats = getConfig().channels.telegram.listener.monitoredChats;

  if (monitoredChats.length === 0) {
    return { success: true, dryRun: false, output: 'No monitored chats configured', data: [] };
  }

  const list = monitoredChats
    .map(
      (c: { name: string; chatId: string; isGroup: boolean; tags: string[] }) =>
        `${c.name} (${c.chatId})${c.isGroup ? ' [group]' : ''}${c.tags.length ? ' ' + c.tags.join(' ') : ''}`,
    )
    .join('\n');

  return {
    success: true,
    dryRun: false,
    output: `Monitored chats (${monitoredChats.length}):\n${list}`,
    data: monitoredChats,
  };
}
