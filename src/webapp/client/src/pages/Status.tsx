import { useState, useEffect, useCallback } from 'react';
import { get, post } from '../api.ts';
import type { StatusData } from '../types.ts';
import { useToast } from '../components/Toast.tsx';

interface StatusProps {
  onLogout: () => void;
}

function StatCard({ label, value, color }: { label: string; value: number | string; color?: string }) {
  return (
    <div
      className="flex flex-col gap-2"
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: '8px',
        padding: '1rem',
        boxShadow: '0 1px 4px rgba(0,0,0,0.06), 0 4px 16px rgba(0,0,0,0.04)',
      }}
    >
      <div className="label-mono">{label}</div>
      <div
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '1.75rem',
          fontWeight: 700,
          lineHeight: 1,
          color: color ?? '#f0f4ff',
        }}
      >
        {value}
      </div>
    </div>
  );
}

function StatusRow({ label, value, dotClass }: { label: string; value: string; dotClass?: string }) {
  return (
    <div
      className="flex items-center justify-between py-2.5"
      style={{ borderBottom: '1px solid var(--border)' }}
    >
      <span
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: '0.65rem',
          fontWeight: 700,
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          color: 'var(--text2)',
        }}
      >
        {label}
      </span>
      <div className="flex items-center gap-2">
        {dotClass && <span className={`status-dot ${dotClass}`} />}
        <span
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '0.7rem',
            color: '#f0f4ff',
            letterSpacing: '0.04em',
          }}
        >
          {value}
        </span>
      </div>
    </div>
  );
}

export default function Status({ onLogout }: StatusProps) {
  const { toast } = useToast();
  const [status, setStatus] = useState<StatusData | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const data = await get<StatusData>('/status');
      setStatus(data);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function logout() {
    try {
      await post('/auth/logout');
    } catch { /* ignore */ }
    onLogout();
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <span className="label-mono">Loading...</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {status && (
        <>
          {/* Owner card */}
          <div
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: '8px',
              padding: '1rem',
              boxShadow: '0 1px 4px rgba(0,0,0,0.06), 0 4px 16px rgba(0,0,0,0.04)',
            }}
          >
            <div className="label-mono mb-2">Operator</div>
            <div
              style={{
                fontFamily: "'Inter', sans-serif",
                fontSize: '1rem',
                fontWeight: 600,
                color: '#f0f4ff',
              }}
            >
              {status.owner}
            </div>
            {status.teams.length > 0 && (
              <div className="flex gap-1.5 mt-2.5 flex-wrap">
                {status.teams.map((team) => (
                  <span
                    key={team}
                    style={{
                      fontFamily: "'JetBrains Mono', monospace",
                      fontSize: '0.6rem',
                      fontWeight: 700,
                      letterSpacing: '0.08em',
                      textTransform: 'uppercase',
                      color: '#7b96ff',
                      background: 'rgba(79,110,255,0.1)',
                      border: '1px solid rgba(79,110,255,0.25)',
                      borderRadius: '4px',
                      padding: '0.15rem 0.5rem',
                    }}
                  >
                    {team}
                  </span>
                ))}
              </div>
            )}
            {status.readOnly && (
              <div className="flex items-center gap-2 mt-2.5">
                <span className="status-dot status-dot-yellow" />
                <span
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: '0.6rem',
                    fontWeight: 700,
                    letterSpacing: '0.1em',
                    color: '#f59e0b',
                  }}
                >
                  READ-ONLY MODE
                </span>
              </div>
            )}
          </div>

          {/* Stats grid */}
          <div className="grid grid-cols-2 gap-3">
            <StatCard
              label="Open Tasks"
              value={status.tasks.open}
              color={status.tasks.open > 0 ? '#4f6eff' : undefined}
            />
            <StatCard
              label="My Tasks"
              value={status.tasks.mine}
              color={status.tasks.mine > 0 ? '#4f6eff' : undefined}
            />
            <StatCard
              label="Pending Approvals"
              value={status.proposals.pending}
              color={status.proposals.pending > 0 ? '#f59e0b' : undefined}
            />
            <StatCard
              label="Active Memories"
              value={status.memories.active}
            />
          </div>

          {/* System info */}
          <div
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: '8px',
              padding: '0.75rem 1rem',
              boxShadow: '0 1px 4px rgba(0,0,0,0.06), 0 4px 16px rgba(0,0,0,0.04)',
            }}
          >
            <div className="label-mono mb-1">System</div>
            <StatusRow
              label="Status"
              value="Operational"
              dotClass="status-dot-online"
            />
            <StatusRow
              label="Mode"
              value={status.readOnly ? 'Read-Only' : 'Read-Write'}
              dotClass={status.readOnly ? 'status-dot-yellow' : 'status-dot-green'}
            />
          </div>
        </>
      )}

      {/* Actions */}
      <div className="flex flex-col gap-2 mt-2">
        <button
          onClick={() => { void load(); toast('Refreshed'); }}
          style={{
            fontFamily: "'Inter', sans-serif",
            fontSize: '0.8125rem',
            fontWeight: 500,
            padding: '0.625rem 1rem',
            background: 'transparent',
            color: 'var(--text2)',
            border: '1px solid var(--border)',
            borderRadius: '6px',
            cursor: 'pointer',
            transition: 'all 0.15s ease',
            outline: 'none',
            width: '100%',
          }}
        >
          Refresh
        </button>

        <button
          onClick={() => { void logout(); }}
          className="btn-danger w-full"
          style={{ padding: '0.625rem 1rem' }}
        >
          Sign Out
        </button>
      </div>
    </div>
  );
}
