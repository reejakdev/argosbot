import { useState, useEffect, useCallback } from 'react';
import {
  startAuthentication,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { get, post, ApiError } from '../api.ts';
import type { Proposal } from '../types.ts';
import { useToast } from '../components/Toast.tsx';
import { useWebSocket } from '../hooks/useWebSocket.ts';

function riskLabel(actions: Proposal['actions']) {
  const maxRisk = actions.some((a) => a.risk === 'high')
    ? 'high'
    : actions.some((a) => a.risk === 'medium')
    ? 'medium'
    : 'low';
  return maxRisk;
}

function RiskBadge({ risk }: { risk: string }) {
  const styles: Record<string, { bg: string; color: string; label: string }> = {
    high: { bg: '#7f1d1d', color: '#fca5a5', label: '🔴 HIGH RISK' },
    medium: { bg: '#713f12', color: '#fde68a', label: '🟡 MEDIUM' },
    low: { bg: '#14532d', color: '#86efac', label: '🟢 LOW' },
  };
  const s = styles[risk] ?? styles.low;
  return (
    <span className="text-xs font-semibold px-1.5 py-0.5 rounded" style={{ background: s.bg, color: s.color }}>
      {s.label}
    </span>
  );
}

export default function Proposals() {
  const { toast } = useToast();
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await get<Proposal[]>('/proposals');
      setProposals(data);
    } catch { /* silently ignore — auth handled by App */ }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  useWebSocket({
    onMessage: (e) => {
      if (e.event === 'proposal_updated' || e.event === 'new_proposal') void load();
    },
  });

  async function approve(proposal: Proposal) {
    const risk = riskLabel(proposal.actions);
    setActing(proposal.id);
    try {
      if (risk === 'high') {
        // Elevated YubiKey auth required
        const { challengeId, options } = await post<{
          challengeId: string;
          options: PublicKeyCredentialRequestOptionsJSON;
        }>(`/proposals/${proposal.id}/elevate/begin`);

        toast('Touch your YubiKey to approve…', 10000);
        const response = await startAuthentication({ optionsJSON: options });
        const elevate = await post<{ success: boolean }>(`/proposals/${proposal.id}/elevate/complete`, {
          challengeId,
          response,
        });
        if (!elevate.success) {
          toast('Key verification failed');
          return;
        }
      }

      const result = await post<{ ok?: boolean; error?: string }>(`/proposals/${proposal.id}/approve`);
      if (result.ok) {
        setProposals((prev) => prev.filter((p) => p.id !== proposal.id));
        toast('Approved — executing…');
      } else {
        toast('Error: ' + (result.error ?? 'Approval failed'));
      }
    } catch (e) {
      if (e instanceof Error && e.name === 'NotAllowedError') {
        toast('Key tap timed out or cancelled');
      } else {
        toast('Error: ' + (e instanceof ApiError ? e.message : String(e)));
      }
    } finally {
      setActing(null);
    }
  }

  async function reject(proposal: Proposal) {
    setActing(proposal.id);
    try {
      await post(`/proposals/${proposal.id}/reject`);
      setProposals((prev) => prev.filter((p) => p.id !== proposal.id));
      toast('Rejected');
    } catch (e) {
      toast('Error: ' + (e instanceof ApiError ? e.message : String(e)));
    } finally {
      setActing(null);
    }
  }

  if (loading) {
    return <div className="text-center py-10 text-sm" style={{ color: 'var(--muted)' }}>Loading…</div>;
  }

  if (proposals.length === 0) {
    return <div className="text-center py-10 text-sm" style={{ color: 'var(--muted)' }}>✅ No pending approvals</div>;
  }

  return (
    <div>
      {proposals.map((p) => {
        const risk = riskLabel(p.actions);
        const isActing = acting === p.id;
        return (
          <div
            key={p.id}
            className="rounded-xl border mb-2.5 p-3.5"
            style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
          >
            {/* Header */}
            <div className="flex items-start gap-2 mb-2">
              <RiskBadge risk={risk} />
              <p className="text-sm font-medium leading-snug flex-1">{p.context_summary}</p>
            </div>

            {/* Plan */}
            {p.plan && (
              <p
                className="text-xs mb-2.5 leading-relaxed overflow-hidden"
                style={{
                  color: '#a0a0bc',
                  maxHeight: 80,
                  WebkitMaskImage: 'linear-gradient(to bottom, black 60%, transparent)',
                }}
              >
                {p.plan}
              </p>
            )}

            {/* Draft reply */}
            {p.draft_reply && (
              <div
                className="rounded-lg px-3 py-2 mb-2.5 text-xs italic"
                style={{ background: '#0f172a', color: '#94a3b8' }}
              >
                "{p.draft_reply}"
              </div>
            )}

            {/* Actions */}
            {p.actions.length > 0 && (
              <ul className="text-xs mb-3" style={{ color: 'var(--muted)' }}>
                {p.actions.map((a, i) => (
                  <li key={i} className="py-0.5">
                    <strong>{a.description}</strong>
                    {a.details && (
                      <pre
                        className="whitespace-pre-wrap mt-1 mb-1 overflow-auto"
                        style={{ fontSize: 11, color: 'var(--muted)', maxHeight: 100 }}
                      >
                        {a.details.slice(0, 300)}
                      </pre>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {/* Expiry */}
            <p className="text-xs mb-3" style={{ color: 'var(--muted)' }}>
              Expires in {p.expiresInMin}min
            </p>

            {/* Buttons */}
            <div className="flex gap-2">
              <button
                onClick={() => void approve(p)}
                disabled={isActing}
                className="flex-1 py-2.5 rounded-lg text-sm font-medium text-white transition-opacity"
                style={{ background: 'var(--green)', opacity: isActing ? 0.5 : 1 }}
              >
                {isActing ? '…' : risk === 'high' ? '🔑 Approve' : '✓ Approve'}
              </button>
              <button
                onClick={() => void reject(p)}
                disabled={isActing}
                className="flex-1 py-2.5 rounded-lg text-sm font-medium border transition-opacity"
                style={{
                  background: 'var(--surface)',
                  color: 'var(--red)',
                  borderColor: 'var(--red)',
                  opacity: isActing ? 0.5 : 1,
                }}
              >
                ✕ Reject
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
