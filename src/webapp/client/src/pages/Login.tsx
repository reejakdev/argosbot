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

function YubiKeyIcon({ size = 48 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="8" y="18" width="32" height="20" rx="4" stroke="#4f6eff" strokeWidth="1.5" />
      <rect x="14" y="24" width="8" height="8" rx="2" fill="rgba(79,110,255,0.2)" stroke="#4f6eff" strokeWidth="1.2" />
      <circle cx="30" cy="28" r="3" fill="rgba(79,110,255,0.3)" stroke="#4f6eff" strokeWidth="1.2" />
      <path d="M20 18V14a4 4 0 018 0v4" stroke="#4f6eff" strokeWidth="1.5" strokeLinecap="round" />
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
          <div
            style={{
              background: 'rgba(79,110,255,0.08)',
              border: '1px solid rgba(79,110,255,0.2)',
              borderRadius: '12px',
              padding: '16px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <YubiKeyIcon size={40} />
          </div>
          <div
            style={{
              fontFamily: "'Inter', sans-serif",
              fontSize: '1.5rem',
              fontWeight: 700,
              letterSpacing: '0.06em',
              color: '#0f1117',
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
            background: '#ffffff',
            border: '1px solid rgba(0,0,0,0.08)',
            borderRadius: '8px',
            padding: '1.5rem',
            boxShadow: '0 2px 12px rgba(0,0,0,0.06)',
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
                  background: method === m ? '#ffffff' : 'transparent',
                  color: method === m ? '#0f1117' : 'var(--text2)',
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
                  background: '#ffffff',
                  border: '1px solid rgba(0,0,0,0.1)',
                  borderRadius: '6px',
                  color: '#0f1117',
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
