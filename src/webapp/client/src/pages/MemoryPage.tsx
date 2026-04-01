import { useState, useEffect, useCallback } from 'react';
import { get } from '../api.ts';
import type { Memory } from '../types.ts';

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const h = Math.floor(diff / 3600000);
  if (h < 1) return 'just now';
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export default function MemoryPage() {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const data = await get<Memory[]>('/memories');
      setMemories(data);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (loading) {
    return <div className="text-center py-10 text-sm" style={{ color: 'var(--muted)' }}>Loading…</div>;
  }

  if (memories.length === 0) {
    return <div className="text-center py-10 text-sm" style={{ color: 'var(--muted)' }}>No memories yet</div>;
  }

  return (
    <div>
      {memories.map((m) => (
        <div
          key={m.id}
          className="py-3 border-b"
          style={{ borderColor: 'var(--border)' }}
        >
          <p className="text-sm leading-relaxed">{m.content}</p>

          {/* Importance bar */}
          <div className="h-0.5 rounded-full mt-1.5 mb-1.5" style={{ background: 'var(--border)' }}>
            <div
              className="h-full rounded-full"
              style={{ width: `${(m.importance / 10) * 100}%`, background: 'var(--accent)' }}
            />
          </div>

          <div className="flex gap-2 flex-wrap">
            <span className="text-xs" style={{ color: 'var(--muted)' }}>
              imp:{m.importance}
            </span>
            {m.partner_name && (
              <span className="text-xs" style={{ color: 'var(--muted)' }}>{m.partner_name}</span>
            )}
            {m.category && (
              <span className="text-xs" style={{ color: 'var(--muted)' }}>· {m.category}</span>
            )}
            {m.archived === 1 && (
              <span className="text-xs" style={{ color: 'var(--yellow)' }}>· archived</span>
            )}
            <span className="text-xs" style={{ color: 'var(--muted)' }}>· {timeAgo(m.created_at)}</span>
          </div>

          {m.tags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {m.tags.map((tag) => (
                <span
                  key={tag}
                  className="text-xs px-1.5 py-0.5 rounded"
                  style={{ background: 'rgba(37,99,235,0.1)', color: 'var(--accent)' }}
                >
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
