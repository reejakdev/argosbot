import { useState, useEffect, useCallback } from 'react';
import { get } from '../api.ts';
import type { Memory } from '../types.ts';

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const h = Math.floor(diff / 3600000);
  if (h < 1) return 'Just now';
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function importanceColor(importance: number): string {
  if (importance >= 8) return '#ef4444';
  if (importance >= 5) return '#f59e0b';
  return '#4f6eff';
}

function importanceBg(importance: number): string {
  if (importance >= 8) return 'rgba(239,68,68,0.1)';
  if (importance >= 5) return 'rgba(245,158,11,0.1)';
  return 'rgba(79,110,255,0.08)';
}

function importanceBorder(importance: number): string {
  if (importance >= 8) return 'rgba(239,68,68,0.25)';
  if (importance >= 5) return 'rgba(245,158,11,0.25)';
  return 'rgba(79,110,255,0.25)';
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
    return (
      <div className="flex items-center justify-center py-16">
        <span className="label-mono">Loading...</span>
      </div>
    );
  }

  if (memories.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-3">
        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="rgba(79,110,255,0.25)" strokeWidth={1}>
          <path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
        </svg>
        <span className="label-mono" style={{ color: 'rgba(79,110,255,0.4)' }}>No Memories Yet</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {memories.map((m) => {
        const impColor = importanceColor(m.importance);
        return (
          <div
            key={m.id}
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: '8px',
              padding: '1rem',
              boxShadow: '0 1px 4px #e5e7eb, 0 4px 16px rgba(0,0,0,0.04)',
            }}
          >
            {/* Content */}
            <p
              className="text-sm leading-relaxed mb-3"
              style={{ color: 'var(--text)', fontFamily: "'Inter', sans-serif" }}
            >
              {m.content}
            </p>

            {/* Importance bar */}
            <div
              className="mb-3"
              style={{
                height: 3,
                background: '#e4e4e4',
                borderRadius: '2px',
                position: 'relative',
              }}
            >
              <div
                style={{
                  height: '100%',
                  width: `${(m.importance / 10) * 100}%`,
                  background: impColor,
                  borderRadius: '2px',
                  transition: 'width 0.3s ease',
                }}
              />
            </div>

            {/* Meta row */}
            <div className="flex items-center gap-2 flex-wrap">
              <span
                style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: '0.6rem',
                  fontWeight: 700,
                  letterSpacing: '0.06em',
                  color: impColor,
                  background: importanceBg(m.importance),
                  border: `1px solid ${importanceBorder(m.importance)}`,
                  borderRadius: '4px',
                  padding: '0.15rem 0.5rem',
                }}
              >
                IMP {m.importance}/10
              </span>

              {m.partner_name && (
                <>
                  <span style={{ color: 'var(--border)', fontSize: '0.7rem' }}>·</span>
                  <span
                    style={{
                      fontFamily: "'Inter', sans-serif",
                      fontSize: '0.75rem',
                      color: 'var(--text2)',
                    }}
                  >
                    {m.partner_name}
                  </span>
                </>
              )}

              {m.category && (
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
                      padding: '0.15rem 0.5rem',
                      textTransform: 'uppercase',
                    }}
                  >
                    {m.category}
                  </span>
                </>
              )}

              {m.archived === 1 && (
                <>
                  <span style={{ color: 'var(--border)', fontSize: '0.7rem' }}>·</span>
                  <span
                    style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: '0.6rem',
                      fontWeight: 700,
                      letterSpacing: '0.06em',
                      color: '#f59e0b',
                    }}
                  >
                    ARCHIVED
                  </span>
                </>
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
                {timeAgo(m.created_at)}
              </span>
            </div>

            {/* Tags */}
            {m.tags.length > 0 && (
              <div className="flex flex-wrap gap-1.5 mt-2.5">
                {m.tags.map((tag) => (
                  <span
                    key={tag}
                    style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: '0.55rem',
                      letterSpacing: '0.06em',
                      fontWeight: 500,
                      color: '#7b96ff',
                      background: '#e4e4e4',
                      border: '1px solid rgba(79,110,255,0.2)',
                      borderRadius: '4px',
                      padding: '0.1rem 0.4rem',
                    }}
                  >
                    {tag}
                  </span>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
