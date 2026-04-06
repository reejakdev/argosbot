import { useState, useEffect, useCallback } from 'react';
import { get, post, patch, del } from '../api.ts';

// ─── Config types ──────────────────────────────────────────────────────────────

interface ModelProvider {
  name?:    string;
  api:      'anthropic' | 'openai';
  auth:     'api-key' | 'bearer';
  apiKey?:  string;
  baseUrl?: string;
  models:   string[];
}

type PrivacyRole = 'privacy' | 'primary';

interface PrivacyRoles { sanitize: PrivacyRole; classify: PrivacyRole; triage: PrivacyRole; llmAnon: PrivacyRole; plan: PrivacyRole; }

interface AgentTrigger { keywords: string[]; categories: string[]; channels: string[]; minImportance: number; }

interface AgentDef {
  name:              string;
  description:       string;
  systemPrompt:      string;
  tools:             string[];
  maxIterations:     number;
  temperature:       number;
  maxTokens:         number;
  enabled:           boolean;
  provider?:         string;
  model?:            string;
  isolatedWorkspace: boolean;
  linkedChannels:    string[];
  triggers:          AgentTrigger[];
}

interface ArgosConfig {
  llm: {
    activeProvider: string; activeModel: string;
    fallbackProvider?: string; fallbackModel?: string;
    thinking: { planner: boolean; chat: boolean; heartbeat: boolean };
    providers: Record<string, ModelProvider>;
  };
  privacy: {
    provider?: string; model?: string;
    storeRaw: boolean; encryptMessages: boolean;
    roles: PrivacyRoles;
  };
  voice?: {
    enabled: boolean; whisperBackend: 'api' | 'local';
    whisperModel: string; whisperEndpoint: string; whisperApiKey?: string;
    ttsEnabled?: boolean; ttsProvider: 'openai' | 'elevenlabs' | 'local';
    localTtsVoice?: string; ttsLanguage?: string;
    openAiTtsModel: string; openAiTtsVoice: string;
    elevenLabsVoiceId?: string;
    ttsTriggers?: Record<string, string>;
    immersive?: boolean;
    display?: { botName?: string; logoUrl?: string; accentColor?: string; port?: number; stars?: boolean };
    effects?: { reverb?: number; delay?: number; delayTime?: number };
  };
  embeddings?: { enabled: boolean; model: string; baseUrl: string; localOnly?: boolean };
  mcpServers?: { name: string; type: string; command?: string; url?: string; args?: string[]; env?: Record<string, string>; enabled: boolean; toolPolicy?: Record<string, string> }[];
  skills?:     { name: string; enabled: boolean; config?: Record<string, unknown> }[];
  agents?:     AgentDef[];
  triage?: {
    enabled: boolean; myHandles: string[]; ignoreOwnTeam: boolean;
    mentionOnly: boolean; notionTodoDatabaseId?: string;
  };
  heartbeat?: { enabled: boolean; intervalMinutes: number; prompt?: string };
  memory?: { defaultTtlDays: number; archiveTtlDays: number; purgeIntervalHours: number; autoArchiveThreshold: number };
  approval?: { defaultExpiryMs: number; criticalExpiryMs: number; doubleTapCritical: boolean };
  anonymizer?: { mode: 'regex' | 'none'; knownPersons: string[]; bucketAmounts: boolean; anonymizeCryptoAddresses: boolean };
  claude?: { customInstructions?: string; planningTemperature: number; maxTokens: number; maxIterations: number };
  shellExec?: { enabled: boolean; allowedCommands: string[]; workingDir?: string };
  orchestration?: { enabled: boolean; maxSubAgents: number; timeoutSeconds: number };
  channels?: {
    telegram?: {
      listener?: { mode: string; discoverUnknownChats: boolean; ignoredSenders?: string[]; contextWindow?: { waitMs: number; maxMessages: number } };
      personal?: { approvalChatId?: string };
    };
    slack?: { listener?: { enabled: boolean; pollIntervalSeconds: number; monitorDMs: boolean } };
    discord?: { enabled: boolean; monitorDMs: boolean };
    whatsapp?: { approvalJid?: string };
  };
  notifications?: { preferredChannel?: string };
  security?: { cloudMode: boolean };
  readOnly: boolean;
  logLevel?: string;
}

// ─── Tabs ──────────────────────────────────────────────────────────────────────

type Tab = 'models' | 'privacy' | 'voice' | 'channels' | 'pipeline' | 'agents' | 'plugins' | 'secrets';
const TABS: { id: Tab; label: string }[] = [
  { id: 'models',   label: 'Models'       },
  { id: 'privacy',  label: 'Privacy'      },
  { id: 'voice',    label: 'Voice / STT'  },
  { id: 'channels', label: 'Channels'     },
  { id: 'pipeline', label: 'Pipeline'     },
  { id: 'agents',   label: 'Agents'       },
  { id: 'plugins',  label: 'MCP & Skills' },
  { id: 'secrets',  label: 'Secrets'      },
];

// ─── Primitives ────────────────────────────────────────────────────────────────

const mono:  React.CSSProperties = { fontFamily: "'JetBrains Mono', monospace" };
const inter: React.CSSProperties = { fontFamily: "'Inter', sans-serif" };

const cardStyle: React.CSSProperties = {
  background: 'var(--surface)', border: '1px solid var(--border)',
  borderRadius: '10px', padding: '1.1rem',
};

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div style={{ ...mono, fontSize: '0.58rem', fontWeight: 700, letterSpacing: '0.14em',
    textTransform: 'uppercase' as const, color: 'var(--text2)', marginBottom: '0.75rem',
    paddingBottom: '0.4rem', borderBottom: '1px solid var(--border)' }}>{children}</div>;
}

function FieldRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 mb-3">
      <div className="flex items-center gap-2">
        <span style={{ ...inter, fontSize: '0.775rem', fontWeight: 600, color: 'var(--text)' }}>{label}</span>
        {hint && <span style={{ ...inter, fontSize: '0.68rem', color: 'var(--text2)' }}>{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function Input({ value, onChange, placeholder, type = 'text', style }:
  { value: string; onChange: (v: string) => void; placeholder?: string; type?: string; style?: React.CSSProperties }) {
  return <input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
    style={{ ...mono, fontSize: '0.72rem', color: 'var(--text)', background: 'var(--bg)',
      border: '1px solid var(--border)', borderRadius: '6px', padding: '0.45rem 0.65rem',
      width: '100%', outline: 'none', ...style }} />;
}

function NumberInput({ value, onChange, min, max, step = 1 }:
  { value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number }) {
  return <input type="number" value={value} min={min} max={max} step={step}
    onChange={e => onChange(Number(e.target.value))}
    style={{ ...mono, fontSize: '0.72rem', color: 'var(--text)', background: 'var(--bg)',
      border: '1px solid var(--border)', borderRadius: '6px', padding: '0.45rem 0.65rem',
      width: '100px', outline: 'none' }} />;
}

function Textarea({ value, onChange, placeholder, rows = 4 }:
  { value: string; onChange: (v: string) => void; placeholder?: string; rows?: number }) {
  return <textarea value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} rows={rows}
    style={{ ...mono, fontSize: '0.7rem', color: 'var(--text)', background: 'var(--bg)',
      border: '1px solid var(--border)', borderRadius: '6px', padding: '0.5rem 0.65rem',
      width: '100%', outline: 'none', resize: 'vertical', lineHeight: 1.5 }} />;
}

function Select({ value, onChange, options, style }:
  { value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; style?: React.CSSProperties }) {
  return <select value={value} onChange={e => onChange(e.target.value)}
    style={{ ...mono, fontSize: '0.72rem', color: 'var(--text)', background: 'var(--bg)',
      border: '1px solid var(--border)', borderRadius: '6px', padding: '0.45rem 0.65rem',
      outline: 'none', cursor: 'pointer', ...style }}>
    {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
  </select>;
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <label className="flex items-center gap-2 cursor-pointer" style={{ userSelect: 'none' }}>
      <div onClick={() => onChange(!checked)} style={{
        width: 34, height: 18, borderRadius: 9, position: 'relative', cursor: 'pointer',
        background: checked ? '#4f6eff' : 'var(--border)', transition: 'background 0.2s', flexShrink: 0,
      }}>
        <div style={{ position: 'absolute', top: 2, left: checked ? 18 : 2, width: 14, height: 14,
          borderRadius: '50%', background: 'white', boxShadow: '0 1px 3px rgba(0,0,0,0.2)', transition: 'left 0.2s' }} />
      </div>
      {label && <span style={{ ...inter, fontSize: '0.775rem', color: 'var(--text)' }}>{label}</span>}
    </label>
  );
}

function ToggleRow({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-4 py-3" style={{ borderBottom: '1px solid var(--border)' }}>
      <div>
        <div style={{ ...inter, fontSize: '0.775rem', fontWeight: 600, color: 'var(--text)' }}>{label}</div>
        {hint && <div style={{ ...inter, fontSize: '0.68rem', color: 'var(--text2)', marginTop: '0.1rem', lineHeight: 1.5 }}>{hint}</div>}
      </div>
      <Toggle checked={checked} onChange={onChange} />
    </div>
  );
}

// Tag input (chips)
function TagInput({ values, onChange, placeholder }: { values: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  const [input, setInput] = useState('');
  function add() {
    const v = input.trim();
    if (v && !values.includes(v)) onChange([...values, v]);
    setInput('');
  }
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: '6px', padding: '0.3rem 0.5rem',
      background: 'var(--bg)', display: 'flex', flexWrap: 'wrap', gap: '0.3rem', alignItems: 'center' }}>
      {values.map(v => (
        <span key={v} style={{ ...mono, fontSize: '0.65rem', background: 'rgba(79,110,255,0.12)',
          color: '#4f6eff', borderRadius: '4px', padding: '0.15rem 0.4rem', display: 'flex', alignItems: 'center', gap: 4 }}>
          {v}
          <button onClick={() => onChange(values.filter(x => x !== v))} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4f6eff', fontSize: '0.7rem', padding: 0, lineHeight: 1 }}>×</button>
        </span>
      ))}
      <input value={input} onChange={e => setInput(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); } }}
        placeholder={placeholder ?? 'Type + Enter'}
        style={{ ...mono, fontSize: '0.68rem', background: 'none', border: 'none', outline: 'none', color: 'var(--text)', minWidth: 80, flex: 1 }} />
    </div>
  );
}

// Save bar
function useSave(onSaved?: () => void) {
  const [saving, setSaving] = useState(false);
  const [saved,  setSaved]  = useState(false);
  const [error,  setError]  = useState<string | null>(null);
  const [needsRestart, setNeedsRestart] = useState(false);
  const save = useCallback(async (data: Record<string, unknown>) => {
    setSaving(true); setError(null); setSaved(false); setNeedsRestart(false);
    try {
      const res = await patch<{ ok: boolean; requiresRestart?: boolean }>('/configure/config', data);
      setSaved(true);
      if (res.requiresRestart) setNeedsRestart(true);
      onSaved?.();
      setTimeout(() => setSaved(false), 4000);
    } catch (e) { setError(String(e)); }
    finally { setSaving(false); }
  }, [onSaved]);
  return { saving, saved, error, needsRestart, save };
}

function SaveBar({ saving, saved, error, needsRestart, onSave }: { saving: boolean; saved: boolean; error: string | null; needsRestart?: boolean; onSave: () => void }) {
  return (
    <div className="flex items-center justify-between mt-5 pt-4" style={{ borderTop: '1px solid var(--border)' }}>
      <div style={{ ...inter, fontSize: '0.72rem' }}>
        {error && <span style={{ color: '#ef4444' }}>{error}</span>}
        {saved && !error && !needsRestart && <span style={{ color: '#059669' }}>Saved</span>}
        {saved && !error && needsRestart && <span style={{ color: '#d97706' }}>Saved — restart Argos to apply (argos restart)</span>}
      </div>
      <button onClick={onSave} disabled={saving} style={{
        ...mono, fontSize: '0.65rem', fontWeight: 700, letterSpacing: '0.08em',
        textTransform: 'uppercase' as const,
        background: saving ? 'rgba(79,110,255,0.3)' : '#4f6eff', color: 'white',
        border: 'none', borderRadius: '6px', padding: '0.5rem 1.2rem', cursor: saving ? 'default' : 'pointer',
      }}>
        {saving ? 'Saving…' : 'Save'}
      </button>
    </div>
  );
}

// ─── Provider presets ─────────────────────────────────────────────────────────

interface ProviderPreset {
  id:       string;
  name:     string;
  api:      'anthropic' | 'openai';
  baseUrl?: string;
  models:   string[];
  secretKey: string;
  badge?:   string;
}

