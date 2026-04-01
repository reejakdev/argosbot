import { useState, useEffect, useCallback } from 'react';
import { get } from '../api.ts';
import type { HistoryTask, HistoryProposal } from '../types.ts';

function timeAgo(ts?: number): string {
  if (!ts) return '?';
  const diff = Date.now() - ts;
  const h = Math.floor(diff / 3600000);
  if (h < 1) return 'just now';
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const STATUS_STYLES: Record<string, { bg: string; color: string }> = {
  completed:  { bg: '#14532d', color: '#86efac' },
  executed:   { bg: '#1e3a5f', color: '#93c5fd' },
  partial:    { bg: '#713f12', color: '#fde68a' },
  rejected:   { bg: '#7f1d1d', color: '#fca5a5' },
  expired:    { bg: '#292524', color: '#a8a29e' },
  cancelled:  { bg: '#292524', color: '#a8a29e' },
  follow_up:  { bg: '#713f12', color: '#fde68a' },
};

function StatusPill({ status }: { status: string }) {
  const s = STATUS_STYLES[status] ?? { bg: 'var(--border)', color: 'var(--muted)' };
  return (
    <span className="text-xs font-semibold px-1.5 py-0.5 rounded" style={s}>
      {status.replace('_', ' ')}
    </span>
  );
}

export default function History() {
  const [tasks, setTasks] = useState<HistoryTask[]>([]);
  const [proposals, setProposals] = useState<HistoryProposal[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const data = await get<{ tasks: HistoryTask[]; proposals: HistoryProposal[] }>('/history');
      setTasks(data.tasks);
      setProposals(data.proposals);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (loading) {
    return <div className="text-center py-10 text-sm" style={{ color: 'var(--muted)' }}>Loading…</div>;
  }

  const isEmpty = tasks.length === 0 && proposals.length === 0;
  if (isEmpty) {
    return <div className="text-center py-10 text-sm" style={{ color: 'var(--muted)' }}>No history yet</div>;
  }

  return (
    <div>
      {tasks.length > 0 && (
        <div className="mb-5">
          <h3 className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--muted)' }}>
            Completed Tasks
          </h3>
          <div className="rounded-xl border overflow-hidden" style={{ borderColor: 'var(--border)' }}>
            {tasks.map((t) => (
              <div
                key={t.id}
                className="px-3 py-2.5 border-b last:border-0"
                style={{ borderColor: 'var(--border)' }}
              >
                <p className="text-sm leading-snug">{t.title}</p>
                <div className="flex gap-2 mt-1 flex-wrap items-center">
                  <StatusPill status={t.status} />
                  {t.partner_name && (
                    <span className="text-xs" style={{ color: 'var(--muted)' }}>{t.partner_name}</span>
                  )}
                  <span className="text-xs" style={{ color: 'var(--muted)' }}>
                    {timeAgo(t.completed_at ?? t.detected_at)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {proposals.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--muted)' }}>
            Executed Proposals
          </h3>
          <div className="rounded-xl border overflow-hidden" style={{ borderColor: 'var(--border)' }}>
            {proposals.map((p) => (
              <div
                key={p.id}
                className="px-3 py-2.5 border-b last:border-0"
                style={{ borderColor: 'var(--border)' }}
              >
                <p className="text-sm leading-snug">{p.context_summary}</p>
                {p.rejection_reason && (
                  <p className="text-xs mt-0.5" style={{ color: 'var(--red)' }}>
                    Reason: {p.rejection_reason}
                  </p>
                )}
                <div className="flex gap-2 mt-1 flex-wrap items-center">
                  <StatusPill status={p.status} />
                  <span className="text-xs" style={{ color: 'var(--muted)' }}>
                    {timeAgo(p.executed_at ?? p.approved_at ?? p.created_at)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
