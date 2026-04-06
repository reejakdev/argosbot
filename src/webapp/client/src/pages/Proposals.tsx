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
  const cls = risk === 'high' ? 'badge-high' : risk === 'medium' ? 'badge-medium' : 'badge-low';
  const label = risk === 'high' ? 'HIGH RISK' : risk === 'medium' ? 'MEDIUM' : 'LOW';
  return <span className={cls}>{label}</span>;
}

function ProposalId({ id }: { id: string }) {
  return (
    <span
      style={{
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: '0.6rem',
        color: 'var(--text2)',
        letterSpacing: '0.06em',
      }}
    >
      #{id.slice(-8).toUpperCase()}
    </span>
  );
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
    return (
      <div className="flex items-center justify-center py-16">
        <span className="label-mono">Loading...</span>
      </div>
    );
  }

  if (proposals.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 gap-3">
        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="rgba(79,110,255,0.25)" strokeWidth={1}>
          <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <span className="label-mono" style={{ color: 'rgba(79,110,255,0.4)' }}>
          No Pending Proposals
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {proposals.map((p) => {
        const risk = riskLabel(p.actions);
        const isActing = acting === p.id;
        return (
          <div
            key={p.id}
            style={{
              background: '#f5f5f5',
              border: '1px solid #e5e7eb',
              borderRadius: '8px',
              padding: '1rem',
              boxShadow: '0 1px 4px #e5e7eb',
            }}
          >
            {/* Header row */}
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2.5">
                <RiskBadge risk={risk} />
                <ProposalId id={p.id} />
              </div>
              <span
                style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: '0.6rem',
                  color: 'var(--text2)',
                  letterSpacing: '0.04em',
                }}
              >
                {formatTime(p.created_at)}
              </span>
            </div>

            {/* Context summary */}
            <div
              className="mb-3"
              style={{
                maxHeight: '120px',
                overflowY: 'auto',
                color: '#111827',
                fontFamily: "'Inter', sans-serif",
                fontSize: '0.875rem',
                lineHeight: 1.6,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {p.context_summary}
            </div>

            {/* Plan / reasoning */}
            {p.plan && p.plan !== 'run_script' && (
              <div className="mb-3">
                <div className="label-mono mb-1.5">Reasoning</div>
                <p
                  className="text-xs leading-relaxed"
                  style={{
                    fontFamily: "'Inter', sans-serif",
                    color: 'var(--text2)',
                    maxHeight: '72px',
                    overflowY: 'auto',
                    whiteSpace: 'pre-wrap',
                  }}
                >
                  {p.plan}
                </p>
              </div>
            )}

            {/* Draft reply */}
            {p.draft_reply && (
              <div
                className="mb-3 px-3 py-2.5"
                style={{
                  background: '#ebebeb',
                  border: '1px solid #e5e7eb',
                  borderLeft: '3px solid rgba(79,110,255,0.5)',
                  borderRadius: '0 6px 6px 0',
                }}
              >
                <div className="label-mono mb-1">Draft Reply</div>
                <p
                  className="text-xs italic"
                  style={{
                    fontFamily: "'Inter', sans-serif",
                    color: 'var(--text2)',
                    lineHeight: 1.6,
                  }}
                >
                  "{p.draft_reply}"
                </p>
              </div>
            )}

            {/* Actions */}
            {p.actions.length > 0 && (
              <div className="mb-3">
                <div className="label-mono mb-1.5">Actions</div>
                <div className="flex flex-col gap-1.5">
                  {p.actions.map((a, i) => (
                    <div
                      key={i}
                      className="px-3 py-2"
                      style={{
                        background: 'var(--bg2)',
                        border: '1px solid var(--border)',
                        borderRadius: '6px',
                      }}
                    >
                      <div className="flex items-center gap-2 mb-0.5">
                        {a.tool && (
                          <span
                            style={{
                              fontFamily: "'JetBrains Mono', monospace",
                              fontSize: '0.6rem',
                              fontWeight: 700,
                              color: '#4f6eff',
                              background: '#e4e4e4',
                              border: '1px solid rgba(79,110,255,0.18)',
                              borderRadius: '3px',
                              padding: '0.1rem 0.4rem',
                              letterSpacing: '0.04em',
                            }}
                          >
                            {a.tool}
                          </span>
                        )}
                        <span
                          className="text-xs"
                          style={{ color: '#111827', fontFamily: "'Inter', sans-serif" }}
                        >
                          {a.description}
                        </span>
                      </div>
                      {a.details && (
                        <div
                          style={{
                            marginTop: '0.375rem',
                            border: '1px solid rgba(79,110,255,0.18)',
                            borderRadius: '5px',
                            background: '#1a1a2e',
                            overflow: 'hidden',
                          }}
                        >
                          {a.lang && (
                            <div
                              style={{
                                padding: '0.15rem 0.5rem',
                                background: 'rgba(79,110,255,0.15)',
                                fontFamily: "'JetBrains Mono', monospace",
                                fontSize: '0.55rem',
                                color: '#8090d0',
                                letterSpacing: '0.06em',
                                textTransform: 'uppercase',
                                borderBottom: '1px solid rgba(79,110,255,0.18)',
                              }}
                            >
                              {a.lang}
                            </div>
                          )}
                          <pre
                            style={{
                              fontFamily: "'JetBrains Mono', monospace",
                              fontSize: '0.7rem',
                              color: '#c8d3f5',
                              lineHeight: 1.6,
                              margin: 0,
                              padding: '0.5rem 0.65rem',
                              overflowX: 'auto',
                              overflowY: 'auto',
                              maxHeight: '160px',
                              whiteSpace: 'pre',
                            }}
                          >
                            {a.details}
                          </pre>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Expiry */}
            <div className="flex items-center gap-1.5 mb-4">
              <span className="status-dot status-dot-yellow" style={{ width: 5, height: 5 }} />
              <span
                style={{
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: '0.6rem',
                  color: 'var(--text2)',
                  letterSpacing: '0.04em',
                }}
              >
                Expires in {p.expiresInMin}min
              </span>
            </div>

            {/* Buttons */}
            <div className="flex gap-2.5">
              <button
                onClick={() => void approve(p)}
                disabled={isActing}
                className="btn-primary flex-1"
                style={{ opacity: isActing ? 0.5 : 1 }}
              >
                {isActing ? '...' : risk === 'high' ? 'YubiKey + Approve' : 'Approve'}
              </button>
              <button
                onClick={() => void reject(p)}
                disabled={isActing}
                className="btn-danger flex-1"
                style={{ opacity: isActing ? 0.5 : 1 }}
              >
                Reject
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