const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'openai', name: 'OpenAI', api: 'openai', models: ['gpt-4o', 'gpt-4o-mini', 'o3', 'o3-mini', 'o4-mini'],
    secretKey: 'OPENAI_API_KEY', badge: 'cloud',
  },
  {
    id: 'anthropic', name: 'Anthropic', api: 'anthropic', models: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'],
    secretKey: 'ANTHROPIC_API_KEY', badge: 'cloud',
  },
  {
    id: 'groq', name: 'Groq', api: 'openai', baseUrl: 'https://api.groq.com/openai/v1',
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'moonshotai/kimi-k2-instruct', 'deepseek-r1-distill-llama-70b'],
    secretKey: 'GROQ_API_KEY', badge: 'fast',
  },
  {
    id: 'gemini', name: 'Google Gemini', api: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-1.5-pro'],
    secretKey: 'GEMINI_API_KEY', badge: 'cloud',
  },
  {
    id: 'deepseek', name: 'DeepSeek', api: 'openai', baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    secretKey: 'DEEPSEEK_API_KEY', badge: 'cheap',
  },
  {
    id: 'mistral', name: 'Mistral', api: 'openai', baseUrl: 'https://api.mistral.ai/v1',
    models: ['mistral-large-latest', 'mistral-medium-latest', 'codestral-latest', 'open-mistral-7b'],
    secretKey: 'MISTRAL_API_KEY', badge: 'cloud',
  },
  {
    id: 'xai', name: 'xAI (Grok)', api: 'openai', baseUrl: 'https://api.x.ai/v1',
    models: ['grok-3', 'grok-3-mini', 'grok-3-fast'],
    secretKey: 'XAI_API_KEY', badge: 'cloud',
  },
  {
    id: 'together', name: 'Together AI', api: 'openai', baseUrl: 'https://api.together.xyz/v1',
    models: ['meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo', 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo', 'Qwen/Qwen2.5-72B-Instruct-Turbo'],
    secretKey: 'TOGETHER_API_KEY', badge: 'cloud',
  },
  {
    id: 'perplexity', name: 'Perplexity', api: 'openai', baseUrl: 'https://api.perplexity.ai',
    models: ['llama-3.1-sonar-huge-128k-online', 'llama-3.1-sonar-large-128k-online'],
    secretKey: 'PERPLEXITY_API_KEY', badge: 'search',
  },
  {
    id: 'cohere', name: 'Cohere', api: 'openai', baseUrl: 'https://api.cohere.com/compatibility/v1',
    models: ['command-r-plus', 'command-r', 'command-a-03-2025'],
    secretKey: 'COHERE_API_KEY', badge: 'cloud',
  },
  {
    id: 'ollama', name: 'Ollama', api: 'openai', baseUrl: 'http://localhost:11434/v1',
    models: ['llama3.3:70b', 'llama3.2:3b', 'qwen2.5:7b', 'mistral:7b', 'deepseek-r1:7b'],
    secretKey: '', badge: 'local',
  },
  {
    id: 'lmstudio', name: 'LM Studio', api: 'openai', baseUrl: 'http://localhost:1234/v1',
    models: [],
    secretKey: '', badge: 'local',
  },
];

const BADGE_STYLE: Record<string, { color: string; bg: string }> = {
  cloud: { color: '#4f6eff', bg: 'rgba(79,110,255,0.1)'  },
  fast:  { color: '#f59e0b', bg: 'rgba(245,158,11,0.1)'  },
  cheap: { color: '#059669', bg: 'rgba(5,150,105,0.1)'   },
  local: { color: '#7c3aed', bg: 'rgba(124,58,237,0.1)'  },
  search:{ color: '#0891b2', bg: 'rgba(8,145,178,0.1)'   },
};

// ─── Tab: Models ──────────────────────────────────────────────────────────────

