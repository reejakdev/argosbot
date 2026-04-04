import { useState } from 'react';
import {
  startAuthentication,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { get, post, ApiError } from '../api.ts';
import { useToast } from '../components/Toast.tsx';

interface LoginProps {
  onLogin: () => void;
}

type Method = 'webauthn' | 'totp';

function EyeIcon({ size = 48 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M2 16 C6 8, 26 8, 30 16 C26 24, 6 24, 2 16 Z" stroke="#4f6eff" strokeWidth="1.2" fill="none" />
      <circle cx="16" cy="16" r="5" stroke="#4f6eff" strokeWidth="1.2" fill="none" opacity="0.9" />
      <circle cx="16" cy="16" r="3" stroke="#7b96ff" strokeWidth="0.9" fill="none" opacity="0.7" />
      <circle cx="16" cy="16" r="1.6" fill="#4f6eff" />
      <circle cx="16" cy="16" r="0.7" fill="white" opacity="0.9" />
      <line x1="2" y1="16" x2="4.5" y2="16" stroke="#4f6eff" strokeWidth="0.8" opacity="0.5" />
      <line x1="27.5" y1="16" x2="30" y2="16" stroke="#4f6eff" strokeWidth="0.8" opacity="0.5" />
    </svg>
  );
}

export default function Login({ onLogin }: LoginProps) {
  const { toast } = useToast();
  const [method, setMethod] = useState<Method>('webauthn');
  const [totpCode, setTotpCode] = useState('');
  const [loading, setLoading] = useState(false);

  async function loginWithWebAuthn() {
    setLoading(true);
    try {
      const { challengeId, options } = await get<{
        challengeId: string;
        options: PublicKeyCredentialRequestOptionsJSON;
      }>('/auth/login/begin');

      const response = await startAuthentication({ optionsJSON: options });
      const result = await post<{ success: boolean; message?: string }>('/auth/login/complete', {
        challengeId,
        response,
      });

      if (result.success) {
        onLogin();
      } else {
        toast('Authentication failed');
      }
    } catch (e) {
      if (e instanceof Error && e.name === 'NotAllowedError') {
        toast('Key tap timed out or cancelled');
      } else {
        toast('Authentication failed: ' + (e instanceof Error ? e.message : String(e)));
      }
    } finally {
      setLoading(false);
    }
  }

  async function loginWithTOTP() {
    if (!totpCode.trim()) return;
    setLoading(true);
    try {
      const result = await post<{ success: boolean; message?: string }>('/auth/totp/login', {
        code: totpCode.trim(),
      });
      if (result.success) {
        onLogin();
      } else {
        toast('Invalid code');
      }
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      className="min-h-dvh flex items-center justify-center p-6"
      style={{ background: 'var(--bg)' }}
    >
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="flex flex-col items-center gap-3 mb-8">
          <EyeIcon size={48} />
          <div
            style={{
              fontFamily: "'Inter', sans-serif",
              fontSize: '1.25rem',
              fontWeight: 700,
              letterSpacing: '0.18em',
              color: '#111827',
            }}
          >
            ARGOS
          </div>
          <div
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: '0.6rem',
              letterSpacing: '0.15em',
              color: 'var(--text2)',
              textTransform: 'uppercase',
            }}
          >
            Authentication Required
          </div>
        </div>

        <div
          style={{
            background: '#f5f5f5',
            border: '1px solid #e5e7eb',
            borderRadius: '8px',
            padding: '1.5rem',
            boxShadow: '0 2px 12px #e5e7eb',
          }}
        >
          {/* Method switcher */}
          <div
            className="flex mb-5"
            style={{
              background: 'var(--bg2)',
              borderRadius: '6px',
              padding: '3px',
            }}
          >
            {(['webauthn', 'totp'] as Method[]).map((m) => (
              <button
                key={m}
                onClick={() => setMethod(m)}
                style={{
                  flex: 1,
                  fontFamily: "'Inter', sans-serif",
                  fontSize: '0.75rem',
                  fontWeight: 600,
                  padding: '0.5rem',
                  background: method === m ? '#f5f5f5' : 'transparent',
                  color: method === m ? '#111827' : 'var(--text2)',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                  outline: 'none',
                }}
              >
                {m === 'webauthn' ? 'YubiKey' : 'TOTP'}
              </button>
            ))}
          </div>

          {method === 'webauthn' && (
            <div className="flex flex-col gap-4">
              <p
                style={{
                  fontFamily: "'Inter', sans-serif",
                  fontSize: '0.8125rem',
                  color: 'var(--text2)',
                  textAlign: 'center',
                  lineHeight: 1.6,
                }}
              >
                Insert your YubiKey and tap when prompted to authenticate.
              </p>
              <button
                onClick={loginWithWebAuthn}
                disabled={loading}
                className="btn-primary w-full"
                style={{ padding: '0.75rem', fontSize: '0.875rem' }}
              >
                {loading ? 'Waiting for key...' : 'Touch YubiKey'}
              </button>
            </div>
          )}

          {method === 'totp' && (
            <div className="flex flex-col gap-3">
              <input
                type="text"
                inputMode="numeric"
                maxLength={6}
                placeholder="000 000"
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ''))}
                onKeyDown={(e) => e.key === 'Enter' && loginWithTOTP()}
                style={{
                  width: '100%',
                  background: '#f5f5f5',
                  border: '1px solid rgba(0,0,0,0.1)',
                  borderRadius: '6px',
                  color: '#111827',
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: '1.5rem',
                  fontWeight: 500,
                  letterSpacing: '0.3em',
                  textAlign: 'center',
                  padding: '0.75rem',
                  outline: 'none',
                  transition: 'border-color 0.15s ease',
                }}
                autoFocus
              />
              <button
                onClick={loginWithTOTP}
                disabled={loading || totpCode.length < 6}
                className="btn-primary w-full"
                style={{ padding: '0.75rem', fontSize: '0.875rem' }}
              >
                {loading ? 'Verifying...' : 'Sign In'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
