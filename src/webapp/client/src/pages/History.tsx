import { useState, useEffect, useCallback } from 'react';
import { get } from '../api.ts';
import type { HistoryTask, HistoryProposal } from '../types.ts';

function timeAgo(ts?: number): string {
  if (!ts) return '?';
  const diff = Date.now() - ts;
  const h = Math.floor(diff / 3600000);
  if (h < 1) return 'Just now';
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function StatusBadge({ status }: { status: string }) {
  let cls = 'badge-pending';
  if (status === 'completed' || status === 'executed') cls = 'badge-approved';
  else if (status === 'rejected' || status === 'cancelled') cls = 'badge-rejected';
  else if (status === 'partial' || status === 'follow_up') cls = 'badge-medium';

  return (
    <span className={cls} style={{ fontSize: '0.55rem' }}>
      {status.replace('_', ' ').toUpperCase()}
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
    return (
      <div className="flex items-center justify-center py-16">
        <span className="label-mono">Loading...</span>
      </div>
    );
  }

  const isEmpty = tasks.length === 0 && proposals.length === 0;
  if (isEmpty) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-3">
        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="rgba(79,110,255,0.25)" strokeWidth={1}>
          <path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <span className="label-mono" style={{ color: 'rgba(79,110,255,0.4)' }}>No History Yet</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {tasks.length > 0 && (
        <div>
          <div className="label-mono mb-2.5">Completed Tasks</div>
          <div
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: '8px',
              overflow: 'hidden',
              boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
            }}
          >
            {tasks.map((t, idx) => (
              <div
                key={t.id}
                style={{
                  padding: '0.75rem 1rem',
                  borderBottom: idx < tasks.length - 1 ? '1px solid var(--border)' : 'none',
                  transition: 'background 0.15s ease',
                  cursor: 'default',
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLDivElement).style.background = 'rgba(79,110,255,0.04)';
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLDivElement).style.background = 'transparent';
                }}
              >
                <p
                  className="text-sm leading-snug mb-1.5"
                  style={{ color: '#f0f4ff', fontFamily: "'Inter', sans-serif" }}
                >
                  {t.title}
                </p>
                <div className="flex items-center gap-2 flex-wrap">
                  <StatusBadge status={t.status} />
                  {t.partner_name && (
                    <span
                      style={{
                        fontFamily: "'Inter', sans-serif",
                        fontSize: '0.75rem',
                        color: 'var(--text2)',
                      }}
                    >
                      {t.partner_name}
                    </span>
                  )}
                  {t.assigned_team && (
                    <span
                      style={{
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: '0.6rem',
                        color: '#7b96ff',
                        letterSpacing: '0.04em',
                      }}
                    >
                      {t.assigned_team}
                    </span>
                  )}
                  <span
                    style={{
                      marginLeft: 'auto',
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: '0.6rem',
                      color: 'var(--text2)',
                      letterSpacing: '0.04em',
                    }}
                  >
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
          <div className="label-mono mb-2.5">Executed Proposals</div>
          <div
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: '8px',
              overflow: 'hidden',
              boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
            }}
          >
            {proposals.map((p, idx) => (
              <div
                key={p.id}
                style={{
                  padding: '0.75rem 1rem',
                  borderBottom: idx < proposals.length - 1 ? '1px solid var(--border)' : 'none',
                  transition: 'background 0.15s ease',
                  cursor: 'default',
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLDivElement).style.background = 'rgba(79,110,255,0.04)';
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLDivElement).style.background = 'transparent';
                }}
              >
                <p
                  className="text-sm leading-snug mb-1.5"
                  style={{ color: '#f0f4ff', fontFamily: "'Inter', sans-serif" }}
                >
                  {p.context_summary}
                </p>
                {p.rejection_reason && (
                  <p
                    className="text-xs mb-1.5"
                    style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: '0.65rem',
                      color: '#ef4444',
                      letterSpacing: '0.04em',
                    }}
                  >
                    Reason: {p.rejection_reason}
                  </p>
                )}
                <div className="flex items-center gap-2">
                  <StatusBadge status={p.status} />
                  <span
                    style={{
                      marginLeft: 'auto',
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: '0.6rem',
                      color: 'var(--text2)',
                      letterSpacing: '0.04em',
                    }}
                  >
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