function ModelsTab({ cfg, onSaved }: { cfg: ArgosConfig; onSaved?: () => void }) {
  const { saving, saved, error, needsRestart, save } = useSave(onSaved);
  const providers = Object.entries(cfg.llm.providers);
  const provOpts   = providers.map(([id, p]) => ({ value: id, label: p.name ?? id }));

  const [activeProvider,   setActiveProvider]   = useState(cfg.llm.activeProvider);
  const [activeModel,      setActiveModel]      = useState(cfg.llm.activeModel);
  const [fallbackProvider, setFallbackProvider] = useState(cfg.llm.fallbackProvider ?? '');
  const [fallbackModel,    setFallbackModel]    = useState(cfg.llm.fallbackModel ?? '');
  const [thinking,         setThinking]         = useState(cfg.llm.thinking);
  const [addingProv,  setAddingProv]  = useState(false);
  const [newProvId,   setNewProvId]   = useState('');
  const [newProv,     setNewProv]     = useState<Partial<ModelProvider>>({ api: 'openai', auth: 'api-key', models: [] });
  const [customMode,  setCustomMode]  = useState(false);

  function modelsFor(pid: string) {
    const p = cfg.llm.providers[pid];
    if (!p?.models?.length) return [] as { value: string; label: string }[];
    return p.models.map(m => ({ value: m, label: m }));
  }

  const activeProvModel = cfg.llm.providers[activeProvider];
  const fallbackProvModel = fallbackProvider ? cfg.llm.providers[fallbackProvider] : null;

  return (
    <div className="flex flex-col gap-4">
      {/* Primary */}
      <div style={cardStyle}>
        <SectionTitle>Primary model — planner · executor · chat · heartbeat</SectionTitle>
        <div style={{ ...inter, fontSize: '0.68rem', color: 'var(--text2)', marginBottom: '0.75rem', lineHeight: 1.5 }}>
          The main brain. Used for all high-level reasoning. Receives only anonymized content.
        </div>
        <div className="flex gap-3 flex-wrap">
          <FieldRow label="Provider">
            <Select value={activeProvider} onChange={v => { setActiveProvider(v); setActiveModel(cfg.llm.providers[v]?.models?.[0] ?? ''); }}
              options={provOpts} style={{ minWidth: 160 }} />
          </FieldRow>
          <FieldRow label="Model">
            {activeProvModel?.models?.length
              ? <Select value={activeModel} onChange={setActiveModel} options={modelsFor(activeProvider)} style={{ minWidth: 240 }} />
              : <Input value={activeModel} onChange={setActiveModel} placeholder="model-id" style={{ width: 240 }} />}
          </FieldRow>
        </div>
      </div>

      {/* Fallback */}
      <div style={cardStyle}>
        <SectionTitle>Fallback model — 5xx · 429 · timeout</SectionTitle>
        <div style={{ ...inter, fontSize: '0.68rem', color: 'var(--text2)', marginBottom: '0.75rem' }}>
          Automatically used when the primary fails. Set to none to surface errors directly.
        </div>
        <div className="flex gap-3 flex-wrap">
          <FieldRow label="Provider">
            <Select value={fallbackProvider} onChange={v => { setFallbackProvider(v); setFallbackModel(cfg.llm.providers[v]?.models?.[0] ?? ''); }}
              options={[{ value: '', label: '— none —' }, ...provOpts]} style={{ minWidth: 160 }} />
          </FieldRow>
          {fallbackProvider && (
            <FieldRow label="Model">
              {fallbackProvModel?.models?.length
                ? <Select value={fallbackModel} onChange={setFallbackModel} options={modelsFor(fallbackProvider)} style={{ minWidth: 240 }} />
                : <Input value={fallbackModel} onChange={setFallbackModel} placeholder="model-id" style={{ width: 240 }} />}
            </FieldRow>
          )}
        </div>
      </div>

      {/* Extended thinking */}
      <div style={cardStyle}>
        <SectionTitle>Extended thinking</SectionTitle>
        {(['planner', 'chat', 'heartbeat'] as const).map(k => {
          const desc: Record<string, string> = {
            planner: 'Chain-of-thought for proposal generation (slower, smarter)',
            chat:    'Deep reasoning for conversational replies',
            heartbeat: 'Extended analysis during proactive monitoring',
          };
          return (
            <ToggleRow key={k} label={k.charAt(0).toUpperCase() + k.slice(1)}
              hint={desc[k]} checked={thinking[k]}
              onChange={v => setThinking(t => ({ ...t, [k]: v }))} />
          );
        })}
      </div>

      {/* Providers */}
      <div style={cardStyle}>
        <div className="flex items-center justify-between mb-3">
          <SectionTitle>LLM Providers</SectionTitle>
          <button onClick={() => setAddingProv(a => !a)} style={{
            ...mono, fontSize: '0.6rem', fontWeight: 700, letterSpacing: '0.06em',
            textTransform: 'uppercase' as const,
            background: 'transparent', border: '1px solid var(--border)', borderRadius: '5px',
            padding: '0.3rem 0.7rem', cursor: 'pointer', color: 'var(--text2)',
          }}>+ Add</button>
        </div>

        {addingProv && (
          <div className="mb-4 p-3" style={{ background: 'rgba(79,110,255,0.04)', borderRadius: '8px', border: '1px solid rgba(79,110,255,0.15)' }}>
            {!customMode ? (
              <>
                {/* Preset grid */}
                <div style={{ ...inter, fontSize: '0.68rem', fontWeight: 600, color: 'var(--text2)', marginBottom: '0.5rem' }}>Choose a provider</div>
                <div className="flex flex-wrap gap-2 mb-3">
                  {PROVIDER_PRESETS.filter(p => !cfg.llm.providers[p.id]).map(preset => {
                    const badgeStyle = preset.badge ? BADGE_STYLE[preset.badge] : BADGE_STYLE.cloud;
                    return (
                      <button key={preset.id} onClick={() => {
                        setNewProvId(preset.id);
                        setNewProv({ name: preset.name, api: preset.api, auth: 'api-key', baseUrl: preset.baseUrl, models: preset.models });
                        setCustomMode(true);
                      }} style={{
                        ...inter, fontSize: '0.72rem', fontWeight: 500,
                        background: 'var(--surface)', border: '1px solid var(--border)',
                        borderRadius: '7px', padding: '0.4rem 0.8rem', cursor: 'pointer',
                        color: 'var(--text)', display: 'flex', alignItems: 'center', gap: '0.4rem',
                      }}>
                        {preset.name}
                        {preset.badge && (
                          <span style={{ ...mono, fontSize: '0.5rem', fontWeight: 700, letterSpacing: '0.06em',
                            textTransform: 'uppercase', color: badgeStyle.color, background: badgeStyle.bg,
                            borderRadius: '3px', padding: '0.1rem 0.3rem' }}>
                            {preset.badge}
                          </span>
                        )}
                      </button>
                    );
                  })}
                  <button onClick={() => { setNewProvId(''); setNewProv({ api: 'openai', auth: 'api-key', models: [] }); setCustomMode(true); }}
                    style={{ ...inter, fontSize: '0.72rem', fontWeight: 500, background: 'transparent',
                      border: '1px dashed var(--border)', borderRadius: '7px', padding: '0.4rem 0.8rem',
                      cursor: 'pointer', color: 'var(--text2)' }}>
                    Custom…
                  </button>
                </div>
                <button onClick={() => setAddingProv(false)} style={{ ...mono, fontSize: '0.62rem', background: 'transparent', border: '1px solid var(--border)', borderRadius: '5px', padding: '0.3rem 0.7rem', cursor: 'pointer', color: 'var(--text2)' }}>Cancel</button>
              </>
            ) : (
              <>
                {/* Config form */}
                <div className="flex gap-2 flex-wrap mb-2">
                  <FieldRow label="ID (key)">
                    <Input value={newProvId} onChange={setNewProvId} placeholder="e.g. openai" style={{ width: 130 }} />
                  </FieldRow>
                  <FieldRow label="Display name">
                    <Input value={newProv.name ?? ''} onChange={v => setNewProv(p => ({ ...p, name: v }))} placeholder="OpenAI" style={{ width: 150 }} />
                  </FieldRow>
                  <FieldRow label="API format">
                    <Select value={newProv.api ?? 'openai'} onChange={v => setNewProv(p => ({ ...p, api: v as 'openai' | 'anthropic' }))}
                      options={[{ value: 'openai', label: 'OpenAI-compatible' }, { value: 'anthropic', label: 'Anthropic SDK' }]} />
                  </FieldRow>
                </div>
                <FieldRow label="Base URL" hint="leave blank for provider default (OpenAI, Anthropic)">
                  <Input value={newProv.baseUrl ?? ''} onChange={v => setNewProv(p => ({ ...p, baseUrl: v || undefined }))} placeholder="https://api.example.com/v1" />
                </FieldRow>
                <FieldRow label="Model IDs" hint="press Enter after each model">
                  <TagInput values={newProv.models ?? []} onChange={v => setNewProv(p => ({ ...p, models: v }))} placeholder="gpt-4o" />
                </FieldRow>
                {/* API key hint */}
                {(() => {
                  const preset = PROVIDER_PRESETS.find(p => p.id === newProvId);
                  const secretName = preset?.secretKey || (newProvId ? `${newProvId.toUpperCase()}_API_KEY` : null);
                  const isLocal = preset?.badge === 'local';
                  return secretName && !isLocal ? (
                    <div style={{ ...inter, fontSize: '0.68rem', color: 'var(--text2)', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: '6px', padding: '0.5rem 0.75rem', marginBottom: '0.5rem' }}>
                      API key required → go to <strong>Secrets</strong> tab and add <code style={{ ...mono, color: '#4f6eff' }}>{secretName}</code>
                    </div>
                  ) : isLocal ? (
                    <div style={{ ...inter, fontSize: '0.68rem', color: '#059669', marginBottom: '0.5rem' }}>
                      Local model — no API key needed. Make sure the server is running.
                    </div>
                  ) : null;
                })()}
                <div className="flex gap-2">
                  <button onClick={() => {
                    if (!newProvId.trim()) return;
                    const id = newProvId.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
                    save({ llm: { ...cfg.llm, providers: { ...cfg.llm.providers, [id]: { ...newProv, models: newProv.models ?? [] } } } });
                    setAddingProv(false); setCustomMode(false); setNewProvId(''); setNewProv({ api: 'openai', auth: 'api-key', models: [] });
                  }} style={{ ...mono, fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' as const, background: '#4f6eff', color: 'white', border: 'none', borderRadius: '5px', padding: '0.35rem 0.9rem', cursor: 'pointer' }}>Save provider</button>
                  <button onClick={() => setCustomMode(false)} style={{ ...mono, fontSize: '0.62rem', background: 'transparent', border: '1px solid var(--border)', borderRadius: '5px', padding: '0.35rem 0.9rem', cursor: 'pointer', color: 'var(--text2)' }}>← Back</button>
                </div>
              </>
            )}
          </div>
        )}

        {providers.map(([id, p]) => (
          <div key={id} className="flex items-center gap-3 py-2.5" style={{ borderBottom: '1px solid var(--border)' }}>
            <div className="flex-1">
              <div className="flex items-center gap-2">
                <span style={{ ...inter, fontSize: '0.775rem', fontWeight: 600, color: 'var(--text)' }}>{p.name ?? id}</span>
                <span style={{ ...mono, fontSize: '0.55rem', color: '#4f6eff', background: 'rgba(79,110,255,0.1)', padding: '0.1rem 0.35rem', borderRadius: 3 }}>{p.api}</span>
                {id === activeProvider && <span style={{ ...mono, fontSize: '0.55rem', color: '#059669', background: 'rgba(5,150,105,0.1)', padding: '0.1rem 0.35rem', borderRadius: 3 }}>primary</span>}
                {id === fallbackProvider && <span style={{ ...mono, fontSize: '0.55rem', color: '#f59e0b', background: 'rgba(245,158,11,0.1)', padding: '0.1rem 0.35rem', borderRadius: 3 }}>fallback</span>}
              </div>
              <div style={{ ...mono, fontSize: '0.62rem', color: 'var(--text2)', marginTop: '0.1rem' }}>
                {p.baseUrl ?? 'default endpoint'} · {p.models?.join(', ') || 'no models listed'}
              </div>
            </div>
          </div>
        ))}
      </div>

      <SaveBar saving={saving} saved={saved} error={error} needsRestart={needsRestart} onSave={() => save({
        llm: { ...cfg.llm, activeProvider, activeModel,
          fallbackProvider: fallbackProvider || undefined,
          fallbackModel: fallbackModel || undefined, thinking },
      })} />
    </div>
  );
}

// ─── Tab: Privacy ─────────────────────────────────────────────────────────────

const ROLE_META: Record<string, { desc: string }> = {
  sanitize: { desc: 'Injection detection — sees RAW content before anonymization' },
  classify: { desc: 'Message classification — partner/team routing' },
  triage:   { desc: 'Inbox pre-scan — determines isMyTask, importance' },
  llmAnon:  { desc: 'LLM-assisted anonymization second pass' },
  plan:     { desc: 'Planning & reasoning — receives only anonymized content' },
};

function PrivacyTab({ cfg, onSaved }: { cfg: ArgosConfig; onSaved?: () => void }) {
  const { saving, saved, error, needsRestart, save } = useSave(onSaved);
  const provOpts = Object.entries(cfg.llm.providers).map(([id, p]) => ({ value: id, label: p.name ?? id }));

  const [privProvider, setPrivProvider] = useState(cfg.privacy.provider ?? '');
  const [privModel,    setPrivModel]    = useState(cfg.privacy.model ?? '');
  const [storeRaw,     setStoreRaw]     = useState(cfg.privacy.storeRaw ?? false);
  const [encryptMsgs,  setEncryptMsgs]  = useState(cfg.privacy.encryptMessages ?? false);
  const [roles,        setRoles]        = useState<PrivacyRoles>(cfg.privacy.roles ?? { sanitize: 'privacy', classify: 'privacy', triage: 'privacy', llmAnon: 'privacy', plan: 'primary' });

  const privProv = privProvider ? cfg.llm.providers[privProvider] : null;

  return (
    <div className="flex flex-col gap-4">
      <div style={cardStyle}>
        <SectionTitle>Privacy model — local LLM for sensitive roles</SectionTitle>
        <div style={{ ...inter, fontSize: '0.72rem', color: 'var(--text2)', marginBottom: '0.75rem', lineHeight: 1.5 }}>
          Roles set to <strong>local</strong> use this model. Raw content never leaves the machine.
          If unset, all roles fall through to the primary model.
        </div>
        <div className="flex gap-3 flex-wrap">
          <FieldRow label="Provider">
            <Select value={privProvider} onChange={v => { setPrivProvider(v); setPrivModel(cfg.llm.providers[v]?.models?.[0] ?? ''); }}
              options={[{ value: '', label: '— same as primary —' }, ...provOpts]} style={{ minWidth: 180 }} />
          </FieldRow>
          {privProvider && (
            <FieldRow label="Model">
              {privProv?.models?.length
                ? <Select value={privModel} onChange={setPrivModel} options={privProv.models.map(m => ({ value: m, label: m }))} style={{ minWidth: 220 }} />
                : <Input value={privModel} onChange={setPrivModel} placeholder="llama3.2:3b" style={{ width: 220 }} />}
            </FieldRow>
          )}
        </div>
      </div>

      <div style={cardStyle}>
        <SectionTitle>Role routing — who processes what</SectionTitle>
        <div style={{ ...inter, fontSize: '0.68rem', color: 'var(--text2)', marginBottom: '0.75rem' }}>
          <strong>local</strong> = privacy model · <strong>cloud</strong> = primary model (anonymized content only)
        </div>
        {(Object.keys(ROLE_META) as (keyof PrivacyRoles)[]).map(r => (
          <div key={r} className="flex items-center gap-3 py-2.5" style={{ borderBottom: '1px solid var(--border)' }}>
            <div className="flex-1">
              <div style={{ ...inter, fontSize: '0.775rem', fontWeight: 600, color: 'var(--text)', textTransform: 'capitalize' }}>{r}</div>
              <div style={{ ...inter, fontSize: '0.68rem', color: 'var(--text2)', marginTop: '0.1rem' }}>{ROLE_META[r].desc}</div>
            </div>
            <div className="flex gap-1">
              {(['privacy', 'primary'] as PrivacyRole[]).map(v => (
                <button key={v} onClick={() => setRoles(prev => ({ ...prev, [r]: v }))} style={{
                  ...mono, fontSize: '0.58rem', fontWeight: 700, letterSpacing: '0.05em',
                  textTransform: 'uppercase' as const,
                  padding: '0.25rem 0.6rem', borderRadius: '4px', cursor: 'pointer',
                  border: roles[r] === v ? 'none' : '1px solid var(--border)',
                  background: roles[r] === v ? (v === 'privacy' ? 'rgba(5,150,105,0.15)' : 'rgba(79,110,255,0.15)') : 'transparent',
                  color: roles[r] === v ? (v === 'privacy' ? '#059669' : '#4f6eff') : 'var(--text2)',
                }}>
                  {v === 'privacy' ? '🔒 local' : '☁ cloud'}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div style={cardStyle}>
        <SectionTitle>Storage</SectionTitle>
        <ToggleRow label="Store raw content" hint="Persists pre-anonymization content in memories.raw_content. Local LLM roles only. Disabled by default." checked={storeRaw} onChange={setStoreRaw} />
        <ToggleRow label="Encrypt messages at rest" hint="AES-256-GCM. Key at ~/.argos/message.key. Decrypt: npm run decrypt -- <id>." checked={encryptMsgs} onChange={setEncryptMsgs} />
      </div>

      <SaveBar saving={saving} saved={saved} error={error} needsRestart={needsRestart} onSave={() => save({
        privacy: { provider: privProvider || undefined, model: privModel || undefined, storeRaw, encryptMessages: encryptMsgs, roles },
      })} />
    </div>
  );
}

// ─── Tab: Voice / STT ─────────────────────────────────────────────────────────

const WHISPER_MODELS = ['whisper-1', 'tiny', 'base', 'small', 'medium', 'large', 'large-v2', 'large-v3'];
const OPENAI_TTS_MODELS = ['tts-1', 'tts-1-hd'];
const OPENAI_TTS_VOICES = ['alloy', 'ash', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer'];

function VoiceTab({ cfg, onSaved }: { cfg: ArgosConfig; onSaved?: () => void }) {
  const { saving, saved, error, needsRestart, save } = useSave(onSaved);
  const v = cfg.voice ?? {} as NonNullable<ArgosConfig['voice']>;

  const [enabled,         setEnabled]         = useState(v.enabled ?? false);
  const [whisperBackend,  setWhisperBackend]  = useState<'api' | 'local'>(v.whisperBackend ?? 'api');
  const [whisperModel,    setWhisperModel]    = useState(v.whisperModel ?? 'whisper-1');
  const [whisperEndpoint, setWhisperEndpoint] = useState(v.whisperEndpoint ?? '');
  const [whisperApiKey,   setWhisperApiKey]   = useState(v.whisperApiKey ?? '');
  const [ttsEnabled,      setTtsEnabled]      = useState(v.ttsEnabled ?? false);
  const [ttsProvider,     setTtsProvider]     = useState<'openai' | 'elevenlabs' | 'local'>(v.ttsProvider ?? 'local');
  const [ttsModel,        setTtsModel]        = useState(v.openAiTtsModel ?? 'tts-1');
  const [localTtsVoice,   setLocalTtsVoice]   = useState(v.localTtsVoice ?? '');
  const [ttsLanguage,     setTtsLanguage]     = useState(v.ttsLanguage ?? 'fr');
  const [immersive,       setImmersive]       = useState(v.immersive ?? false);
  const display = v.display ?? {} as Record<string, string>;
  const [displayName,     setDisplayName]     = useState(display.botName ?? 'Argos');
  const [displayLogo,     setDisplayLogo]     = useState(display.logoUrl ?? '');
  const [displayColor,    setDisplayColor]    = useState(display.accentColor ?? '#4f6eff');
  const [displayPort,     setDisplayPort]     = useState(display.port ?? 3005);
  const [displayStars,   setDisplayStars]    = useState(display.stars ?? false);
  const fx = v.effects ?? {} as Record<string, number>;
  const [fxReverb,        setFxReverb]        = useState(fx.reverb ?? 0);
  const [fxDelay,         setFxDelay]         = useState(fx.delay ?? 0);
  const [fxDelayTime,     setFxDelayTime]     = useState(fx.delayTime ?? 0.3);
  const triggers = v.ttsTriggers ?? {} as Record<string, string>;
  const [trgAlways,       setTrgAlways]       = useState(triggers.always ?? 'off');
  const [trgOnVoice,      setTrgOnVoice]      = useState(triggers.onVoiceMessage ?? 'channel');
  const [trgOnTask,       setTrgOnTask]       = useState(triggers.onTask ?? 'off');
  const [trgOnAlert,      setTrgOnAlert]      = useState(triggers.onAlert ?? 'off');
  const [trgOnTodo,       setTrgOnTodo]       = useState(triggers.onTodo ?? 'off');
  const [trgOnBriefing,   setTrgOnBriefing]   = useState(triggers.onBriefing ?? 'off');
  const [ttsVoice,        setTtsVoice]        = useState(v.openAiTtsVoice ?? 'nova');
  const [elVoiceId,       setElVoiceId]       = useState(v.elevenLabsVoiceId ?? '');
  const [embEnabled,      setEmbEnabled]      = useState(cfg.embeddings?.enabled ?? false);
  const [embModel,        setEmbModel]        = useState(cfg.embeddings?.model ?? 'text-embedding-3-small');
  const [embBaseUrl,      setEmbBaseUrl]      = useState(cfg.embeddings?.baseUrl ?? '');

  return (
    <div className="flex flex-col gap-4">
      <div style={cardStyle}>
        <div className="flex items-center justify-between mb-1">
          <SectionTitle>Whisper — Speech to Text</SectionTitle>
          <Toggle checked={enabled} onChange={setEnabled} label="Enabled" />
        </div>
        <div className="flex gap-3 flex-wrap">
          <FieldRow label="Backend">
            <Select value={whisperBackend} onChange={v => setWhisperBackend(v as 'api' | 'local')}
              options={[
                { value: 'api', label: 'Cloud API (OpenAI, Groq, etc.)' },
                { value: 'local', label: 'Local (faster-whisper / whisper.cpp)' },
              ]}
              style={{ minWidth: 260 }} />
          </FieldRow>
          <FieldRow label="Model">
            {whisperBackend === 'api'
              ? <Select value={whisperModel} onChange={setWhisperModel}
                  options={[
                    { value: 'whisper-1', label: 'whisper-1 (OpenAI)' },
                    { value: 'whisper-large-v3', label: 'whisper-large-v3 (Groq)' },
                    { value: 'whisper-large-v3-turbo', label: 'whisper-large-v3-turbo (Groq)' },
                    { value: 'distil-whisper-large-v3-en', label: 'distil-whisper-large-v3-en (Groq)' },
                  ]} style={{ minWidth: 220 }} />
              : <Select value={whisperModel} onChange={setWhisperModel}
                  options={WHISPER_MODELS.map(m => ({ value: m, label: m }))} style={{ minWidth: 130 }} />}
          </FieldRow>
        </div>
        {whisperBackend === 'api' && (
          <FieldRow label="API endpoint" hint="OpenAI: https://api.openai.com/v1 — Groq: https://api.groq.com/openai/v1">
            <Input value={whisperEndpoint} onChange={setWhisperEndpoint} placeholder="https://api.groq.com/openai/v1" />
          </FieldRow>
        )}
        {whisperBackend === 'local' && (
          <FieldRow label="Local endpoint" hint="default: http://localhost:8000">
            <Input value={whisperEndpoint} onChange={setWhisperEndpoint} placeholder="http://localhost:8000" />
          </FieldRow>
        )}
        {whisperBackend === 'api' && (
          <FieldRow label="API key" hint="Groq, OpenAI, ou autre provider compatible Whisper">
            <Input value={whisperApiKey} onChange={setWhisperApiKey} placeholder="gsk_... or sk-..." style={{ width: 320 }} />
          </FieldRow>
        )}
      </div>

      <div style={cardStyle}>
        <div className="flex items-center justify-between mb-1">
          <SectionTitle>TTS — Text to Speech</SectionTitle>
          <Toggle checked={ttsEnabled} onChange={setTtsEnabled} label="Enabled" />
        </div>
        <div className="flex gap-3 flex-wrap">
          <FieldRow label="Provider">
            <Select value={ttsProvider} onChange={v => setTtsProvider(v as 'openai' | 'elevenlabs' | 'local')}
              options={[
                { value: 'local', label: 'Local (macOS say / espeak)' },
                { value: 'openai', label: 'OpenAI TTS' },
                { value: 'elevenlabs', label: 'ElevenLabs' },
              ]}
              style={{ minWidth: 220 }} />
          </FieldRow>
          <FieldRow label="Language">
            <Select value={ttsLanguage} onChange={setTtsLanguage}
              options={[
                { value: 'fr', label: 'Français' },
                { value: 'en', label: 'English' },
                { value: 'es', label: 'Español' },
                { value: 'de', label: 'Deutsch' },
                { value: 'it', label: 'Italiano' },
                { value: 'pt', label: 'Português' },
                { value: 'ja', label: '日本語' },
                { value: 'zh', label: '中文' },
              ]}
              style={{ minWidth: 140 }} />
          </FieldRow>
        </div>
        {ttsProvider === 'local' && (
          <FieldRow label="Voice name" hint="macOS: run `say -v ?` to list voices. Leave empty for default.">
            <Input value={localTtsVoice} onChange={setLocalTtsVoice} placeholder="Thomas" style={{ width: 180 }} />
          </FieldRow>
        )}
        {ttsProvider === 'openai' && (
          <div className="flex gap-3 flex-wrap">
            <FieldRow label="Model">
              <Select value={ttsModel} onChange={setTtsModel} options={OPENAI_TTS_MODELS.map(m => ({ value: m, label: m }))} style={{ minWidth: 120 }} />
            </FieldRow>
            <FieldRow label="Voice">
              <Select value={ttsVoice} onChange={setTtsVoice} options={OPENAI_TTS_VOICES.map(v => ({ value: v, label: v }))} style={{ minWidth: 120 }} />
            </FieldRow>
          </div>
        )}
        {ttsProvider === 'elevenlabs' && (
          <>
            <FieldRow label="Voice ID" hint="from elevenlabs.io dashboard">
              <Input value={elVoiceId} onChange={setElVoiceId} placeholder="21m00Tcm4TlvDq8ikWAM" />
            </FieldRow>
            <div style={{ ...inter, fontSize: '0.68rem', color: 'var(--text2)' }}>
              API key: set <code style={mono}>ELEVENLABS_API_KEY</code> in Secrets tab.
            </div>
          </>
        )}

        {/* Triggers — per-trigger output routing */}
        <div className="mt-3 pt-3" style={{ borderTop: '1px solid var(--border)' }}>
          <div style={{ ...mono, fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' as const, color: 'var(--text2)', marginBottom: '0.5rem' }}>
            Voice triggers — choose output per event
          </div>
          {([
            ['Always',          'Every response',                     trgAlways,     setTrgAlways],
            ['On voice message','When user sends a voice message',    trgOnVoice,    setTrgOnVoice],
            ['On new task',     'When a task is assigned',            trgOnTask,     setTrgOnTask],
            ['On alert',        'On alerts and notifications',        trgOnAlert,    setTrgOnAlert],
            ['On todo',         'On todo updates',                    trgOnTodo,     setTrgOnTodo],
            ['On briefing',     'Morning/evening recaps',             trgOnBriefing, setTrgOnBriefing],
          ] as [string, string, string, (v: string) => void][]).map(([label, hint, val, setter]) => (
            <div key={label} className="flex items-center gap-3 py-2" style={{ borderBottom: '1px solid var(--border)' }}>
              <div className="flex-1">
                <div style={{ ...inter, fontSize: '0.75rem', fontWeight: 600, color: 'var(--text)' }}>{label}</div>
                <div style={{ ...inter, fontSize: '0.62rem', color: 'var(--text2)' }}>{hint}</div>
              </div>
              <Select value={val} onChange={setter}
                options={[
                  { value: 'off',      label: 'Off' },
                  { value: 'machine',  label: 'Machine' },
                  { value: 'channel',  label: 'Channel' },
                  { value: 'webspeak', label: 'Webspeak' },
                  { value: 'both',     label: 'Machine + Channel' },
                  { value: 'all',      label: 'All' },
                ]} style={{ minWidth: 140 }} />
            </div>
          ))}
        </div>
      </div>

      {/* Immersive Experience */}
      <div style={cardStyle}>
        <div className="flex items-center justify-between mb-1">
          <SectionTitle>Immersive Experience</SectionTitle>
          <Toggle checked={immersive} onChange={setImmersive} label="Enabled" />
        </div>
        <div style={{ ...inter, fontSize: '0.68rem', color: 'var(--text2)', lineHeight: 1.5 }}>
          {immersive
            ? 'Argos Display is active. Open it on any screen to visualize responses with real-time voice and effects.'
            : 'Unlock Argos Display — a visual voice interface with spatial audio effects. Stream responses to a dedicated screen with real-time voice visualization.'}
        </div>

        {immersive && (
          <div className="mt-2 mb-3 px-3 py-2" style={{ background: 'rgba(79,110,255,0.08)', border: '1px solid rgba(79,110,255,0.2)', borderRadius: '6px' }}>
            <div style={{ ...mono, fontSize: '0.68rem', color: '#4f6eff' }}>
              <a href={'/display'} target="_blank" rel="noopener" style={{ color: '#4f6eff', textDecoration: 'none' }}>
                {window.location.origin}/display
              </a>
              <span style={{ color: 'var(--text2)', marginLeft: '0.75rem' }}>
                or http://localhost:{displayPort}
              </span>
            </div>
            <div style={{ ...inter, fontSize: '0.6rem', color: 'var(--text2)', marginTop: '0.25rem' }}>
              Requires restart after enabling. Set a trigger to "Webspeak" or "All" to stream voice here.
            </div>
          </div>
        )}

        {immersive && (
          <div className="mt-3 pt-3" style={{ borderTop: '1px solid var(--border)' }}>
            <div style={{ ...mono, fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' as const, color: 'var(--text2)', marginBottom: '0.5rem' }}>
              Display
            </div>
            <div className="flex gap-3 flex-wrap">
              <FieldRow label="Bot name">
                <Input value={displayName} onChange={setDisplayName} placeholder="Argos" style={{ width: 160 }} />
              </FieldRow>
              <FieldRow label="Accent color">
                <Input value={displayColor} onChange={setDisplayColor} placeholder="#4f6eff" style={{ width: 100 }} />
              </FieldRow>
              <FieldRow label="Port">
                <Input value={String(displayPort)} onChange={v => setDisplayPort(Number(v) || 3005)} placeholder="3005" style={{ width: 80 }} />
              </FieldRow>
            </div>
            <FieldRow label="Logo URL" hint="Image URL or data URI. Leave empty for default orb.">
              <Input value={displayLogo} onChange={setDisplayLogo} placeholder="https://example.com/logo.png" />
            </FieldRow>
            <ToggleRow label="Star field" hint="Animated star background. Off = clean dark mode with halo + scanlines." checked={displayStars} onChange={setDisplayStars} />

            <div className="mt-3 pt-3" style={{ borderTop: '1px solid var(--border)' }}>
              <div style={{ ...mono, fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' as const, color: 'var(--text2)', marginBottom: '0.5rem' }}>
                Audio Effects
              </div>
              <div className="flex gap-4 flex-wrap">
                <FieldRow label="Reverb" hint="0 = dry, 100 = full wet">
                  <NumberInput value={fxReverb} onChange={setFxReverb} min={0} max={100} step={5} />
                </FieldRow>
                <FieldRow label="Delay" hint="0 = off, 100 = full wet">
                  <NumberInput value={fxDelay} onChange={setFxDelay} min={0} max={100} step={5} />
                </FieldRow>
                <FieldRow label="Delay time (s)">
                  <NumberInput value={fxDelayTime} onChange={setFxDelayTime} min={0} max={2} step={0.05} />
                </FieldRow>
              </div>
            </div>
          </div>
        )}
      </div>

      <div style={cardStyle}>
        <div className="flex items-center justify-between mb-1">
          <SectionTitle>Embeddings — semantic / vector search</SectionTitle>
          <Toggle checked={embEnabled} onChange={setEmbEnabled} label="Enabled" />
        </div>
        <FieldRow label="Model">
          <Input value={embModel} onChange={setEmbModel} placeholder="text-embedding-3-small" />
        </FieldRow>
        <FieldRow label="Base URL" hint="blank = OpenAI default">
          <Input value={embBaseUrl} onChange={setEmbBaseUrl} placeholder="http://localhost:11434/v1" />
        </FieldRow>
        <div style={{ ...inter, fontSize: '0.68rem', color: 'var(--text2)' }}>
          Enables LanceDB hybrid search across memories, conversations and knowledge docs.
        </div>
      </div>

      <SaveBar saving={saving} saved={saved} error={error} needsRestart={needsRestart} onSave={() => save({
        voice: {
          enabled, whisperBackend, whisperModel, whisperEndpoint,
          ...(whisperApiKey ? { whisperApiKey } : {}),
          ttsEnabled, ttsProvider, ttsLanguage,
          ...(ttsProvider === 'local' && localTtsVoice ? { localTtsVoice } : {}),
          openAiTtsModel: ttsModel, openAiTtsVoice: ttsVoice,
          ...(ttsProvider === 'elevenlabs' && elVoiceId ? { elevenLabsVoiceId: elVoiceId } : {}),
          ttsTriggers: {
            always: trgAlways, onVoiceMessage: trgOnVoice,
            onTask: trgOnTask, onAlert: trgOnAlert,
            onTodo: trgOnTodo, onBriefing: trgOnBriefing,
          },
          immersive,
          display: {
            botName: displayName, accentColor: displayColor,
            port: displayPort, stars: displayStars,
            ...(displayLogo ? { logoUrl: displayLogo } : {}),
          },
          effects: { reverb: fxReverb, delay: fxDelay, delayTime: fxDelayTime },
        },
        embeddings: { enabled: embEnabled, model: embModel, baseUrl: embBaseUrl },
      })} />
    </div>
  );
}

// ─── Tab: Channels ────────────────────────────────────────────────────────────

function ChannelsTab({ cfg, onSaved }: { cfg: ArgosConfig; onSaved?: () => void }) {
  const { saving, saved, error, needsRestart, save } = useSave(onSaved);
  const ch = cfg.channels ?? {};
  const tg = ch.telegram ?? {};
  const sl = ch.slack ?? {};

  const [preferredChannel, setPreferredChannel] = useState(cfg.notifications?.preferredChannel ?? '');
  const [tgMode,           setTgMode]           = useState(tg.listener?.mode ?? 'mtproto');
  const [tgDiscover,       setTgDiscover]       = useState(tg.listener?.discoverUnknownChats ?? false);
  const [tgWaitMs,         setTgWaitMs]         = useState(tg.listener?.contextWindow?.waitMs ?? 30000);
  const [tgMaxMsgs,        setTgMaxMsgs]        = useState(tg.listener?.contextWindow?.maxMessages ?? 5);
  const [tgIgnoredSenders, setTgIgnoredSenders] = useState((tg.listener?.ignoredSenders ?? []).join(', '));
  const [tgApprovalChat,   setTgApprovalChat]   = useState(tg.personal?.approvalChatId ?? 'me');
  const [slEnabled,        setSlEnabled]        = useState(sl.listener?.enabled ?? false);
  const [slPollSec,        setSlPollSec]        = useState(sl.listener?.pollIntervalSeconds ?? 60);
  const [slMonitorDMs,     setSlMonitorDMs]     = useState(sl.listener?.monitorDMs ?? true);
  const [dcEnabled,        setDcEnabled]        = useState(ch.discord?.enabled ?? false);
  const [dcMonitorDMs,     setDcMonitorDMs]     = useState(ch.discord?.monitorDMs ?? true);
  const [waJid,            setWaJid]            = useState(ch.whatsapp?.approvalJid ?? '');

  return (
    <div className="flex flex-col gap-4">
      {/* Notifications */}
      <div style={cardStyle}>
        <SectionTitle>Notification channel</SectionTitle>
        <div style={{ ...inter, fontSize: '0.68rem', color: 'var(--text2)', marginBottom: '0.75rem', lineHeight: 1.5 }}>
          Where Argos sends proposals and alerts. If unset, auto-priority: telegram_bot → telegram → slack → whatsapp.
        </div>
        <FieldRow label="Preferred channel">
          <Select value={preferredChannel} onChange={setPreferredChannel}
            options={[
              { value: '', label: '— auto (priority order) —' },
              { value: 'telegram_bot', label: 'Telegram Bot (personal)' },
              { value: 'telegram',     label: 'Telegram MTProto (user)' },
              { value: 'slack',        label: 'Slack Bot' },
              { value: 'whatsapp',     label: 'WhatsApp' },
            ]}
            style={{ minWidth: 240 }} />
        </FieldRow>
      </div>

      {/* Telegram */}
      <div style={cardStyle}>
        <SectionTitle>Telegram</SectionTitle>
        <FieldRow label="Listener mode">
          <Select value={tgMode} onChange={setTgMode}
            options={[{ value: 'mtproto', label: 'MTProto (your own account)' }, { value: 'bot', label: 'Bot (company bot in channels)' }]}
            style={{ minWidth: 240 }} />
        </FieldRow>
        <FieldRow label="Approval chat ID" hint="where to send proposals ('me' = Saved Messages)">
          <Input value={tgApprovalChat} onChange={setTgApprovalChat} placeholder="me" style={{ width: 200 }} />
        </FieldRow>
        <ToggleRow label="Discover unknown chats" hint="Notify when an unknown sender messages. Creates a proposal to add them to monitored list." checked={tgDiscover} onChange={setTgDiscover} />
        <FieldRow label="Ignored senders" hint="Usernames (sans @) ou IDs, séparés par virgule. Leurs messages ne créent pas de tâches.">
          <Input value={tgIgnoredSenders} onChange={setTgIgnoredSenders} placeholder="botname, 123456789" />
        </FieldRow>
        <div className="flex gap-4 mt-3 flex-wrap">
          <FieldRow label="Context window — wait (ms)">
            <NumberInput value={tgWaitMs} onChange={setTgWaitMs} min={1000} max={300000} step={1000} />
          </FieldRow>
          <FieldRow label="Max messages per batch">
            <NumberInput value={tgMaxMsgs} onChange={setTgMaxMsgs} min={1} max={20} />
          </FieldRow>
        </div>
        <div style={{ ...inter, fontSize: '0.68rem', color: 'var(--text2)', marginTop: '0.25rem' }}>
          API credentials: set <code style={mono}>TELEGRAM_API_ID</code> / <code style={mono}>TELEGRAM_API_HASH</code> / <code style={mono}>TELEGRAM_BOT_TOKEN</code> in Secrets tab.
        </div>
      </div>

      {/* Slack */}
      <div style={cardStyle}>
        <SectionTitle>Slack</SectionTitle>
        <ToggleRow label="Listener enabled" hint="Monitors DMs and channels you've configured." checked={slEnabled} onChange={setSlEnabled} />
        <ToggleRow label="Monitor DMs" hint="Include direct messages in the listener." checked={slMonitorDMs} onChange={setSlMonitorDMs} />
        <FieldRow label="Poll interval (seconds)">
          <NumberInput value={slPollSec} onChange={setSlPollSec} min={10} max={600} />
        </FieldRow>
        <div style={{ ...inter, fontSize: '0.68rem', color: 'var(--text2)' }}>
          Tokens: <code style={mono}>SLACK_USER_TOKEN</code> (xoxp-) · <code style={mono}>SLACK_BOT_TOKEN</code> (xoxb-)
        </div>
      </div>

      {/* Discord */}
      <div style={cardStyle}>
        <SectionTitle>Discord</SectionTitle>
        <ToggleRow label="Enabled" hint="Gateway WebSocket listener." checked={dcEnabled} onChange={setDcEnabled} />
        <ToggleRow label="Monitor DMs" checked={dcMonitorDMs} onChange={setDcMonitorDMs} />
        <div style={{ ...inter, fontSize: '0.68rem', color: 'var(--text2)' }}>
          Token: <code style={mono}>DISCORD_BOT_TOKEN</code>
        </div>
      </div>

      {/* WhatsApp */}
      <div style={cardStyle}>
        <SectionTitle>WhatsApp</SectionTitle>
        <FieldRow label="Approval JID" hint="phone@s.whatsapp.net or group@g.us">
          <Input value={waJid} onChange={setWaJid} placeholder="33612345678@s.whatsapp.net" />
        </FieldRow>
        <div style={{ ...inter, fontSize: '0.68rem', color: 'var(--text2)' }}>
          Connects via Baileys (WhatsApp Multi-Device). Scan QR at first launch: <code style={mono}>npm run dev</code>
        </div>
      </div>

      <SaveBar saving={saving} saved={saved} error={error} needsRestart={needsRestart} onSave={() => save({
        notifications: { preferredChannel: preferredChannel || undefined },
        channels: {
          ...cfg.channels,
          telegram: {
            ...tg,
            listener: { ...tg.listener, mode: tgMode, discoverUnknownChats: tgDiscover, ignoredSenders: tgIgnoredSenders.split(',').map(s => s.trim().toLowerCase()).filter(Boolean), contextWindow: { waitMs: tgWaitMs, maxMessages: tgMaxMsgs } },
            personal: { ...tg.personal, approvalChatId: tgApprovalChat },
          },
          slack: { ...sl, listener: { enabled: slEnabled, pollIntervalSeconds: slPollSec, monitorDMs: slMonitorDMs } },
          discord: { enabled: dcEnabled, monitorDMs: dcMonitorDMs },
          whatsapp: { ...(ch.whatsapp ?? {}), approvalJid: waJid || undefined },
        },
      })} />
    </div>
  );
}

// ─── Tab: Pipeline ────────────────────────────────────────────────────────────

function PipelineTab({ cfg, onSaved }: { cfg: ArgosConfig; onSaved?: () => void }) {
  const { saving, saved, error, needsRestart, save } = useSave(onSaved);

  // System
  const [readOnly,   setReadOnly]   = useState(cfg.readOnly ?? true);
  const [cloudMode,  setCloudMode]  = useState(cfg.security?.cloudMode ?? false);
  const [logLevel,   setLogLevel]   = useState(cfg.logLevel ?? 'debug');

  // Triage
  const [triageEnabled,  setTriageEnabled]  = useState(cfg.triage?.enabled ?? false);
  const [myHandles,      setMyHandles]      = useState(cfg.triage?.myHandles ?? []);
  const [ignoreOwnTeam,  setIgnoreOwnTeam]  = useState(cfg.triage?.ignoreOwnTeam ?? true);
  const [mentionOnly,    setMentionOnly]    = useState(cfg.triage?.mentionOnly ?? false);

  // Heartbeat
  const [hbEnabled,     setHbEnabled]     = useState(cfg.heartbeat?.enabled ?? false);
  const [hbInterval,    setHbInterval]    = useState(cfg.heartbeat?.intervalMinutes ?? 60);
  const [hbPrompt,      setHbPrompt]      = useState(cfg.heartbeat?.prompt ?? '');

  // Memory
  const [memTtl,      setMemTtl]      = useState(cfg.memory?.defaultTtlDays ?? 7);
  const [memArchive,  setMemArchive]  = useState(cfg.memory?.archiveTtlDays ?? 365);
  const [memThreshold,setMemThreshold]= useState(cfg.memory?.autoArchiveThreshold ?? 8);

  // Approval
  const [appExpiry,      setAppExpiry]      = useState(Math.round((cfg.approval?.defaultExpiryMs ?? 1800000) / 60000));
  const [appCritExpiry,  setAppCritExpiry]  = useState(Math.round((cfg.approval?.criticalExpiryMs ?? 600000) / 60000));
  const [doubleTap,      setDoubleTap]      = useState(cfg.approval?.doubleTapCritical ?? true);

  // Anonymizer
  const [anonMode,         setAnonMode]         = useState<'regex' | 'none'>(cfg.anonymizer?.mode ?? 'regex');
  const [bucketAmounts,    setBucketAmounts]    = useState(cfg.anonymizer?.bucketAmounts ?? true);
  const [anonCrypto,       setAnonCrypto]       = useState(cfg.anonymizer?.anonymizeCryptoAddresses ?? false);
  const [knownPersons,     setKnownPersons]     = useState(cfg.anonymizer?.knownPersons ?? []);

  // Claude
  const [customInstr,     setCustomInstr]     = useState(cfg.claude?.customInstructions ?? '');
  const [planTemp,        setPlanTemp]        = useState(cfg.claude?.planningTemperature ?? 0.3);
  const [maxIter,         setMaxIter]         = useState(cfg.claude?.maxIterations ?? 12);

  // Shell exec
  const [shellEnabled,  setShellEnabled]  = useState(cfg.shellExec?.enabled ?? false);
  const [allowedCmds,   setAllowedCmds]   = useState(cfg.shellExec?.allowedCommands ?? []);
  const [shellWorkdir,  setShellWorkdir]  = useState(cfg.shellExec?.workingDir ?? '');

  // Orchestration
  const [orchEnabled,   setOrchEnabled]   = useState(cfg.orchestration?.enabled ?? false);
  const [maxAgents,     setMaxAgents]     = useState(cfg.orchestration?.maxSubAgents ?? 5);
  const [orchTimeout,   setOrchTimeout]   = useState(cfg.orchestration?.timeoutSeconds ?? 90);

  return (
    <div className="flex flex-col gap-4">
      {/* System */}
      <div style={cardStyle}>
        <SectionTitle>System</SectionTitle>
        <ToggleRow label="Read-only mode" hint="When ON: Argos observes and proposes but cannot execute any action. Safest default." checked={readOnly} onChange={setReadOnly} />
        <ToggleRow label="Cloud mode" hint="Forces YubiKey (FIDO2) for ALL risk levels. Enable when Argos runs on a remote server. Disables Telegram/Slack approval." checked={cloudMode} onChange={setCloudMode} />
        <FieldRow label="Log level">
          <Select value={logLevel} onChange={setLogLevel} options={['debug', 'info', 'warn', 'error'].map(v => ({ value: v, label: v }))} />
        </FieldRow>
      </div>

      {/* Triage */}
      <div style={cardStyle}>
        <SectionTitle>Triage</SectionTitle>
        <ToggleRow label="Enabled" hint="Fast pre-screen: determines isMyTask, team routing, urgency before full classification." checked={triageEnabled} onChange={setTriageEnabled} />
        <FieldRow label="My handles" hint="@username, first name, etc. — identifies messages directed at you">
          <TagInput values={myHandles} onChange={setMyHandles} placeholder="@you" />
        </FieldRow>
        <ToggleRow label="Ignore own team (unless @mentioned)" hint="Skip triage for messages from your own team unless they explicitly tag you." checked={ignoreOwnTeam} onChange={setIgnoreOwnTeam} />
        <ToggleRow label="Mention-only mode" hint="Only triage when explicitly mentioned. No passive monitoring." checked={mentionOnly} onChange={setMentionOnly} />
      </div>

      {/* Heartbeat */}
      <div style={cardStyle}>
        <SectionTitle>Heartbeat — proactive monitoring</SectionTitle>
        <ToggleRow label="Enabled" hint="Periodically scans memories + tasks and proactively surfaces follow-ups, risks, opportunities." checked={hbEnabled} onChange={setHbEnabled} />
        <FieldRow label="Interval (minutes)">
          <NumberInput value={hbInterval} onChange={setHbInterval} min={5} max={1440} />
        </FieldRow>
        <FieldRow label="Custom prompt" hint="Extra instructions appended to the heartbeat system prompt">
          <Textarea value={hbPrompt} onChange={setHbPrompt}
            placeholder="e.g. Always flag any unresolved DeFi positions. Alert if no Notion update in 48h." rows={3} />
        </FieldRow>
      </div>

      {/* Approval */}
      <div style={cardStyle}>
        <SectionTitle>Approval timings</SectionTitle>
        <div className="flex gap-4 flex-wrap">
          <FieldRow label="Default expiry (min)">
            <NumberInput value={appExpiry} onChange={setAppExpiry} min={1} max={1440} />
          </FieldRow>
          <FieldRow label="Critical expiry (min)">
            <NumberInput value={appCritExpiry} onChange={setAppCritExpiry} min={1} max={60} />
          </FieldRow>
        </div>
        <ToggleRow label="Double-tap critical" hint="Require two separate YubiKey assertions for high-risk actions (financial, destructive)." checked={doubleTap} onChange={setDoubleTap} />
      </div>

      {/* Memory */}
      <div style={cardStyle}>
        <SectionTitle>Memory</SectionTitle>
        <div className="flex gap-4 flex-wrap">
          <FieldRow label="Default TTL (days)">
            <NumberInput value={memTtl} onChange={setMemTtl} min={1} max={365} />
          </FieldRow>
          <FieldRow label="Archive TTL (days)">
            <NumberInput value={memArchive} onChange={setMemArchive} min={30} max={3650} />
          </FieldRow>
          <FieldRow label="Auto-archive threshold" hint="importance score (0–10)">
            <NumberInput value={memThreshold} onChange={setMemThreshold} min={0} max={10} />
          </FieldRow>
        </div>
      </div>

      {/* Anonymizer */}
      <div style={cardStyle}>
        <SectionTitle>Anonymizer</SectionTitle>
        <FieldRow label="Mode">
          <Select value={anonMode} onChange={v => setAnonMode(v as 'regex' | 'none')}
            options={[{ value: 'regex', label: 'Regex (default — redacts PII, amounts, addresses)' }, { value: 'none', label: 'None (no anonymization — only for trusted local setups)' }]} />
        </FieldRow>
        <ToggleRow label="Bucket amounts" hint="Replace exact amounts with ranges (10K–100K USDC). Recommended ON." checked={bucketAmounts} onChange={setBucketAmounts} />
        <ToggleRow label="Anonymize crypto addresses" hint="Replace ETH/BTC/SOL addresses with [ADDR_1] etc. OFF by default to preserve whitelist reasoning." checked={anonCrypto} onChange={setAnonCrypto} />
        <FieldRow label="Known persons" hint="Names replaced with [PERSON_1] etc. in content sent to Claude">
          <TagInput values={knownPersons} onChange={setKnownPersons} placeholder="Alice" />
        </FieldRow>
      </div>

      {/* Claude custom instructions */}
      <div style={cardStyle}>
        <SectionTitle>Planner instructions</SectionTitle>
        <FieldRow label="Custom instructions" hint="Appended to planner + heartbeat system prompt. Business rules, priorities, tone.">
          <Textarea value={customInstr} onChange={setCustomInstr}
            placeholder="e.g. Always prefer DeFi-native solutions. Flag any action involving > 10 ETH." rows={4} />
        </FieldRow>
        <FieldRow label="Planning temperature" hint="0 = deterministic · 1 = creative">
          <NumberInput value={planTemp} onChange={setPlanTemp} min={0} max={1} step={0.1} />
        </FieldRow>
        <FieldRow label="Max tool-loop iterations" hint="Max tool calls per message before stopping. Default: 12. Increase for complex multi-step tasks.">
          <NumberInput value={maxIter} onChange={setMaxIter} min={4} max={50} step={1} />
        </FieldRow>
      </div>

      {/* Shell exec */}
      <div style={cardStyle}>
        <SectionTitle>Shell execution</SectionTitle>
        <ToggleRow label="Enabled" hint="Allow the planner to propose shell commands (always requires approval)." checked={shellEnabled} onChange={setShellEnabled} />
        <FieldRow label="Allowed commands" hint="Whitelist — any command not listed is blocked">
          <TagInput values={allowedCmds} onChange={setAllowedCmds} placeholder="git status" />
        </FieldRow>
        <FieldRow label="Working directory" hint="Constrains command execution to this path">
          <Input value={shellWorkdir} onChange={setShellWorkdir} placeholder="~/projects/myapp" />
        </FieldRow>
      </div>

      {/* Orchestration */}
      <div style={cardStyle}>
        <SectionTitle>Multi-agent orchestration</SectionTitle>
        <ToggleRow label="Enabled" hint="Allow the planner to spawn sub-agents via spawn_agent tool." checked={orchEnabled} onChange={setOrchEnabled} />
        <div className="flex gap-4 flex-wrap">
          <FieldRow label="Max sub-agents">
            <NumberInput value={maxAgents} onChange={setMaxAgents} min={1} max={20} />
          </FieldRow>
          <FieldRow label="Timeout (seconds)">
            <NumberInput value={orchTimeout} onChange={setOrchTimeout} min={10} max={600} />
          </FieldRow>
        </div>
      </div>

      <SaveBar saving={saving} saved={saved} error={error} needsRestart={needsRestart} onSave={() => save({
        readOnly, logLevel,
        security:     { cloudMode },
        triage:       { enabled: triageEnabled, myHandles, ignoreOwnTeam, mentionOnly },
        heartbeat:    { enabled: hbEnabled, intervalMinutes: hbInterval, ...(hbPrompt ? { prompt: hbPrompt } : {}) },
        memory:       { defaultTtlDays: memTtl, archiveTtlDays: memArchive, autoArchiveThreshold: memThreshold },
        approval:     { defaultExpiryMs: appExpiry * 60000, criticalExpiryMs: appCritExpiry * 60000, doubleTapCritical: doubleTap },
        anonymizer:   { mode: anonMode, bucketAmounts, anonymizeCryptoAddresses: anonCrypto, knownPersons },
        claude:       { customInstructions: customInstr || undefined, planningTemperature: planTemp, maxIterations: maxIter },
        shellExec:    { enabled: shellEnabled, allowedCommands: allowedCmds, workingDir: shellWorkdir || undefined },
        orchestration:{ enabled: orchEnabled, maxSubAgents: maxAgents, timeoutSeconds: orchTimeout },
      })} />
    </div>
  );
}

// ─── Tab: Agents ──────────────────────────────────────────────────────────────

const BUILTIN_TOOLS = ['web_search', 'fetch_url', 'semantic_search', 'memory_search', 'notion_search', 'crypto_price', 'api_call', '*'];

function AgentForm({ agent, onChange, onDone, providers }:
  { agent: Partial<AgentDef>; onChange: (a: Partial<AgentDef>) => void; onDone: () => void; providers: string[] }) {
  const provOpts = [{ value: '', label: '— same as primary —' }, ...providers.map(p => ({ value: p, label: p }))];
  return (
    <div className="p-3 flex flex-col gap-2" style={{ background: 'rgba(79,110,255,0.04)', borderRadius: '8px', border: '1px solid rgba(79,110,255,0.15)' }}>
      <div className="flex gap-2 flex-wrap">
        <FieldRow label="Name (snake_case)">
          <Input value={agent.name ?? ''} onChange={v => onChange({ ...agent, name: v.replace(/[^a-z0-9_]/g, '_') })} placeholder="my_agent" style={{ width: 160 }} />
        </FieldRow>
        <FieldRow label="Provider">
          <Select value={agent.provider ?? ''} onChange={v => onChange({ ...agent, provider: v || undefined })} options={provOpts} style={{ minWidth: 140 }} />
        </FieldRow>
        <FieldRow label="Model">
          <Input value={agent.model ?? ''} onChange={v => onChange({ ...agent, model: v || undefined })} placeholder="leave blank = primary" style={{ width: 200 }} />
        </FieldRow>
      </div>
      <FieldRow label="Description" hint="Shown to the planner when choosing which agent to invoke">
        <Input value={agent.description ?? ''} onChange={v => onChange({ ...agent, description: v })} placeholder="Handles crypto price queries and DeFi research" />
      </FieldRow>
      <FieldRow label="System prompt">
        <Textarea value={agent.systemPrompt ?? ''} onChange={v => onChange({ ...agent, systemPrompt: v })}
          placeholder="You are a specialized DeFi research agent. Your goal is to..." rows={5} />
      </FieldRow>
      <FieldRow label="Tools" hint="Enter + to add. Use * for all built-in tools.">
        <TagInput values={agent.tools ?? ['web_search', 'fetch_url']} onChange={v => onChange({ ...agent, tools: v })} placeholder={BUILTIN_TOOLS[0]} />
      </FieldRow>
      <div className="flex gap-3 flex-wrap">
        <FieldRow label="Max iterations">
          <NumberInput value={agent.maxIterations ?? 8} onChange={v => onChange({ ...agent, maxIterations: v })} min={1} max={30} />
        </FieldRow>
        <FieldRow label="Temperature">
          <NumberInput value={agent.temperature ?? 0.3} onChange={v => onChange({ ...agent, temperature: v })} min={0} max={1} step={0.1} />
        </FieldRow>
        <FieldRow label="Max tokens">
          <NumberInput value={agent.maxTokens ?? 2048} onChange={v => onChange({ ...agent, maxTokens: v })} min={256} max={32768} step={256} />
        </FieldRow>
      </div>
      <FieldRow label="Linked channels" hint="Messages from these channels go directly to this agent, bypassing the planner. Format: telegram:-100123, slack:C0123">
        <TagInput values={agent.linkedChannels ?? []} onChange={v => onChange({ ...agent, linkedChannels: v })} placeholder="telegram:-100123456" />
      </FieldRow>
      <div className="flex items-center gap-3 mt-1">
        <Toggle checked={agent.isolatedWorkspace ?? true} onChange={v => onChange({ ...agent, isolatedWorkspace: v })} label="Isolated memory workspace" />
      </div>
      <div className="flex gap-2 mt-1">
        <button onClick={onDone} style={{ ...mono, fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' as const, background: '#4f6eff', color: 'white', border: 'none', borderRadius: '5px', padding: '0.35rem 0.9rem', cursor: 'pointer' }}>Done</button>
      </div>
    </div>
  );
}

function AgentsTab({ cfg, onSaved }: { cfg: ArgosConfig; onSaved?: () => void }) {
  const { saving, saved, error, needsRestart, save } = useSave(onSaved);
  const [agents,    setAgents]    = useState<AgentDef[]>(cfg.agents ?? []);
  const [editing,   setEditing]   = useState<number | 'new' | null>(null);
  const [draftAgent,setDraftAgent]= useState<Partial<AgentDef>>({});
  const providers = Object.keys(cfg.llm.providers);

  function startEdit(idx: number) {
    setDraftAgent({ ...agents[idx] });
    setEditing(idx);
  }

  function startNew() {
    setDraftAgent({ name: '', description: '', systemPrompt: '', tools: ['web_search', 'fetch_url'], maxIterations: 8, temperature: 0.3, maxTokens: 2048, enabled: true, isolatedWorkspace: true, linkedChannels: [], triggers: [] });
    setEditing('new');
  }

  function commitEdit() {
    if (!draftAgent.name?.match(/^[a-z][a-z0-9_]*$/)) return;
    if (editing === 'new') {
      setAgents(prev => [...prev, draftAgent as AgentDef]);
    } else if (typeof editing === 'number') {
      setAgents(prev => prev.map((a, i) => i === editing ? draftAgent as AgentDef : a));
    }
    setEditing(null);
  }

  function removeAgent(idx: number) {
    setAgents(prev => prev.filter((_, i) => i !== idx));
  }

  function toggleAgent(idx: number) {
    setAgents(prev => prev.map((a, i) => i === idx ? { ...a, enabled: !a.enabled } : a));
  }

  return (
    <div className="flex flex-col gap-4">
      <div style={cardStyle}>
        <div className="flex items-center justify-between mb-3">
          <SectionTitle>Custom agents</SectionTitle>
          <button onClick={startNew} style={{
            ...mono, fontSize: '0.6rem', fontWeight: 700, letterSpacing: '0.06em',
            textTransform: 'uppercase' as const,
            background: 'transparent', border: '1px solid var(--border)', borderRadius: '5px',
            padding: '0.3rem 0.7rem', cursor: 'pointer', color: 'var(--text2)',
          }}>+ New agent</button>
        </div>

        {editing === 'new' && (
          <div className="mb-4">
            <AgentForm agent={draftAgent} onChange={setDraftAgent} onDone={commitEdit} providers={providers} />
          </div>
        )}

        {agents.length === 0 && editing === null && (
          <div style={{ ...inter, fontSize: '0.72rem', color: 'var(--text2)', textAlign: 'center', padding: '1.5rem 0' }}>
            No custom agents. Click "New agent" to create a specialized sub-agent with its own tools, model and memory.
          </div>
        )}

        {agents.map((agent, i) => (
          <div key={agent.name}>
            {editing === i ? (
              <div className="mb-3">
                <AgentForm agent={draftAgent} onChange={setDraftAgent} onDone={commitEdit} providers={providers} />
              </div>
            ) : (
              <div className="flex items-center gap-3 py-2.5" style={{ borderBottom: '1px solid var(--border)' }}>
                <Toggle checked={agent.enabled} onChange={() => toggleAgent(i)} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span style={{ ...mono, fontSize: '0.75rem', fontWeight: 700, color: 'var(--text)' }}>{agent.name}</span>
                    {agent.provider && <span style={{ ...mono, fontSize: '0.58rem', color: '#4f6eff', background: 'rgba(79,110,255,0.1)', padding: '0.1rem 0.35rem', borderRadius: 3 }}>{agent.provider}</span>}
                    {agent.model && <span style={{ ...mono, fontSize: '0.58rem', color: 'var(--text2)' }}>{agent.model}</span>}
                  </div>
                  <div style={{ ...inter, fontSize: '0.68rem', color: 'var(--text2)', marginTop: '0.1rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{agent.description}</div>
                  <div style={{ ...mono, fontSize: '0.6rem', color: 'var(--text2)', marginTop: '0.1rem' }}>
                    tools: {agent.tools.join(', ')} · iter: {agent.maxIterations} · T={agent.temperature}
                  </div>
                </div>
                <button onClick={() => startEdit(i)} style={{ ...mono, fontSize: '0.6rem', background: 'transparent', border: '1px solid var(--border)', borderRadius: '4px', padding: '0.2rem 0.5rem', cursor: 'pointer', color: 'var(--text2)' }}>Edit</button>
                <button onClick={() => removeAgent(i)} style={{ background: 'transparent', border: 'none', color: '#ef444480', cursor: 'pointer', fontSize: '0.8rem', padding: '0.2rem' }}>✕</button>
              </div>
            )}
          </div>
        ))}
      </div>

      <SaveBar saving={saving} saved={saved} error={error} needsRestart={needsRestart} onSave={() => save({ agents })} />
    </div>
  );
}

// ─── Tab: MCP & Skills ────────────────────────────────────────────────────────

interface CatalogEntry {
  name: string;
  description: string;
  category: string;
  type: string;
  official: boolean;
  package?: string;
  command?: string;
  args?: string[];
  url?: string;
  envVars?: string[];
  installNote?: string;
  docsUrl?: string;
  enabled: boolean;
}

interface PluginsData {
  skills:     { name: string; description: string; enabled: boolean }[];
  mcpServers: CatalogEntry[];
}

const CATEGORY_ICONS: Record<string, string> = {
  search:        '🔍',
  productivity:  '📋',
  dev:           '💻',
  database:      '🗄️',
  browser:       '🌐',
  storage:       '📁',
  communication: '💬',
  finance:       '💳',
  infra:         '☁️',
  ai:            '🤖',
  security:      '🔐',
  other:         '🔧',
};

const CATEGORY_ORDER = ['search', 'productivity', 'dev', 'security', 'browser', 'database', 'storage', 'communication', 'finance', 'infra', 'ai', 'other'];

interface McpToolMeta {
  serverName: string;
  tools: { name: string; readOnlyHint: boolean; destructiveHint: boolean }[];
}

type McpServerConfig = NonNullable<ArgosConfig['mcpServers']>[number];
type PolicyValue = 'allow' | 'approve' | 'block';

const POLICY_LABELS: Record<PolicyValue, string> = { allow: 'Allow', approve: 'Approve', block: 'Block' };
const POLICY_COLORS: Record<PolicyValue, string> = {
  allow:   '#059669',
  approve: '#d97706',
  block:   '#ef4444',
};

function PolicyToggle({ value, onChange }: { value: PolicyValue; onChange: (v: PolicyValue) => void }) {
  const policies: PolicyValue[] = ['allow', 'approve', 'block'];
  return (
    <div className="flex" style={{ borderRadius: 5, overflow: 'hidden', border: '1px solid var(--border)' }}>
      {policies.map(p => (
        <button key={p} onClick={() => onChange(p)} style={{
          ...mono, fontSize: '0.58rem', fontWeight: 700, letterSpacing: '0.05em',
          textTransform: 'uppercase' as const,
          padding: '0.2rem 0.45rem',
          border: 'none',
          borderRight: p !== 'block' ? '1px solid var(--border)' : 'none',
          cursor: 'pointer',
          background: value === p ? POLICY_COLORS[p] : 'transparent',
          color: value === p ? 'white' : 'var(--text2)',
          transition: 'background 0.1s',
        }}>{POLICY_LABELS[p]}</button>
      ))}
    </div>
  );
}

function ToolPolicySection({ serverName, tools, policy, onChange }: {
  serverName: string;
  tools: McpToolMeta['tools'];
  policy: Record<string, PolicyValue>;
  onChange: (policy: Record<string, PolicyValue>) => void;
}) {
  const defaultPolicy: PolicyValue = (policy['default'] as PolicyValue) ?? 'approve';

  function setToolPolicy(toolName: string, val: PolicyValue) {
    // If same as default, remove the override
    if (val === defaultPolicy && toolName !== 'default') {
      const next = { ...policy };
      delete next[toolName];
      onChange(next);
    } else {
      onChange({ ...policy, [toolName]: val });
    }
  }

  return (
    <div className="mt-3 pt-3" style={{ borderTop: '1px solid var(--border)' }}>
      <div style={{ ...inter, fontSize: '0.68rem', color: 'var(--text2)', marginBottom: '0.6rem' }}>
        Tool policy for <span style={{ ...mono, color: 'var(--text)' }}>{serverName}</span>
        <span style={{ marginLeft: '0.5rem', fontSize: '0.62rem' }}>— Allow = auto-execute · Approve = needs confirmation · Block = disabled</span>
      </div>
      {/* Default policy */}
      <div className="flex items-center gap-3 py-1.5" style={{ borderBottom: '1px solid var(--border)' }}>
        <div style={{ ...mono, fontSize: '0.68rem', fontWeight: 700, color: 'var(--text)', flex: 1 }}>
          Default (all unlisted tools)
        </div>
        <PolicyToggle value={defaultPolicy} onChange={v => onChange({ ...policy, default: v })} />
      </div>
      {/* Per-tool overrides */}
      {tools.map(t => {
        const effectivePolicy: PolicyValue = (policy[t.name] as PolicyValue) ?? defaultPolicy;
        const isOverride = policy[t.name] != null;
        return (
          <div key={t.name} className="flex items-center gap-3 py-1.5" style={{ borderBottom: '1px solid var(--border)' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <span style={{ ...mono, fontSize: '0.68rem', color: isOverride ? 'var(--text)' : 'var(--text2)' }}>{t.name}</span>
              {t.readOnlyHint && <span style={{ ...mono, fontSize: '0.56rem', color: '#059669', marginLeft: '0.4rem', background: 'rgba(5,150,105,0.1)', padding: '0.1rem 0.3rem', borderRadius: 3 }}>read-only</span>}
            </div>
            <PolicyToggle value={effectivePolicy} onChange={v => setToolPolicy(t.name, v)} />
          </div>
        );
      })}
    </div>
  );
}

function PluginsTab({ cfg, onSaved }: { cfg: ArgosConfig; onSaved?: () => void }) {
  const { saving, saved, error, needsRestart, save } = useSave(onSaved);
  const [plugins,      setPlugins]      = useState<PluginsData | null>(null);
  const [mcpList,      setMcpList]      = useState<McpServerConfig[]>(cfg.mcpServers ?? []);
  const [skillList,    setSkillList]    = useState(cfg.skills ?? []);
  const [newMcp,       setNewMcp]       = useState({ name: '', type: 'stdio', command: '', url: '', args: '' });
  const [addingMcp,    setAddingMcp]    = useState(false);
  const [mcpToolMeta,  setMcpToolMeta]  = useState<McpToolMeta[]>([]);
  const [expandedPolicy, setExpandedPolicy] = useState<string | null>(null);

  useEffect(() => { get<PluginsData>('/plugins').then(setPlugins).catch(() => {}); }, []);
  useEffect(() => { get<McpToolMeta[]>('/mcp/tools').then(setMcpToolMeta).catch(() => {}); }, []);

  // Check if a catalog server is already in mcpList (configured)
  const configuredNames = new Set(mcpList.map(s => s.name));

  function enableCatalogServer(entry: CatalogEntry) {
    if (configuredNames.has(entry.name)) {
      // Toggle existing
      setMcpList(prev => prev.map(s => s.name === entry.name ? { ...s, enabled: !s.enabled } : s));
    } else {
      // Add from catalog
      const server: McpServerConfig = {
        name: entry.name,
        type: entry.type as 'stdio' | 'url',
        enabled: true,
        ...(entry.command ? { command: entry.command } : {}),
        ...(entry.url ? { url: entry.url } : {}),
        ...(entry.args?.length ? { args: entry.args } : {}),
      };
      setMcpList(prev => [...prev, server]);
    }
  }

  function addMcpServer() {
    if (!newMcp.name.trim()) return;
    const server: McpServerConfig = {
      name: newMcp.name.trim(), type: newMcp.type as 'stdio' | 'url', enabled: true,
      ...(newMcp.type === 'stdio' && newMcp.command ? { command: newMcp.command } : {}),
      ...(newMcp.type !== 'stdio' && newMcp.url ? { url: newMcp.url } : {}),
      ...(newMcp.args ? { args: newMcp.args.split(' ').filter(Boolean) } : {}),
    };
    setMcpList(prev => [...prev, server]);
    setNewMcp({ name: '', type: 'stdio', command: '', url: '', args: '' });
    setAddingMcp(false);
  }

  // Group catalog by category
  const catalog = plugins?.mcpServers ?? [];
  const catalogByCategory: Record<string, CatalogEntry[]> = {};
  for (const entry of catalog) {
    const cat = entry.category || 'other';
    if (!catalogByCategory[cat]) catalogByCategory[cat] = [];
    catalogByCategory[cat].push(entry);
  }
  const sortedCategories = CATEGORY_ORDER.filter(c => catalogByCategory[c]?.length);

  // Custom servers = in mcpList but not in catalog
  const catalogNames = new Set(catalog.map(e => e.name));
  const customServers = mcpList.filter(s => !catalogNames.has(s.name));

  return (
    <div className="flex flex-col gap-4">
      {/* MCP Catalog */}
      <div style={cardStyle}>
        <SectionTitle>MCP Servers — external tool providers</SectionTitle>

        {!plugins && <div style={{ ...inter, fontSize: '0.72rem', color: 'var(--text2)', padding: '1rem 0' }}>Loading catalog…</div>}

        {sortedCategories.map(cat => (
          <div key={cat} className="mt-3">
            <div style={{ ...mono, fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' as const, color: 'var(--text2)', marginBottom: '0.4rem' }}>
              {CATEGORY_ICONS[cat] ?? '🔧'} {cat}
            </div>
            {catalogByCategory[cat].map(entry => {
              const configured = mcpList.find(s => s.name === entry.name);
              const isEnabled = configured?.enabled ?? false;
              const serverTools = mcpToolMeta.find(m => m.serverName === entry.name);
              const isExpanded = expandedPolicy === entry.name;
              return (
                <div key={entry.name} style={{ borderBottom: '1px solid var(--border)' }}>
                  <div className="flex items-center gap-3 py-2">
                    <Toggle checked={isEnabled} onChange={() => enableCatalogServer(entry)} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span style={{ ...inter, fontSize: '0.775rem', fontWeight: 600, color: 'var(--text)' }}>{entry.name}</span>
                        {entry.official && <span style={{ ...mono, fontSize: '0.5rem', fontWeight: 700, color: '#059669', background: 'rgba(5,150,105,0.08)', padding: '0.05rem 0.3rem', borderRadius: 3, letterSpacing: '0.04em' }}>OFFICIAL</span>}
                      </div>
                      <div style={{ ...inter, fontSize: '0.68rem', color: 'var(--text2)', lineHeight: 1.4 }}>{entry.description}</div>
                      {entry.envVars?.length ? (
                        <div style={{ ...mono, fontSize: '0.58rem', color: 'var(--text2)', marginTop: '0.15rem', opacity: 0.7 }}>
                          needs: {entry.envVars.join(', ')}
                        </div>
                      ) : null}
                      {isEnabled && entry.installNote && (
                        <div style={{ ...inter, fontSize: '0.62rem', color: '#d97706', marginTop: '0.25rem', lineHeight: 1.4 }}>
                          {entry.installNote}
                        </div>
                      )}
                    </div>
                    {serverTools && (
                      <button onClick={() => setExpandedPolicy(isExpanded ? null : entry.name)} style={{
                        ...mono, fontSize: '0.58rem', fontWeight: 700, letterSpacing: '0.05em',
                        textTransform: 'uppercase' as const,
                        background: isExpanded ? 'rgba(79,110,255,0.1)' : 'transparent',
                        border: '1px solid var(--border)', borderRadius: '4px',
                        padding: '0.2rem 0.5rem', cursor: 'pointer', color: '#4f6eff',
                      }}>Policy ({serverTools.tools.length})</button>
                    )}
                  </div>
                  {isExpanded && serverTools && configured && (
                    <ToolPolicySection
                      serverName={entry.name}
                      tools={serverTools.tools}
                      policy={(configured.toolPolicy ?? {}) as Record<string, PolicyValue>}
                      onChange={pol => setMcpList(prev => prev.map(x => x.name === entry.name ? { ...x, toolPolicy: pol } : x))}
                    />
                  )}
                </div>
              );
            })}
          </div>
        ))}

        {/* Custom servers (not in catalog) */}
        {customServers.length > 0 && (
          <div className="mt-3">
            <div style={{ ...mono, fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' as const, color: 'var(--text2)', marginBottom: '0.4rem' }}>
              🔧 Custom
            </div>
            {customServers.map(s => {
              const i = mcpList.findIndex(x => x.name === s.name);
              const serverTools = mcpToolMeta.find(m => m.serverName === s.name);
              const isExpanded = expandedPolicy === s.name;
              return (
                <div key={s.name} style={{ borderBottom: '1px solid var(--border)' }}>
                  <div className="flex items-center gap-3 py-2.5">
                    <Toggle checked={s.enabled} onChange={() => setMcpList(prev => prev.map((x, j) => j === i ? { ...x, enabled: !x.enabled } : x))} />
                    <div className="flex-1 min-w-0">
                      <div style={{ ...inter, fontSize: '0.775rem', fontWeight: 600, color: 'var(--text)' }}>{s.name}</div>
                      <div style={{ ...mono, fontSize: '0.62rem', color: 'var(--text2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {s.type} · {s.command ?? s.url ?? '—'} {s.args?.length ? s.args.join(' ') : ''}
                      </div>
                    </div>
                    {serverTools && (
                      <button onClick={() => setExpandedPolicy(isExpanded ? null : s.name)} style={{
                        ...mono, fontSize: '0.58rem', fontWeight: 700, letterSpacing: '0.05em',
                        textTransform: 'uppercase' as const,
                        background: isExpanded ? 'rgba(79,110,255,0.1)' : 'transparent',
                        border: '1px solid var(--border)', borderRadius: '4px',
                        padding: '0.2rem 0.5rem', cursor: 'pointer', color: '#4f6eff',
                      }}>Policy ({serverTools.tools.length})</button>
                    )}
                    <button onClick={() => setMcpList(prev => prev.filter((_, j) => j !== i))} style={{ background: 'transparent', border: 'none', color: '#ef444480', cursor: 'pointer', fontSize: '0.8rem', padding: '0.2rem' }}>✕</button>
                  </div>
                  {isExpanded && serverTools && (
                    <ToolPolicySection
                      serverName={s.name}
                      tools={serverTools.tools}
                      policy={(s.toolPolicy ?? {}) as Record<string, PolicyValue>}
                      onChange={pol => setMcpList(prev => prev.map((x, j) => j === i ? { ...x, toolPolicy: pol } : x))}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Add custom */}
        <div className="mt-3 pt-2" style={{ borderTop: '1px solid var(--border)' }}>
          {!addingMcp ? (
            <button onClick={() => setAddingMcp(true)} style={{
              ...mono, fontSize: '0.6rem', fontWeight: 700, letterSpacing: '0.06em',
              textTransform: 'uppercase' as const,
              background: 'transparent', border: '1px dashed var(--border)', borderRadius: '5px',
              padding: '0.4rem 0.9rem', cursor: 'pointer', color: 'var(--text2)', width: '100%',
            }}>+ Add custom MCP server</button>
          ) : (
            <div className="p-3" style={{ background: 'rgba(79,110,255,0.04)', borderRadius: '8px', border: '1px solid rgba(79,110,255,0.15)' }}>
              <div className="flex gap-2 flex-wrap mb-2">
                <FieldRow label="Name">
                  <Input value={newMcp.name} onChange={v => setNewMcp(p => ({ ...p, name: v }))} placeholder="my-server" style={{ width: 140 }} />
                </FieldRow>
                <FieldRow label="Type">
                  <Select value={newMcp.type} onChange={v => setNewMcp(p => ({ ...p, type: v }))}
                    options={[{ value: 'stdio', label: 'stdio' }, { value: 'url', label: 'URL / SSE' }]} />
                </FieldRow>
              </div>
              {newMcp.type === 'stdio'
                ? <FieldRow label="Command"><Input value={newMcp.command} onChange={v => setNewMcp(p => ({ ...p, command: v }))} placeholder="npx @my/mcp-server" /></FieldRow>
                : <FieldRow label="URL"><Input value={newMcp.url} onChange={v => setNewMcp(p => ({ ...p, url: v }))} placeholder="http://localhost:8080/sse" /></FieldRow>}
              <FieldRow label="Args (space-separated)">
                <Input value={newMcp.args} onChange={v => setNewMcp(p => ({ ...p, args: v }))} placeholder="/home/user/data /tmp" />
              </FieldRow>
              <div className="flex gap-2 mt-1">
                <button onClick={addMcpServer} style={{ ...mono, fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' as const, background: '#4f6eff', color: 'white', border: 'none', borderRadius: '5px', padding: '0.35rem 0.9rem', cursor: 'pointer' }}>Add</button>
                <button onClick={() => setAddingMcp(false)} style={{ ...mono, fontSize: '0.62rem', background: 'transparent', border: '1px solid var(--border)', borderRadius: '5px', padding: '0.35rem 0.9rem', cursor: 'pointer', color: 'var(--text2)' }}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Skills */}
      <div style={cardStyle}>
        <SectionTitle>Built-in skills</SectionTitle>
        {!plugins && <div style={{ ...inter, fontSize: '0.72rem', color: 'var(--text2)' }}>Loading…</div>}
        {plugins?.skills.map(sk => {
          const idx = skillList.findIndex(s => s.name === sk.name);
          const enabled = idx >= 0 ? skillList[idx].enabled : sk.enabled;
          return (
            <div key={sk.name} className="flex items-center gap-3 py-2.5" style={{ borderBottom: '1px solid var(--border)' }}>
              <Toggle checked={enabled} onChange={() => {
                if (idx >= 0) setSkillList(prev => prev.map((s, j) => j === idx ? { ...s, enabled: !s.enabled } : s));
                else setSkillList(prev => [...prev, { name: sk.name, enabled: !sk.enabled }]);
              }} />
              <div className="flex-1">
                <div style={{ ...inter, fontSize: '0.775rem', fontWeight: 600, color: 'var(--text)' }}>{sk.name}</div>
                <div style={{ ...inter, fontSize: '0.68rem', color: 'var(--text2)' }}>{sk.description}</div>
              </div>
            </div>
          );
        })}
      </div>

      <SaveBar saving={saving} saved={saved} error={error} needsRestart={needsRestart} onSave={() => save({ mcpServers: mcpList, skills: skillList })} />
    </div>
  );
}

// ─── Tab: Secrets ─────────────────────────────────────────────────────────────

const KNOWN_SECRETS: Record<string, { label: string; hint: string }> = {
  ANTHROPIC_API_KEY:       { label: 'Anthropic API Key',       hint: 'console.anthropic.com → API Keys' },
  OPENAI_API_KEY:          { label: 'OpenAI API Key',          hint: 'platform.openai.com → API Keys' },
  GROQ_API_KEY:            { label: 'Groq API Key',            hint: 'console.groq.com → API Keys' },
  GEMINI_API_KEY:          { label: 'Google Gemini API Key',   hint: 'aistudio.google.com' },
  DEEPSEEK_API_KEY:        { label: 'DeepSeek API Key',        hint: 'platform.deepseek.com' },
  MISTRAL_API_KEY:         { label: 'Mistral API Key',         hint: 'console.mistral.ai' },
  XAI_API_KEY:             { label: 'xAI (Grok) API Key',      hint: 'console.x.ai' },
  TOGETHER_API_KEY:        { label: 'Together AI Key',         hint: 'api.together.xyz → Settings' },
  COHERE_API_KEY:          { label: 'Cohere API Key',          hint: 'dashboard.cohere.com' },
  PERPLEXITY_API_KEY:      { label: 'Perplexity API Key',      hint: 'perplexity.ai → Settings → API' },
  ELEVENLABS_API_KEY:      { label: 'ElevenLabs API Key',      hint: 'elevenlabs.io → Profile → API Key' },
  TELEGRAM_BOT_TOKEN:      { label: 'Telegram Bot Token',      hint: 'BotFather → /newbot' },
  TELEGRAM_API_ID:         { label: 'Telegram API ID',         hint: 'my.telegram.org → App API' },
  TELEGRAM_API_HASH:       { label: 'Telegram API Hash',       hint: 'my.telegram.org → App API' },
  SLACK_USER_TOKEN:        { label: 'Slack User Token (xoxp)', hint: 'api.slack.com → OAuth' },
  SLACK_BOT_TOKEN:         { label: 'Slack Bot Token (xoxb)',  hint: 'api.slack.com → OAuth' },
  DISCORD_BOT_TOKEN:       { label: 'Discord Bot Token',       hint: 'discord.com/developers → Bot' },
  NOTION_API_KEY:          { label: 'Notion API Key',          hint: 'notion.so/my-integrations' },
  GOOGLE_CLIENT_ID:        { label: 'Google OAuth Client ID',  hint: 'console.cloud.google.com → Credentials' },
  GOOGLE_CLIENT_SECRET:    { label: 'Google OAuth Secret',     hint: 'console.cloud.google.com → Credentials' },
  GOOGLE_REFRESH_TOKEN:    { label: 'Google Refresh Token',    hint: 'Run: npm run setup → Google Calendar' },
  LINEAR_API_KEY:          { label: 'Linear API Key',          hint: 'linear.app → Settings → API' },
  GITHUB_TOKEN:            { label: 'GitHub Token',            hint: 'github.com → Settings → Developer → PAT' },
  BRAVE_SEARCH_API_KEY:    { label: 'Brave Search API Key',    hint: 'api.search.brave.com' },
  TAVILY_API_KEY:          { label: 'Tavily API Key',          hint: 'app.tavily.com → API Keys' },
  CLOUDFLARE_TUNNEL_TOKEN: { label: 'Cloudflare Tunnel Token', hint: 'dash.cloudflare.com → Zero Trust → Tunnels' },
};

function SecretsTab() {
  const [storedKeys, setStoredKeys] = useState<string[]>([]);
  const [newKey,     setNewKey]     = useState('');
  const [newVal,     setNewVal]     = useState('');
  const [saving,     setSaving]     = useState(false);
  const [saved,      setSaved]      = useState(false);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { const d = await get<{ keys: string[] }>('/configure/secrets'); setStoredKeys(d.keys); } catch {}
  }, []);

  useEffect(() => { load(); }, [load]);

  async function saveSecret() {
    const key = newKey.trim().toUpperCase();
    if (!key || !newVal) return;
    setSaving(true);
    try {
      await post('/configure/secrets', { key, value: newVal });
      setNewKey(''); setNewVal(''); setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      await load();
    } catch {} finally { setSaving(false); }
  }

  async function deleteSecret(key: string) {
    if (confirmDel !== key) { setConfirmDel(key); return; }
    await del(`/configure/secrets/${key}`);
    setConfirmDel(null); await load();
  }

  const storedSet  = new Set(storedKeys);
  const missingKeys = Object.keys(KNOWN_SECRETS).filter(k => !storedSet.has(k));
  const customKeys  = storedKeys.filter(k => !KNOWN_SECRETS[k]);

  return (
    <div className="flex flex-col gap-4">
      <div style={cardStyle}>
        <SectionTitle>Add / update secret</SectionTitle>
        <div className="flex gap-3 flex-wrap items-end">
          <FieldRow label="Key">
            <Input value={newKey} onChange={v => setNewKey(v.toUpperCase())} placeholder="MY_API_KEY" style={{ width: 200 }} />
          </FieldRow>
          <FieldRow label="Value">
            <Input value={newVal} onChange={setNewVal} type="password" placeholder="sk-…" style={{ width: 240 }} />
          </FieldRow>
          <div style={{ paddingBottom: '0.75rem' }}>
            <button onClick={saveSecret} disabled={saving || !newKey || !newVal} style={{
              ...mono, fontSize: '0.65rem', fontWeight: 700, letterSpacing: '0.08em',
              textTransform: 'uppercase' as const,
              background: (!newKey || !newVal) ? 'var(--border)' : '#4f6eff',
              color: (!newKey || !newVal) ? 'var(--text2)' : 'white',
              border: 'none', borderRadius: '6px', padding: '0.5rem 1rem', cursor: (!newKey || !newVal) ? 'default' : 'pointer',
            }}>{saving ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
        {saved && <div style={{ ...inter, fontSize: '0.72rem', color: '#059669' }}>Saved</div>}
        <div style={{ ...inter, fontSize: '0.68rem', color: 'var(--text2)', marginTop: '0.25rem' }}>
          Stored in system keychain (Keytar) or <code style={mono}>~/.argos/secrets.json</code>. Never in env or config.json.
        </div>
      </div>

      {storedKeys.length > 0 && (
        <div style={cardStyle}>
          <SectionTitle>Stored ({storedKeys.length})</SectionTitle>
          {storedKeys.map(k => {
            const meta = KNOWN_SECRETS[k];
            return (
              <div key={k} className="flex items-center gap-3 py-2.5" style={{ borderBottom: '1px solid var(--border)' }}>
                <div className="flex-1">
                  <div style={{ ...mono, fontSize: '0.72rem', fontWeight: 700, color: '#059669' }}>{k}</div>
                  {meta && <div style={{ ...inter, fontSize: '0.68rem', color: 'var(--text2)' }}>{meta.label}</div>}
                  {!meta && customKeys.includes(k) && <div style={{ ...inter, fontSize: '0.68rem', color: 'var(--text2)' }}>Custom key</div>}
                </div>
                <button onClick={() => { setNewKey(k); setConfirmDel(null); }} style={{ ...mono, fontSize: '0.6rem', background: 'transparent', border: '1px solid var(--border)', borderRadius: '4px', padding: '0.2rem 0.5rem', cursor: 'pointer', color: 'var(--text2)' }}>Update</button>
                <button onClick={() => deleteSecret(k)} style={{
                  ...mono, fontSize: '0.6rem', fontWeight: 700,
                  background: confirmDel === k ? '#ef4444' : 'transparent',
                  color: confirmDel === k ? 'white' : '#ef444480',
                  border: `1px solid ${confirmDel === k ? '#ef4444' : '#ef444430'}`,
                  borderRadius: '4px', padding: '0.2rem 0.5rem', cursor: 'pointer',
                }}>{confirmDel === k ? 'Confirm?' : 'Delete'}</button>
              </div>
            );
          })}
        </div>
      )}

      {missingKeys.length > 0 && (
        <div style={cardStyle}>
          <SectionTitle>Not configured — click to add</SectionTitle>
          {missingKeys.map(k => (
            <div key={k} className="flex items-center gap-3 py-2.5 cursor-pointer"
              style={{ borderBottom: '1px solid var(--border)' }}
              onClick={() => setNewKey(k)}>
              <div className="flex-1">
                <div style={{ ...mono, fontSize: '0.72rem', color: 'var(--text2)' }}>{k}</div>
                <div style={{ ...inter, fontSize: '0.68rem', color: 'var(--text2)' }}>
                  {KNOWN_SECRETS[k].label} — <span style={{ color: '#4f6eff' }}>{KNOWN_SECRETS[k].hint}</span>
                </div>
              </div>
              <span style={{ ...mono, fontSize: '0.6rem', color: '#4f6eff' }}>+ add →</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Root ─────────────────────────────────────────────────────────────────────

export default function Configure() {
  const [tab,          setTab]          = useState<Tab>('models');
  const [cfg,          setCfg]          = useState<ArgosConfig | null>(null);
  const [loading,      setLoading]      = useState(true);
  const [err,          setErr]          = useState<string | null>(null);
  const [needsRestart, setNeedsRestart] = useState(false);
  const [restarting,   setRestarting]   = useState(false);

  const loadCfg = useCallback(async () => {
    setLoading(true); setErr(null);
    try { setCfg(await get<ArgosConfig>('/configure/config')); }
    catch (e) { setErr(String(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { loadCfg(); }, [loadCfg]);

  // Called by any tab after a successful save
  const onSaved = useCallback(() => {
    setNeedsRestart(true);
    // Reload config so tabs reflect persisted values
    loadCfg();
  }, [loadCfg]);

  async function doRestart() {
    setRestarting(true);
    try {
      await post('/configure/restart', {});
    } catch { /* process exited — connection refused is expected */ }
    // Wait for process to come back, then reload
    let attempts = 0;
    const poll = setInterval(async () => {
      attempts++;
      try {
        await get('/status');
        clearInterval(poll);
        setRestarting(false);
        setNeedsRestart(false);
        await loadCfg();
      } catch {
        if (attempts > 30) { clearInterval(poll); setRestarting(false); }
      }
    }, 1000);
  }

  return (
    <div className="flex flex-col gap-4" style={{ maxWidth: 800 }}>
      {/* Restart banner */}
      {needsRestart && (
        <div className="flex items-center justify-between gap-4 px-4 py-3" style={{
          background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.3)',
          borderRadius: '8px',
        }}>
          <div>
            <span style={{ ...inter, fontSize: '0.775rem', fontWeight: 600, color: '#92400e' }}>
              Config saved.
            </span>
            <span style={{ ...inter, fontSize: '0.72rem', color: '#92400e', marginLeft: '0.4rem' }}>
              Restart the process to apply all changes.
            </span>
          </div>
          <button onClick={doRestart} disabled={restarting} style={{
            ...mono, fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.08em',
            textTransform: 'uppercase' as const,
            background: restarting ? 'rgba(245,158,11,0.3)' : '#f59e0b',
            color: 'white', border: 'none', borderRadius: '6px',
            padding: '0.4rem 1rem', cursor: restarting ? 'default' : 'pointer', flexShrink: 0,
          }}>
            {restarting ? 'Restarting…' : 'Restart now'}
          </button>
        </div>
      )}

      {/* Tab bar */}
      <div className="flex gap-0 flex-wrap" style={{ borderBottom: '1px solid var(--border)' }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            ...inter, fontSize: '0.775rem', fontWeight: tab === t.id ? 700 : 400,
            color: tab === t.id ? '#4f6eff' : 'var(--text2)',
            background: 'transparent', border: 'none', padding: '0.45rem 0.9rem',
            borderBottom: `2px solid ${tab === t.id ? '#4f6eff' : 'transparent'}`,
            cursor: 'pointer', transition: 'all 0.15s', marginBottom: '-1px',
          }}>{t.label}</button>
        ))}
        <button onClick={loadCfg} title="Reload config" style={{
          marginLeft: 'auto', ...mono, fontSize: '0.65rem', color: 'var(--text2)',
          background: 'transparent', border: 'none', cursor: 'pointer', padding: '0.45rem 0.6rem',
        }}>↺</button>
      </div>

      {loading && (
        <div style={{ ...mono, fontSize: '0.65rem', color: 'rgba(79,110,255,0.5)', letterSpacing: '0.1em', padding: '2rem 0', textAlign: 'center' }}>
          LOADING…
        </div>
      )}
      {err && !loading && (
        <div style={{ ...inter, fontSize: '0.72rem', color: '#ef4444', padding: '1rem', background: 'rgba(239,68,68,0.05)', borderRadius: '8px', border: '1px solid rgba(239,68,68,0.2)' }}>
          {err}
        </div>
      )}

      {cfg && !loading && (
        <>
          {tab === 'models'   && <ModelsTab   cfg={cfg} onSaved={onSaved} />}
          {tab === 'privacy'  && <PrivacyTab  cfg={cfg} onSaved={onSaved} />}
          {tab === 'voice'    && <VoiceTab    cfg={cfg} onSaved={onSaved} />}
          {tab === 'channels' && <ChannelsTab cfg={cfg} onSaved={onSaved} />}
          {tab === 'pipeline' && <PipelineTab cfg={cfg} onSaved={onSaved} />}
          {tab === 'agents'   && <AgentsTab   cfg={cfg} onSaved={onSaved} />}
          {tab === 'plugins'  && <PluginsTab  cfg={cfg} onSaved={onSaved} />}
          {tab === 'secrets'  && <SecretsTab />}
        </>
      )}
    </div>
  );
}
