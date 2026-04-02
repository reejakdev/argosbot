import { useState, useEffect, useCallback } from 'react';
import { get } from '../api.ts';
import type { Memory } from '../types.ts';

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const h = Math.floor(diff / 3600000);
  if (h < 1) return 'JUST NOW';
  if (h < 24) return `${h}H AGO`;
  const d = Math.floor(h / 24);
  return `${d}D AGO`;
}

function importanceColor(importance: number): string {
  if (importance >= 8) return '#ff4466';
  if (importance >= 5) return '#ffaa00';
  return '#00d4ff';
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
        <span className="label-mono" style={{ color: 'var(--muted)' }}>LOADING...</span>
      </div>
    );
  }

  if (memories.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-3">
        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="rgba(0,212,255,0.25)" strokeWidth={1}>
          <path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
        </svg>
        <span className="label-mono" style={{ color: 'rgba(0,212,255,0.3)' }}>NO MEMORIES YET</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {memories.map((m) => {
        const impColor = importanceColor(m.importance);
        return (
          <div key={m.id} className="hud-card">
            {/* Content */}
            <p
              className="text-sm leading-relaxed mb-3"
              style={{ color: 'var(--text)' }}
            >
              {m.content}
            </p>

            {/* Importance bar */}
            <div
              className="mb-3"
              style={{
                height: 2,
                background: 'rgba(0,212,255,0.08)',
                position: 'relative',
              }}
            >
              <div
                style={{
                  height: '100%',
                  width: `${(m.importance / 10) * 100}%`,
                  background: impColor,
                  boxShadow: `0 0 6px ${impColor}80`,
                }}
              />
            </div>

            {/* Meta row */}
            <div className="flex items-center gap-2 flex-wrap">
              <span
                style={{
                  fontFamily: "'Courier New', monospace",
                  fontSize: '0.6rem',
                  letterSpacing: '0.06em',
                  color: impColor,
                  fontWeight: 700,
                }}
              >
                IMP:{m.importance}
              </span>

              {m.partner_name && (
                <>
                  <span style={{ color: 'var(--border)', fontSize: '0.6rem' }}>·</span>
                  <span
                    style={{
                      fontFamily: "'Courier New', monospace",
                      fontSize: '0.6rem',
                      color: 'var(--muted)',
                      letterSpacing: '0.04em',
                    }}
                  >
                    {m.partner_name}
                  </span>
                </>
              )}

              {m.category && (
                <>
                  <span style={{ color: 'var(--border)', fontSize: '0.6rem' }}>·</span>
                  <span className="badge-pending" style={{ fontSize: '0.55rem', padding: '0.1rem 0.4rem' }}>
                    {m.category}
                  </span>
                </>
              )}

              {m.archived === 1 && (
                <>
                  <span style={{ color: 'var(--border)', fontSize: '0.6rem' }}>·</span>
                  <span
                    style={{
                      fontFamily: "'Courier New', monospace",
                      fontSize: '0.6rem',
                      color: '#ffaa00',
                      letterSpacing: '0.06em',
                    }}
                  >
                    ARCHIVED
                  </span>
                </>
              )}

              <span style={{ marginLeft: 'auto', fontFamily: "'Courier New', monospace", fontSize: '0.6rem', color: 'var(--muted)' }}>
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
                      fontFamily: "'Courier New', monospace",
                      fontSize: '0.55rem',
                      letterSpacing: '0.06em',
                      fontWeight: 700,
                      color: '#00d4ff',
                      background: 'rgba(0,212,255,0.08)',
                      border: '1px solid rgba(0,212,255,0.2)',
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
