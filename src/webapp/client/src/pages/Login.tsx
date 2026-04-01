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
    <div className="min-h-dvh flex items-center justify-center p-6" style={{ background: 'var(--bg)' }}>
      <div
        className="w-full max-w-sm rounded-2xl border p-8"
        style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
      >
        <h1 className="text-2xl font-bold text-center mb-2">🔭 Argos</h1>
        <p className="text-sm text-center mb-6" style={{ color: 'var(--muted)' }}>
          Sign in to your workspace
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
            <p className="text-sm text-center mb-4" style={{ color: 'var(--muted)' }}>
              Insert your YubiKey and tap it when prompted
            </p>
            <button
              onClick={loginWithWebAuthn}
              disabled={loading}
              className="w-full py-4 rounded-xl text-white font-semibold text-base transition-opacity"
              style={{ background: 'var(--accent)', opacity: loading ? 0.5 : 1 }}
            >
              {loading ? 'Waiting for key…' : 'Touch your YubiKey'}
            </button>
          </div>
        )}

        {method === 'totp' && (
          <div>
            <input
              type="text"
              inputMode="numeric"
              maxLength={6}
              placeholder="000000"
              value={totpCode}
              onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ''))}
              onKeyDown={(e) => e.key === 'Enter' && loginWithTOTP()}
              className="w-full py-3 px-4 rounded-xl border text-center text-xl tracking-widest mb-3"
              style={{
                background: 'var(--bg)',
                borderColor: 'var(--border)',
                color: 'var(--text)',
              }}
              autoFocus
            />
            <button
              onClick={loginWithTOTP}
              disabled={loading || totpCode.length < 6}
              className="w-full py-4 rounded-xl text-white font-semibold text-base transition-opacity"
              style={{ background: 'var(--accent)', opacity: loading || totpCode.length < 6 ? 0.5 : 1 }}
            >
              {loading ? 'Verifying…' : 'Sign In'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
