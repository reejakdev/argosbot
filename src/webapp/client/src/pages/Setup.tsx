import { useState } from 'react';
import {
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
} from '@simplewebauthn/browser';
import { get, post, ApiError } from '../api.ts';
import { useToast } from '../components/Toast.tsx';

interface SetupProps {
  onComplete: () => void;
}

type SetupMethod = 'webauthn' | 'totp';
type TotpStep = 'generate' | 'verify';

function EyeIcon({ size = 48 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M2 16 C6 8, 26 8, 30 16 C26 24, 6 24, 2 16 Z" stroke="#4f6eff" strokeWidth="1.2" fill="none" />
      <circle cx="16" cy="16" r="6.5" stroke="#4f6eff" strokeWidth="1" fill="none" opacity="0.9" />
      <circle cx="16" cy="16" r="4" stroke="#7b96ff" strokeWidth="0.8" fill="none" opacity="0.7" />
      <circle cx="16" cy="16" r="2" fill="#4f6eff" />
      <circle cx="16" cy="16" r="1" fill="white" opacity="0.9" />
      <line x1="2" y1="16" x2="4.5" y2="16" stroke="#4f6eff" strokeWidth="0.8" opacity="0.5" />
      <line x1="27.5" y1="16" x2="30" y2="16" stroke="#4f6eff" strokeWidth="0.8" opacity="0.5" />
    </svg>
  );
}

