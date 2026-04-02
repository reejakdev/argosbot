import { useState, useEffect, useCallback } from 'react';
import { get, post, ApiError } from '../api.ts';
import type { Task } from '../types.ts';
import { useToast } from '../components/Toast.tsx';
import { useWebSocket } from '../hooks/useWebSocket.ts';

type Filter = 'all' | 'mine' | 'history';

function statusDotClass(status: string): string {
  switch (status) {
    case 'open': return 'status-dot-cyan';
    case 'in_progress': return 'status-dot-yellow';
    case 'completed':
    case 'executed': return 'status-dot-green';
    case 'rejected':
    case 'cancelled': return 'status-dot-red';
    default: return 'status-dot-muted';
  }
}

function statusColor(status: string): string {
  switch (status) {
    case 'open': return '#4f6eff';
    case 'in_progress': return '#f59e0b';
    case 'completed':
    case 'executed': return '#10b981';
    case 'rejected':
    case 'cancelled': return '#ef4444';
    default: return 'var(--text2)';
  }
}

function statusLabel(t: Task): string {
  if (t.statusLabel) return t.statusLabel;
  switch (t.status) {
    case 'open': return 'Open';
    case 'in_progress': return 'In Progress';
    case 'proposed': return 'Pending Approval';
    case 'approved': return 'Executing';
    case 'executed': return 'Done';
    case 'partial': return 'Partial';
    case 'rejected': return 'Rejected';
    default: return t.status.replace('_', ' ');
  }
}

export default function Tasks() {
  const { toast } = useToast();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (f: Filter) => {
    setLoading(true);
    try {
      const data = await get<Task[]>(`/tasks?filter=${f}`);
      setTasks(data);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { void load(filter); }, [filter, load]);

  useWebSocket({
    onMessage: (e) => {
      if (e.event === 'task_updated') void load(filter);
    },
  });

  async function complete(id: string) {
    try {
      await post(`/tasks/${id}/complete`);
      setTasks((prev) => prev.filter((t) => t.id !== id));
      toast('Task completed');
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Failed');
    }
  }

  const FILTERS: { id: Filter; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'mine', label: 'Mine' },
    { id: 'history', label: 'History' },
  ];

  return (
    <div>
      {/* Filter row */}
      <div className="flex gap-2 mb-4">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            style={{
              fontFamily: "'Inter', sans-serif",
              fontSize: '0.8125rem',
              fontWeight: filter === f.id ? 600 : 400,
              padding: '0.375rem 0.875rem',
              background: filter === f.id ? 'rgba(79,110,255,0.08)' : 'transparent',
              color: filter === f.id ? '#7b96ff' : 'var(--text2)',
              border: `1px solid ${filter === f.id ? 'rgba(79,110,255,0.35)' : 'var(--border)'}`,
              borderRadius: '6px',
              cursor: 'pointer',
              transition: 'all 0.15s ease',
              outline: 'none',
            }}
          >
            {f.label}
          </button>
        ))}
      </div>

      {loading && (
        <div className="flex items-center justify-center py-16">
          <span className="label-mono">Loading...</span>
        </div>
      )}

      {!loading && tasks.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 gap-3">
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="rgba(79,110,255,0.25)" strokeWidth={1}>
            <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
          </svg>
          <span className="label-mono" style={{ color: 'rgba(79,110,255,0.4)' }}>No Tasks</span>
        </div>
      )}

      {!loading && tasks.length > 0 && (
        <div className="flex flex-col gap-2">
          {tasks.map((t) => (
            <div
              key={t.id}
              style={{
                background: '#f5f5f5',
                border: '1px solid #e5e7eb',
                borderRadius: '8px',
                padding: '0.75rem 1rem',
                transition: 'background 0.15s ease',
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLDivElement).style.background = '#f5f5f5';
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLDivElement).style.background = '#f5f5f5';
              }}
            >
              <div className="flex items-start gap-3">
                {/* Status dot / complete button */}
                <div className="flex-shrink-0 mt-1">
                  {t.source === 'task' && (t.status === 'open' || t.status === 'in_progress') ? (
                    <button
                      onClick={() => void complete(t.id)}
                      title="Mark complete"
                      style={{
                        width: 16,
                        height: 16,
                        borderRadius: '50%',
                        border: '1.5px solid rgba(79,110,255,0.4)',
                        background: 'transparent',
                        cursor: 'pointer',
                        padding: 0,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        transition: 'all 0.15s',
                        outline: 'none',
                      }}
                    />
                  ) : (
                    <span className={`status-dot ${statusDotClass(t.status)}`} style={{ marginTop: 4 }} />
                  )}
                </div>

                <div className="flex-1 min-w-0">
                  <p
                    className="text-sm leading-snug mb-1.5"
                    style={{
                      fontFamily: "'Inter', sans-serif",
                      color: t.is_my_task ? '#7b96ff' : '#f0f4ff',
                      fontWeight: t.is_my_task ? 500 : 400,
                    }}
                  >
                    {t.title}
                  </p>

                  <div className="flex gap-2 flex-wrap items-center">
                    <span
                      style={{
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: '0.6rem',
                        fontWeight: 700,
                        letterSpacing: '0.06em',
                        color: statusColor(t.status),
                      }}
                    >
                      {statusLabel(t)}
                    </span>

                    {t.partner_name && (
                      <>
                        <span style={{ color: 'var(--border)', fontSize: '0.7rem' }}>·</span>
                        <span
                          style={{
                            fontFamily: "'Inter', sans-serif",
                            fontSize: '0.75rem',
                            color: 'var(--text2)',
                          }}
                        >
                          {t.partner_name}
                        </span>
                      </>
                    )}

                    {t.assigned_team && (
                      <>
                        <span style={{ color: 'var(--border)', fontSize: '0.7rem' }}>·</span>
                        <span
                          style={{
                            fontFamily: "'JetBrains Mono', monospace",
                            fontSize: '0.6rem',
                            fontWeight: 700,
                            letterSpacing: '0.06em',
                            color: '#7b96ff',
                            background: 'rgba(79,110,255,0.08)',
                            border: '1px solid rgba(79,110,255,0.2)',
                            borderRadius: '4px',
                            padding: '0.1rem 0.4rem',
                            textTransform: 'uppercase',
                          }}
                        >
                          {t.assigned_team}
                        </span>
                      </>
                    )}

                    {t.category && (
                      <>
                        <span style={{ color: 'var(--border)', fontSize: '0.7rem' }}>·</span>
                        <span
                          style={{
                            fontFamily: "'JetBrains Mono', monospace",
                            fontSize: '0.6rem',
                            color: 'rgba(123,150,255,0.6)',
                            letterSpacing: '0.04em',
                          }}
                        >
                          {t.category}
                        </span>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
