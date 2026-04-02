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
      <ellipse cx="16" cy="16" rx="14" ry="9" stroke="#00d4ff" strokeWidth="1.5" />
      <circle cx="16" cy="16" r="5" stroke="#00d4ff" strokeWidth="1.5" />
      <circle cx="16" cy="16" r="2" fill="#00d4ff" />
      <line x1="2" y1="16" x2="6" y2="16" stroke="#00d4ff" strokeWidth="1.5" />
      <line x1="26" y1="16" x2="30" y2="16" stroke="#00d4ff" strokeWidth="1.5" />
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

  return (
    <div
      className="min-h-dvh flex items-center justify-center p-6"
      style={{
        background: 'var(--bg)',
        backgroundImage: `
          repeating-linear-gradient(0deg, transparent, transparent 47px, rgba(0,212,255,0.03) 47px, rgba(0,212,255,0.03) 48px),
          repeating-linear-gradient(90deg, transparent, transparent 47px, rgba(0,212,255,0.03) 47px, rgba(0,212,255,0.03) 48px)
        `,
      }}
    >
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="flex flex-col items-center gap-3 mb-8">
          <div style={{ filter: 'drop-shadow(0 0 16px rgba(0,212,255,0.4))' }}>
            <EyeIcon size={56} />
          </div>
          <div
            style={{
              fontFamily: "'Courier New', monospace",
              fontSize: '1.6rem',
              fontWeight: 700,
              letterSpacing: '0.3em',
              color: '#00d4ff',
              textShadow: '0 0 20px rgba(0,212,255,0.5)',
            }}
          >
            ARGOS
          </div>
          <div
            style={{
              fontFamily: "'Courier New', monospace",
              fontSize: '0.6rem',
              letterSpacing: '0.2em',
              color: 'var(--muted)',
            }}
          >
            INITIAL SETUP
          </div>
        </div>

        <div className="hud-card" style={{ padding: '1.5rem' }}>
          <div className="label-mono mb-4" style={{ color: 'var(--muted)' }}>
            REGISTER AUTHENTICATION METHOD
          </div>

          {/* Method switcher */}
          <div className="flex gap-2 mb-5">
            {(['webauthn', 'totp'] as SetupMethod[]).map((m) => (
              <button
                key={m}
                onClick={() => setMethod(m)}
                style={{
                  flex: 1,
                  fontFamily: "'Courier New', monospace",
                  fontSize: '0.65rem',
                  fontWeight: 700,
                  letterSpacing: '0.1em',
                  padding: '0.6rem',
                  background: method === m ? 'rgba(0,212,255,0.1)' : 'transparent',
                  color: method === m ? '#00d4ff' : 'var(--muted)',
                  border: `1px solid ${method === m ? 'rgba(0,212,255,0.4)' : 'var(--border)'}`,
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                  outline: 'none',
                }}
              >
                {m === 'webauthn' ? 'YUBIKEY' : 'TOTP'}
              </button>
            ))}
          </div>

          {method === 'webauthn' && (
            <div className="flex flex-col gap-3">
              <input
                type="text"
                placeholder="Device name (e.g. YubiKey 5)"
                value={deviceName}
                onChange={(e) => setDeviceName(e.target.value)}
                style={{
                  width: '100%',
                  background: 'rgba(0,0,0,0.4)',
                  border: '1px solid var(--border)',
                  color: 'var(--text)',
                  fontFamily: "'Courier New', monospace",
                  fontSize: '0.75rem',
                  letterSpacing: '0.06em',
                  padding: '0.6rem 0.75rem',
                  outline: 'none',
                }}
              />
              <p
                style={{
                  fontFamily: "'Courier New', monospace",
                  fontSize: '0.6rem',
                  color: 'var(--muted)',
                  letterSpacing: '0.06em',
                  lineHeight: 1.7,
                }}
              >
                INSERT YUBIKEY AND CLICK REGISTER. TAP KEY WHEN BROWSER PROMPTS.
              </p>
              <button
                onClick={registerWebAuthn}
                disabled={loading || !deviceName.trim()}
                className="btn-primary w-full"
                style={{
                  padding: '0.875rem',
                  opacity: loading || !deviceName.trim() ? 0.4 : 1,
                }}
              >
                {loading ? 'WAITING FOR KEY...' : 'REGISTER YUBIKEY'}
              </button>
            </div>
          )}

          {method === 'totp' && totpStep === 'generate' && (
            <div className="flex flex-col gap-3">
              <p
                style={{
                  fontFamily: "'Courier New', monospace",
                  fontSize: '0.6rem',
                  color: 'var(--muted)',
                  letterSpacing: '0.06em',
                  lineHeight: 1.7,
                }}
              >
                SET UP AN AUTHENTICATOR APP AS BACKUP (GOOGLE AUTH, AUTHY, 1PASSWORD).
              </p>
              <button
                onClick={generateTotp}
                disabled={loading}
                className="btn-primary w-full"
                style={{ padding: '0.875rem', opacity: loading ? 0.4 : 1 }}
              >
                {loading ? 'GENERATING...' : 'GENERATE QR CODE'}
              </button>
            </div>
          )}

          {method === 'totp' && totpStep === 'verify' && (
            <div className="flex flex-col gap-3">
              {qrDataUrl && (
                <div className="flex flex-col items-center gap-2">
                  <div
                    style={{
                      padding: '0.75rem',
                      background: '#fff',
                      border: '1px solid var(--border)',
                      display: 'inline-flex',
                    }}
                  >
                    <img src={qrDataUrl} alt="TOTP QR Code" style={{ width: 160, height: 160 }} />
                  </div>
                  <span
                    style={{
                      fontFamily: "'Courier New', monospace",
                      fontSize: '0.6rem',
                      color: 'var(--muted)',
                      letterSpacing: '0.08em',
                    }}
                  >
                    SCAN WITH AUTHENTICATOR APP
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
                  background: 'rgba(0,0,0,0.4)',
                  border: '1px solid var(--border)',
                  color: '#00d4ff',
                  fontFamily: "'Courier New', monospace",
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
                className="btn-primary w-full"
                style={{
                  padding: '0.875rem',
                  opacity: loading || totpCode.length < 6 ? 0.4 : 1,
                }}
              >
                {loading ? 'VERIFYING...' : 'ACTIVATE'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