export default function Setup({ onComplete }: SetupProps) {
  const { toast } = useToast();
  const [method, setMethod] = useState<SetupMethod>('webauthn');
  const [deviceName, setDeviceName] = useState('YubiKey');
  const [loading, setLoading] = useState(false);
  const [totpStep, setTotpStep] = useState<TotpStep>('generate');
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [secretId, setSecretId] = useState<number>(0);
  const [totpCode, setTotpCode] = useState('');

  async function registerWebAuthn() {
    setLoading(true);
    try {
      const { challengeId, options } = await post<{
        challengeId: string;
        options: PublicKeyCredentialCreationOptionsJSON;
      }>('/auth/register/begin', { deviceName });

      const response = await startRegistration({ optionsJSON: options });
      const result = await post<{ success: boolean; message?: string }>('/auth/register/complete', {
        challengeId,
        response,
        deviceName,
      });

      if (result.success) {
        toast('YubiKey registered!');
        onComplete();
      } else {
        toast('Registration failed');
      }
    } catch (e) {
      if (e instanceof Error && e.name === 'NotAllowedError') {
        toast('Key tap timed out or cancelled');
      } else {
        toast('Registration failed: ' + (e instanceof Error ? e.message : String(e)));
      }
    } finally {
      setLoading(false);
    }
  }

  async function generateTotp() {
    setLoading(true);
    try {
      const result = await post<{ success: boolean; qrDataUrl: string; secretId: number }>(
        '/auth/totp/setup',
      );
      setQrDataUrl(result.qrDataUrl);
      setSecretId(result.secretId);
      setTotpStep('verify');
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Failed to generate TOTP');
    } finally {
      setLoading(false);
    }
  }

  async function verifyTotp() {
    if (totpCode.length < 6) return;
    setLoading(true);
    try {
      const result = await post<{ success: boolean; message?: string }>('/auth/totp/verify', {
        secretId,
        code: totpCode,
      });
      if (result.success) {
        toast('Authenticator app configured!');
        onComplete();
      } else {
        toast('Invalid code — try again');
      }
    } catch (e) {
      toast(e instanceof ApiError ? e.message : 'Verification failed');
    } finally {
      setLoading(false);
    }
  }

  const btnBase: React.CSSProperties = {
    width: '100%',
    padding: '0.875rem',
    background: '#4f6eff',
    color: '#fff',
    border: 'none',
    borderRadius: '8px',
    fontFamily: "'Inter', sans-serif",
    fontSize: '0.875rem',
    fontWeight: 600,
    cursor: 'pointer',
    transition: 'background 0.15s',
    outline: 'none',
  };

  return (
    <div
      className="min-h-dvh flex items-center justify-center p-6"
      style={{ background: 'var(--bg)' }}
    >
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="flex flex-col items-center gap-3 mb-8">
          <EyeIcon size={48} />
          <div style={{ fontFamily: "'Inter', sans-serif", fontSize: '1.25rem', fontWeight: 700, letterSpacing: '0.18em', color: '#f0f4ff' }}>
            ARGOS
          </div>
          <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '0.6rem', letterSpacing: '0.15em', color: 'var(--text2)' }}>
            INITIAL SETUP
          </div>
        </div>

        <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '12px', padding: '1.5rem', boxShadow: '0 4px 24px rgba(0,0,0,0.4)' }}>
          <p style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '0.6rem', letterSpacing: '0.12em', color: 'var(--text2)', textTransform: 'uppercase', marginBottom: '1.25rem' }}>
            Register Authentication Method
          </p>

          {/* Method switcher */}
          <div style={{ display: 'flex', gap: '8px', marginBottom: '1.25rem' }}>
            {(['webauthn', 'totp'] as SetupMethod[]).map((m) => (
              <button
                key={m}
                onClick={() => setMethod(m)}
                style={{
                  flex: 1,
                  fontFamily: "'Inter', sans-serif",
                  fontSize: '0.8125rem',
                  fontWeight: method === m ? 600 : 400,
                  padding: '0.6rem',
                  background: method === m ? 'rgba(79,110,255,0.12)' : 'transparent',
                  color: method === m ? '#f0f4ff' : 'var(--text2)',
                  border: `1px solid ${method === m ? 'rgba(79,110,255,0.4)' : 'var(--border)'}`,
                  borderRadius: '6px',
                  cursor: 'pointer',
                  transition: 'all 0.15s',
                  outline: 'none',
                }}
              >
                {m === 'webauthn' ? 'YubiKey' : 'Authenticator'}
              </button>
            ))}
          </div>

          {method === 'webauthn' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <input
                type="text"
                placeholder="Device name (e.g. YubiKey 5C)"
                value={deviceName}
                onChange={(e) => setDeviceName(e.target.value)}
                style={{
                  width: '100%',
                  background: 'rgba(0,0,0,0.3)',
                  border: '1px solid var(--border)',
                  borderRadius: '6px',
                  color: 'var(--text)',
                  fontFamily: "'Inter', sans-serif",
                  fontSize: '0.875rem',
                  padding: '0.65rem 0.875rem',
                  outline: 'none',
                }}
              />
              <p style={{ fontFamily: "'Inter', sans-serif", fontSize: '0.8rem', color: 'var(--text2)', lineHeight: 1.5 }}>
                Insert your YubiKey and click Register. Tap the key when your browser prompts.
              </p>
              <button
                onClick={registerWebAuthn}
                disabled={loading || !deviceName.trim()}
                style={{ ...btnBase, opacity: loading || !deviceName.trim() ? 0.45 : 1 }}
              >
                {loading ? 'Waiting for key tap…' : 'Register YubiKey'}
              </button>
            </div>
          )}

          {method === 'totp' && totpStep === 'generate' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <p style={{ fontFamily: "'Inter', sans-serif", fontSize: '0.8rem', color: 'var(--text2)', lineHeight: 1.5 }}>
                Set up an authenticator app as backup (Google Auth, Authy, 1Password).
              </p>
              <button onClick={generateTotp} disabled={loading} style={{ ...btnBase, opacity: loading ? 0.45 : 1 }}>
                {loading ? 'Generating…' : 'Generate QR Code'}
              </button>
            </div>
          )}

          {method === 'totp' && totpStep === 'verify' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              {qrDataUrl && (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem' }}>
                  <div style={{ padding: '0.75rem', background: '#fff', borderRadius: '8px', display: 'inline-flex' }}>
                    <img src={qrDataUrl} alt="TOTP QR Code" style={{ width: 160, height: 160 }} />
                  </div>
                  <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: '0.6rem', color: 'var(--text2)', letterSpacing: '0.08em' }}>
                    Scan with authenticator app
                  </span>
                </div>
              )}
              <input
                type="text"
                inputMode="numeric"
                maxLength={6}
                placeholder="000000"
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ''))}
                onKeyDown={(e) => e.key === 'Enter' && verifyTotp()}
                style={{
                  width: '100%',
                  background: 'rgba(0,0,0,0.3)',
                  border: '1px solid var(--border)',
                  borderRadius: '6px',
                  color: '#7b96ff',
                  fontFamily: "'JetBrains Mono', monospace",
                  fontSize: '1.4rem',
                  letterSpacing: '0.3em',
                  textAlign: 'center',
                  padding: '0.75rem',
                  outline: 'none',
                }}
                autoFocus
              />
              <button
                onClick={verifyTotp}
                disabled={loading || totpCode.length < 6}
                style={{ ...btnBase, opacity: loading || totpCode.length < 6 ? 0.45 : 1 }}
              >
                {loading ? 'Verifying…' : 'Activate'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
