// ─── Shared domain types ──────────────────────────────────────────────────────

export type MessageSource = 'telegram' | 'whatsapp' | 'email' | 'calendar' | 'notion' | 'github';

export type MessageCategory =
  | 'task'
  | 'reminder'
  | 'client_request'
  | 'tx_request'
  | 'info'
  | 'ignore';

export type TaskStatus =
  | 'open'
  | 'in_progress'
  | 'follow_up'
  | 'done_inferred'   // completion signals detected but not explicitly confirmed
  | 'completed'
  | 'cancelled';

/** How confident the classifier is that a task was completed implicitly */
export type CompletionSignal = 'none' | 'weak' | 'medium' | 'strong';

/** Ownership scope — who this message concerns */
export type TaskScope = 'my_task' | 'team_task' | 'info_only';

export type ProposalStatus =
  | 'proposed'
  | 'awaiting_approval'
  | 'approved'
  | 'rejected'
  | 'executed'
  | 'expired';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export type WorkerType =
  | 'reply'
  | 'calendar'
  | 'notion'
  | 'linear'
  | 'scheduler';

// ─── Raw message as received from source ─────────────────────────────────────
export interface RawMessage {
  id:           string;

  // ─── Channel identity ────────────────────────────────────────────────────
  /** Channel adapter identifier — 'telegram' | 'slack' | 'discord' | 'gmail' | ... */
  channel:      string;
  /** @deprecated use channel */
  source:       MessageSource;

  // ─── Chat ────────────────────────────────────────────────────────────────
  chatId:       string;
  /** Human name of the chat/channel (from config or resolved by the adapter) */
  chatName?:    string;
  chatType?:    'dm' | 'group' | 'channel' | 'thread';

  // ─── Sender ──────────────────────────────────────────────────────────────
  senderId?:    string;
  senderName?:  string;
  /** Partner display name resolved from monitoredChats config */
  partnerName?: string;

  // ─── Content ─────────────────────────────────────────────────────────────
  /** Raw text — NEVER log / store / send to LLM without anonymization */
  content:      string;
  /** Set by the privacy layer after anonymization — safe to store and forward */
  anonText?:    string;

  // ─── Links & media ───────────────────────────────────────────────────────
  /** Permalink to the original message (channels/groups only — no link for DMs) */
  messageUrl?:  string;
  /** URLs extracted from message content and/or media captions */
  links:        string[];
  isForward?:   boolean;
  /** Display name of the original source if forwarded */
  forwardFrom?: string;
  mediaType?:   'photo' | 'video' | 'document' | 'audio' | 'sticker' | 'voice';

  // ─── Threading ───────────────────────────────────────────────────────────
  replyToId?:   string;
  threadId?:    string;

  // ─── Timestamps ──────────────────────────────────────────────────────────
  /** When Argos received the message (unix ms) */
  receivedAt:   number;
  /** Original send time from the channel (unix ms) — may differ from receivedAt */
  timestamp?:   number;

  // ─── Channel-specific extras ─────────────────────────────────────────────
  /** Adapter-specific extras — e.g. Telegram message_id, Slack ts, Discord guild_id */
  meta?:        Record<string, unknown>;
}

// ─── After anonymization ──────────────────────────────────────────────────────
export interface SanitizedMessage {
  id:           string;
  originalId:   string;
  /** Channel adapter identifier — carried from RawMessage */
  channel?:     string;
  chatId:       string;
  chatName?:    string;
  chatType?:    RawMessage['chatType'];
  /** NOT anonymized — partner name is not confidential per design */
  partnerName?: string;
  /** Anonymized content — safe to store and forward to LLM */
  content:      string;
  /** placeholder → real value — exists only in local memory, never sent to LLM */
  lookupTable:  Record<string, string>;
  /** URLs extracted from message — carried through for planner use (fetch-url skill) */
  links:        string[];
  /** Message permalink — for audit trail and quick reference */
  messageUrl?:  string;
  isForward?:   boolean;
  forwardFrom?: string;
  mediaType?:   RawMessage['mediaType'];
  /** Original send time from the channel (unix ms) */
  timestamp?:   number;
  receivedAt:   number;
}

