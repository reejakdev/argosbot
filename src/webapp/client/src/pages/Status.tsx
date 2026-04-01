import { useState, useEffect, useCallback } from 'react';
import { get, post } from '../api.ts';
import type { StatusData } from '../types.ts';
import { useToast } from '../components/Toast.tsx';

interface StatusProps {
  onLogout: () => void;
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
    return <div className="text-center py-10 text-sm" style={{ color: 'var(--muted)' }}>Loading…</div>;
  }

  return (
    <div>
      {status && (
        <>
          <div className="rounded-xl border p-4 mb-3" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
            <p className="text-xs font-semibold uppercase tracking-wider mb-1" style={{ color: 'var(--muted)' }}>Owner</p>
            <p className="text-base font-medium">{status.owner}</p>
            {status.teams.length > 0 && (
              <p className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>Teams: {status.teams.join(', ')}</p>
            )}
            {status.readOnly && (
              <span className="inline-block mt-1 text-xs px-2 py-0.5 rounded" style={{ background: '#713f12', color: '#fde68a' }}>
                Read-only mode
              </span>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2.5 mb-3">
            <div className="rounded-xl border p-4" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
              <p className="text-3xl font-bold">{status.tasks.open}</p>
              <p className="text-xs mt-1" style={{ color: 'var(--muted)' }}>Open tasks</p>
            </div>
            <div className="rounded-xl border p-4" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
              <p className="text-3xl font-bold" style={{ color: status.tasks.mine > 0 ? 'var(--accent)' : 'var(--text)' }}>
                {status.tasks.mine}
              </p>
              <p className="text-xs mt-1" style={{ color: 'var(--muted)' }}>My tasks</p>
            </div>
            <div className="rounded-xl border p-4" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
              <p className="text-3xl font-bold" style={{ color: status.proposals.pending > 0 ? 'var(--yellow)' : 'var(--text)' }}>
                {status.proposals.pending}
              </p>
              <p className="text-xs mt-1" style={{ color: 'var(--muted)' }}>Pending approvals</p>
            </div>
            <div className="rounded-xl border p-4" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
              <p className="text-3xl font-bold">{status.memories.active}</p>
              <p className="text-xs mt-1" style={{ color: 'var(--muted)' }}>Active memories</p>
            </div>
          </div>
        </>
      )}

      <button
        onClick={() => { void logout(); }}
        className="w-full py-3 rounded-xl text-sm font-medium border transition-opacity active:opacity-70"
        style={{ borderColor: 'var(--red)', color: 'var(--red)', background: 'transparent' }}
      >
        Sign Out
      </button>

      {/* Refresh */}
      <button
        onClick={() => { void load(); toast('Refreshed'); }}
        className="w-full py-3 mt-2 rounded-xl text-sm font-medium border transition-opacity active:opacity-70"
        style={{ borderColor: 'var(--border)', color: 'var(--muted)', background: 'transparent' }}
      >
        Refresh
      </button>
    </div>
  );
}
