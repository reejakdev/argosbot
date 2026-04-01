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
    <div className="min-h-dvh flex items-center justify-center p-6" style={{ background: 'var(--bg)' }}>
      <div
        className="w-full max-w-sm rounded-2xl border p-8"
        style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
      >
        <h1 className="text-2xl font-bold text-center mb-2">🔭 Argos Setup</h1>
        <p className="text-sm text-center mb-6" style={{ color: 'var(--muted)' }}>
          Register your authentication method to secure access
        </p>

        {/* Method switcher */}
        <div className="flex gap-2 mb-6">
          <button
            onClick={() => setMethod('webauthn')}
            className="flex-1 py-3 rounded-xl text-sm font-medium border transition-all"
            style={{
              background: method === 'webauthn' ? 'rgba(37,99,235,0.1)' : 'var(--bg)',
              borderColor: method === 'webauthn' ? 'var(--accent)' : 'var(--border)',
              color: method === 'webauthn' ? 'var(--text)' : 'var(--muted)',
            }}
          >
            🔑 YubiKey
          </button>
          <button
            onClick={() => setMethod('totp')}
            className="flex-1 py-3 rounded-xl text-sm font-medium border transition-all"
            style={{
              background: method === 'totp' ? 'rgba(37,99,235,0.1)' : 'var(--bg)',
              borderColor: method === 'totp' ? 'var(--accent)' : 'var(--border)',
              color: method === 'totp' ? 'var(--text)' : 'var(--muted)',
            }}
          >
            📱 TOTP
          </button>
        </div>

        {method === 'webauthn' && (
          <div>
            <input
              type="text"
              placeholder="Device name (e.g. YubiKey 5)"
              value={deviceName}
              onChange={(e) => setDeviceName(e.target.value)}
              className="w-full py-3 px-4 rounded-xl border mb-3 text-sm"
              style={{ background: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--text)' }}
            />
            <p className="text-xs mb-4" style={{ color: 'var(--muted)' }}>
              Insert your YubiKey and click Register. Tap the key when the browser prompts you.
            </p>
            <button
              onClick={registerWebAuthn}
              disabled={loading || !deviceName.trim()}
              className="w-full py-4 rounded-xl text-white font-semibold text-base transition-opacity"
              style={{ background: 'var(--accent)', opacity: loading || !deviceName.trim() ? 0.5 : 1 }}
            >
              {loading ? 'Waiting for key…' : 'Register YubiKey'}
            </button>
          </div>
        )}

        {method === 'totp' && totpStep === 'generate' && (
          <div>
            <p className="text-sm mb-4" style={{ color: 'var(--muted)' }}>
              Set up an authenticator app (Google Authenticator, Authy, 1Password) as a backup.
            </p>
            <button
              onClick={generateTotp}
              disabled={loading}
              className="w-full py-4 rounded-xl text-white font-semibold text-base transition-opacity"
              style={{ background: 'var(--accent)', opacity: loading ? 0.5 : 1 }}
            >
              {loading ? 'Generating…' : 'Generate QR Code'}
            </button>
          </div>
        )}

        {method === 'totp' && totpStep === 'verify' && (
          <div>
            {qrDataUrl && (
              <div className="flex flex-col items-center mb-4">
                <img src={qrDataUrl} alt="TOTP QR Code" className="rounded-xl w-48 h-48" />
                <p className="text-xs mt-2" style={{ color: 'var(--muted)' }}>
                  Scan with your authenticator app
                </p>
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
              className="w-full py-3 px-4 rounded-xl border text-center text-xl tracking-widest mb-3"
              style={{ background: 'var(--bg)', borderColor: 'var(--border)', color: 'var(--text)' }}
              autoFocus
            />
            <button
              onClick={verifyTotp}
              disabled={loading || totpCode.length < 6}
              className="w-full py-4 rounded-xl text-white font-semibold text-base transition-opacity"
              style={{ background: 'var(--accent)', opacity: loading || totpCode.length < 6 ? 0.5 : 1 }}
            >
              {loading ? 'Verifying…' : 'Activate'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