// ─── Context window: batch of messages from same chat ─────────────────────────
export interface ContextWindow {
  id:               string;
  /** Channel adapter identifier — derived from messages[0].channel */
  channel?:         string;
  chatId:           string;
  chatName?:        string;
  partnerName?:     string;
  /** Messages in this batch (the new incoming ones) */
  messages:         SanitizedMessage[];
  /** Recent messages from the same chat BEFORE this window opened (read-only context) */
  previousMessages: SanitizedMessage[];
  /**
   * Raw (pre-anonymization) content — only populated when privacy.storeRaw=true.
   * NEVER send to cloud LLM. Local/privacy LLM only.
   */
  rawContent?:      string;
  openedAt:         number;
  closedAt?:        number;
  status:           'open' | 'processing' | 'done';
}

// ─── Classification result from Claude ───────────────────────────────────────
export interface ClassificationResult {
  category: MessageCategory;
  /** Backward-compat: true when taskScope === 'my_task' */
  isMyTask: boolean;
  /** Structured ownership — replaces the isMyTask boolean long-term */
  taskScope: TaskScope;
  /** 0–1 confidence that isMyTask/taskScope is correct */
  ownerConfidence: number;
  assignedTeam: string | null;
  importance: number;            // 0–10
  tags: string[];
  summary: string;               // 1–2 sentence anonymized summary
  completedTaskIds: string[];    // IDs of previously tracked tasks now done
  /** Strength of implicit completion signal detected in conversation */
  completionSignal: CompletionSignal;
  /** True when this window likely matches an already-open task (skip re-creation) */
  isDuplicate: boolean;
  requiresAction: boolean;
  urgency: 'low' | 'medium' | 'high';
  injectionDetected: boolean;    // prompt injection flag
  injectionReason?: string;
}

// ─── Memory entry ─────────────────────────────────────────────────────────────
export interface MemoryEntry {
  id:           string;
  content:      string;          // anonymized summary
  tags:         string[];
  category:     MessageCategory;
  sourceRef:    string;          // reference to source context window id
  channel?:     string;          // originating channel adapter
  partnerName?: string;
  chatId?:      string;
  importance:   number;
  archived:     boolean;
  expiresAt:    number | null;   // null = permanent
  createdAt:    number;
  /**
   * Raw (pre-anonymization) content — only present when privacy.storeRaw=true
   * AND the caller explicitly requested it (includeRaw=true).
   * NEVER pass to cloud LLM.
   */
  rawContent?:  string;
}

// ─── Task ─────────────────────────────────────────────────────────────────────
export interface Task {
  id: string;
  title: string;
  description?: string;
  category: MessageCategory;
  sourceRef: string;
  partnerName?: string;
  chatId?: string;
  assignedTeam?: string;
  isMyTask: boolean;
  status: TaskStatus;
  completedAt?: number;
  detectedAt: number;
  expiresAt?: number;
}

// ─── Action inside a proposal ─────────────────────────────────────────────────
export interface ProposedAction {
  type: WorkerType;
  description: string;           // human-readable
  risk: 'low' | 'medium' | 'high';
  payload: Record<string, unknown>;
  requiresApproval: boolean;
  waitFor?: string[];            // condition keys that must be met first
}

// ─── Full proposal from planner ──────────────────────────────────────────────
export interface Proposal {
  id: string;
  taskId?: string;
  contextSummary: string;
  plan: string;                  // Claude's reasoning
  actions: ProposedAction[];
  draftReply?: string;
  status: ProposalStatus;
  createdAt: number;
  approvedAt?: number;
  executedAt?: number;
  expiresAt: number;
  rejectionReason?: string;
}

// ─── Approval request ─────────────────────────────────────────────────────────
export interface ApprovalRequest {
  id: string;
  proposalId: string;
  telegramMessageId?: number;
  status: ApprovalStatus;
  createdAt: number;
  respondedAt?: number;
  expiresAt: number;
}

// ─── Cron job ─────────────────────────────────────────────────────────────────
export interface CronJob {
  id: string;
  name: string;
  schedule: string;              // cron expression
  handler: string;               // handler name in registry
  config: Record<string, unknown>;
  enabled: boolean;
  lastRun?: number;
  nextRun?: number;
  createdAt: number;
}

// ─── Event for multi-step chaining ───────────────────────────────────────────
export interface ChainEvent {
  key: string;                   // e.g. 'approval_abc123', 'calendar_free'
  payload?: Record<string, unknown>;
  emittedAt: number;
}

// ─── Audit log entry ──────────────────────────────────────────────────────────
export interface AuditEntry {
  id: string;
  eventType: string;
  entityId?: string;
  entityType?: string;
  data?: Record<string, unknown>;
  createdAt: number;
}
