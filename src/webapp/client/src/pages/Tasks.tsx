import { useState, useEffect, useCallback } from 'react';
import { get, post, ApiError } from '../api.ts';
import type { Task } from '../types.ts';
import { useToast } from '../components/Toast.tsx';
import { useWebSocket } from '../hooks/useWebSocket.ts';

type Filter = 'all' | 'mine' | 'history';

function statusLabel(t: Task): string {
  if (t.statusLabel) return t.statusLabel;
  switch (t.status) {
    case 'open': return '● Open';
    case 'in_progress': return '● In Progress';
    case 'proposed': return '⏳ Pending approval';
    case 'approved': return '🔄 Executing…';
    case 'executed': return '✅ Done';
    case 'partial': return '⚠️ Partial';
    case 'rejected': return '❌ Rejected';
    default: return t.status;
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
    { id: 'mine', label: 'Mine 👤' },
    { id: 'history', label: 'History 📜' },
  ];

  return (
    <div>
      {/* Filter row */}
      <div className="flex gap-2 mb-3">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            className="px-3 py-1.5 rounded-full text-xs border transition-all"
            style={{
              background: filter === f.id ? 'var(--accent)' : 'transparent',
              color: filter === f.id ? '#fff' : 'var(--muted)',
              borderColor: filter === f.id ? 'var(--accent)' : 'var(--border)',
            }}
          >
            {f.label}
          </button>
        ))}
      </div>

      {loading && <div className="text-center py-10 text-sm" style={{ color: 'var(--muted)' }}>Loading…</div>}

      {!loading && tasks.length === 0 && (
        <div className="text-center py-10 text-sm" style={{ color: 'var(--muted)' }}>No tasks</div>
      )}

      {!loading && tasks.length > 0 && (
        <div>
          {tasks.map((t) => (
            <div
              key={t.id}
              className="flex items-start gap-2.5 py-3 border-b"
              style={{ borderColor: 'var(--border)' }}
            >
              {/* Complete button (only for real tasks in open/in_progress) */}
              {t.source === 'task' && (t.status === 'open' || t.status === 'in_progress') && (
                <button
                  onClick={() => void complete(t.id)}
                  className="w-5 h-5 rounded-full border-2 flex-shrink-0 mt-0.5 transition-colors active:bg-green-600"
                  style={{ borderColor: 'var(--border)', background: 'transparent' }}
                  title="Mark complete"
                />
              )}

              {t.source !== 'task' && <div className="w-5 flex-shrink-0" />}

              <div className="flex-1 min-w-0">
                <p
                  className="text-sm leading-snug"
                  style={{ color: t.is_my_task ? 'var(--accent)' : 'var(--text)' }}
                >
                  {t.title}
                </p>
                <div className="flex gap-1.5 mt-1 flex-wrap">
                  {t.partner_name && (
                    <span className="text-xs" style={{ color: 'var(--muted)' }}>{t.partner_name}</span>
                  )}
                  {t.assigned_team && (
                    <span className="text-xs" style={{ color: 'var(--muted)' }}>· {t.assigned_team}</span>
                  )}
                  <span className="text-xs" style={{ color: 'var(--muted)' }}>
                    · {statusLabel(t)}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
