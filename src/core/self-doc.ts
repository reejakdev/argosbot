/**
 * argos-self.md generator.
 *
 * Produces a live snapshot of Argos's current configuration and capabilities,
 * written to ~/.argos/argos-self.md at every boot.
 *
 * Indexed into the knowledge store so Argos can:
 *   - Answer questions about its own configuration
 *   - Suggest features/commands the user hasn't tried yet
 *   - Propose config changes via edit_config that match actual schema
 *
 * Secrets (API keys, tokens) are NEVER written — only structural config.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os   from 'node:os';
import { createLogger } from '../logger.js';
import type { Config } from '../config/schema.js';

const log = createLogger('self-doc');

export function generateSelfDoc(config: Config): string {
  const lines: string[] = [];

  const push = (...l: string[]) => lines.push(...l);
  const h2   = (t: string) => push('', `## ${t}`, '');
  const item = (label: string, value: string | boolean | number) =>
    push(`- **${label}**: ${String(value)}`);

  push('# Argos — System Self-Description', '');
  push('> Auto-generated at boot. Do not edit manually.');
  push(`> Last updated: ${new Date().toISOString()}`, '');

  push('Argos is your local-first AI assistant for daily operations.');
  push('It observes messages, classifies them, proposes actions, and executes only after your explicit approval.');
  push('');

  // ─── Identity ──────────────────────────────────────────────────────────────
  h2('Identity');
  item('Owner name', config.owner.name);
  item('Primary model', config.llm.activeModel);
  item('Provider', config.llm.activeProvider);
  if (config.privacy.provider) {
    item('Privacy model', config.privacy.model ?? 'default');
    item('Privacy provider', config.privacy.provider);
  }
  item('Read-only mode', config.readOnly ?? false);

  // ─── Active channels ───────────────────────────────────────────────────────
  h2('Active Channels');
  push('Channels Argos is currently configured to monitor:');
  push('');

  const tg = config.channels.telegram;
  if (tg?.listener?.mode === 'mtproto') {
    push(`- **Telegram MTProto listener** (user account): monitors ${tg.listener.monitoredChats?.length ?? 0} chat(s)`);
    if (tg.listener.monitoredChats?.length) {
      for (const c of tg.listener.monitoredChats) {
        push(`  - ${c.name} (${c.chatId})${c.isGroup ? ' [group]' : ''}`);
      }
    }
  }
  if (tg?.personal?.botToken) {
    push(`- **Telegram personal bot**: active — approval chat: ${tg.personal.approvalChatId ?? 'me'}`);
  }

  const slack = config.channels.slack;
  if (slack?.enabled) {
    push(`- **Slack user-token listener**: active — monitors ${slack.monitoredChannels?.length ?? 0} explicit channel(s)${slack.monitorDMs ? ' + DMs' : ''}`);
  }
  if (slack?.personal?.botToken) {
    push(`- **Slack personal bot**: active — approval channel: ${slack.personal.approvalChannelId ?? 'not set'}`);
  }

  const discord = config.channels.discord;
  if (discord?.enabled) {
    push(`- **Discord listener**: active — ${discord.monitoredChannels?.length ?? 0} channel(s), ${discord.monitoredGuildIds?.length ?? 0} guild(s)`);
  }

  if (!tg?.listener?.mode && !slack?.enabled && !discord?.enabled) {
    push('- No channels currently configured. Run `npm run setup` to add channels.');
  }

  // ─── Owner interaction bot commands ────────────────────────────────────────
  h2('Owner Bot Commands');
  push('When chatting with Argos via the personal bot (Telegram or Slack):');
  push('');
  push('### Proposals & Approvals');
  push('- `/proposals` — list pending proposals waiting for your approval');
  push('- `/approve <id>` — approve and execute a proposal');
  push('- `/reject <id> [reason]` — reject a proposal');
  push('');
  push('### Operational');
  push('- `/tasks` — open and in-progress tasks');
  push('- `/status` — system overview (pending proposals, open tasks, memory count)');
  push('- `/memory [query]` — search recent memories');
  push('');
  push('### Conversation');
  push('- Just type freely — Argos will answer using its LLM + your memories + knowledge base');
  push('- `/clear` — reset conversation history');
  push('- `/compact` (Telegram) — summarize conversation to save tokens');
  push('');
  push('### Config self-modification (via approval)');
  push('- Ask: "Add @alice_telegram to monitored chats" → Argos proposes an `edit_config` action → you approve');
  push('- Ask: "Enable heartbeat every 30 minutes" → same flow');
  push('- Ask: "What channels am I monitoring?" → instant answer from this document');

  // ─── Pipeline ──────────────────────────────────────────────────────────────
  h2('Processing Pipeline');
  push('Every incoming message flows through:');
  push('');
  push('1. **Injection sanitizer** — regex fast-screen + LLM deep scan for prompt injection');
  push('2. **Anonymizer** — replaces PII/crypto with placeholders before anything reaches the LLM');
  push('3. **Context window** — batches related messages (up to 5, 30s timer)');
  push('4. **Classifier** — assigns category, urgency, importance, team');
  push('5. **Memory store** — saves anonymized summary to SQLite + vector index');
  push('6. **Planner** — generates proposals (draft_reply, calendar, notion, tx_prep, etc.)');
  push('7. **Approval gateway** — sends proposals to you for review');
  push('8. **Workers** — execute only after your explicit approval');

  // ─── Task categories ───────────────────────────────────────────────────────
  h2('Message Categories');
  push('The classifier assigns one of these categories to each message window:');
  push('');
  push('| Category | Meaning | Creates task? |');
  push('|----------|---------|---------------|');
  push('| `tx_request` | Financial/crypto transfer request | Yes (high urgency) |');
  push('| `client_request` | KYC, compliance, onboarding | Yes |');
  push('| `task` | Actionable work item | Yes |');
  push('| `reminder` | Time-sensitive follow-up | Yes |');
  push('| `info` | Informational, no action needed | No |');
  push('| `ignore` | Noise, irrelevant | No |');

  // ─── Planner tools ─────────────────────────────────────────────────────────
  h2('Available Proposal Actions (Planner Tools)');
  push('When the planner detects something requiring action, it can propose:');
  push('');
  push('| Tool | Description | Requires approval |');
  push('|------|-------------|-------------------|');
  push('| `draft_reply` | Draft a message reply | Yes |');
  push('| `create_calendar_event` | Add to Google Calendar | Yes |');
  push('| `create_notion_entry` | Create Notion page/entry | Auto (owner workspace) |');
  push('| `prepare_tx_pack` | Transaction review document | Yes |');
  push('| `create_task` | Create a task in Argos | Auto |');
  push('| `set_reminder` | Schedule a reminder | Auto |');
  push('| `create_cron_job` | Schedule a recurring job | Yes |');
  push('| `edit_config` | Modify Argos configuration | Yes |');
  push('| `send_email` | Send an email via SMTP | Yes |');
  push('| `add_knowledge_source` | Add a new knowledge source | Yes |');

  // ─── Memory ────────────────────────────────────────────────────────────────
  h2('Memory System');
  item('Default TTL', `${config.memory?.defaultTtlDays ?? 30} days`);
  item('Archive TTL', `${config.memory?.archiveTtlDays ?? 365} days`);
  item('Auto-archive threshold (importance)', config.memory?.autoArchiveThreshold ?? 8);
  push('');
  push('Memories are stored in SQLite with FTS5 full-text search + LanceDB for semantic (vector) search.');
  push('Conversations from the last 30 days are vectorized per chat — each chat is isolated (no cross-chat bleed).');

  // ─── Triage ────────────────────────────────────────────────────────────────
  if (config.triage?.enabled) {
    h2('Triage');
    item('Enabled', true);
    item('Mention-only mode', config.triage.mentionOnly ?? false);
    item('Ignore own team', config.triage.ignoreOwnTeam ?? true);
    if (config.triage.watchedTeams?.length) {
      push('');
      push('**Watched teams:**');
      for (const t of config.triage.watchedTeams) {
        push(`- ${t.name}${t.isOwnTeam ? ' [internal]' : ''}`);
      }
    }
  }

  // ─── Knowledge sources ─────────────────────────────────────────────────────
  if (config.knowledge?.sources?.length) {
    h2('Knowledge Sources');
    push('Documents Argos has indexed (in vector store + FTS5):');
    push('');
    for (const s of config.knowledge.sources) {
      const type = s.type;
      const name = ('name' in s && s.name) ? String(s.name) : type;
      push(`- **${name}** [${type}] — refresh: ${('refreshHours' in s ? s.refreshHours : 24)}h`);
    }
  }

  // ─── Heartbeat ─────────────────────────────────────────────────────────────
  if (config.heartbeat?.enabled) {
    h2('Heartbeat');
    item('Enabled', true);
    item('Interval', `${config.heartbeat.intervalMinutes ?? 60} minutes`);
    if (config.heartbeat.prompt) {
      item('Prompt', config.heartbeat.prompt.slice(0, 100));
    }
  }

  // ─── Skills ────────────────────────────────────────────────────────────────
  if (config.skills?.length) {
    h2('Enabled Skills');
    for (const s of config.skills) {
      push(`- ${typeof s === 'string' ? s : (s as { name: string }).name}`);
    }
  }

  // ─── Self-modification ─────────────────────────────────────────────────────
  h2('Config Self-Modification (edit_config)');
  push('Argos can propose changes to its own configuration via the `edit_config` worker action.');
  push('All changes require your explicit approval before being applied.');
  push('');
  push('**Safe paths (auto-approved after owner confirms):**');
  push('- `channels.telegram.listener.monitoredChats` — add/remove monitored chats');
  push('- `channels.telegram.listener.ignoredChats` — ignore a chat');
  push('- `triage.*` — triage configuration');
  push('- `heartbeat.*` — heartbeat schedule and prompt');
  push('- `memory.*` — TTL settings');
  push('- `knowledge.sources` — add/remove knowledge sources');
  push('- `owner.name`, `owner.teams`, `owner.roles` — owner identity');
  push('');
  push('**Always requires elevated approval (YubiKey):**');
  push('- `secrets.*` — API keys and tokens');
  push('- `channels.*.botToken`, `channels.*.userToken` — channel credentials');
  push('- `llm.*` — model configuration');
  push('- `approval.*` — approval gateway settings');

  // ─── Web app ───────────────────────────────────────────────────────────────
  h2('Web Dashboard');
  push('Available at the configured host (default: http://localhost:3000).');
  push('Secured with WebAuthn (YubiKey) + TOTP backup.');
  push('Provides: proposal approval (with elevated auth for high-risk), task list, memory browser, history.');

  return lines.join('\n');
}

// ─── Write to disk ────────────────────────────────────────────────────────────

export function writeSelfDoc(config: Config): void {
  try {
    const dataDir = process.env.DATA_DIR ?? path.join(os.homedir(), '.argos');
    mkdirSync(dataDir, { recursive: true });
    const filePath = path.join(dataDir, 'argos-self.md');
    const content  = generateSelfDoc(config);
    writeFileSync(filePath, content, { mode: 0o600 });
    log.info(`Self-doc written: ${filePath} (${content.length} chars)`);
  } catch (e) {
    log.warn(`Failed to write argos-self.md: ${e}`);
  }
}
