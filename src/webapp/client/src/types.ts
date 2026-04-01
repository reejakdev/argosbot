export interface ProposalAction {
  description: string;
  details?: string;
  risk: 'low' | 'medium' | 'high';
  tool?: string;
}

export interface Proposal {
  id: string;
  context_summary: string;
  plan: string;
  actions: ProposalAction[];
  draft_reply?: string;
  status: string;
  created_at: number;
  expires_at: number;
  expiresInMin: number;
}

export interface Task {
  id: string;
  title: string;
  description?: string;
  category?: string;
  partner_name?: string;
  chat_id?: string;
  assigned_team?: string;
  is_my_task?: number;
  status: string;
  statusLabel?: string;
  created_at: number;
  source: 'task' | 'proposal';
}

export interface Memory {
  id: string;
  content: string;
  tags: string[];
  category?: string;
  partner_name?: string;
  importance: number;
  archived: number;
  expires_at?: number;
  created_at: number;
}

export interface HistoryTask {
  id: string;
  title: string;
  category?: string;
  partner_name?: string;
  assigned_team?: string;
  status: string;
  detected_at: number;
  completed_at?: number;
}

export interface HistoryProposal {
  id: string;
  context_summary: string;
  plan: string;
  actions: ProposalAction[];
  status: string;
  created_at: number;
  approved_at?: number;
  executed_at?: number;
  rejection_reason?: string;
}

export interface StatusData {
  owner: string;
  teams: string[];
  readOnly: boolean;
  tasks: { open: number; mine: number };
  proposals: { pending: number };
  memories: { active: number };
}

export interface WSEvent {
  event: string;
  data?: unknown;
  ts: number;
}
