import { motion } from 'framer-motion'
import { useInView } from 'framer-motion'
import { useRef } from 'react'
import { CodeBlock } from './ui/CodeBlock'
import { Badge } from './ui/Badge'

const configCode = `// ~/.argos/config.json
{
  "llm": {
    "provider": "anthropic",
    "model": "claude-opus-4-5",
    "apiKey": "sk-ant-..."
  },
  "llmLocal": {
    "provider": "ollama",
    "model": "llama3.2",
    "baseUrl": "http://localhost:11434"
  },
  "fallback": {
    "provider": "openai",
    "model": "gpt-4o-mini"
  }
}`

const providers = [
  { name: 'Anthropic Claude', notes: 'Primary — best tool use', badge: 'cloud' },
  { name: 'OpenAI GPT-4o', notes: 'Fallback + function calls', badge: 'cloud' },
  { name: 'Groq', notes: 'Fast inference (Llama, Mixtral)', badge: 'cloud' },
  { name: 'Google Gemini', notes: 'Long context window', badge: 'cloud' },
  { name: 'DeepSeek', notes: 'Cost-efficient reasoning', badge: 'cloud' },
  { name: 'Mistral', notes: 'EU-based privacy option', badge: 'cloud' },
  { name: 'xAI Grok', notes: 'Real-time knowledge', badge: 'cloud' },
  { name: 'Together AI', notes: 'Open models on cloud', badge: 'cloud' },
  { name: 'Perplexity', notes: 'Search-augmented', badge: 'cloud' },
  { name: 'Cohere', notes: 'Enterprise RAG', badge: 'cloud' },
  { name: 'Ollama', notes: 'Local LLM anonymizer', badge: 'local' },
  { name: 'LM Studio', notes: 'Local dev environment', badge: 'local' },
  { name: 'OpenAI-compatible', notes: 'Any custom endpoint', badge: 'local' },
]

export default function MultiModel() {
  const ref = useRef(null)
  const inView = useInView(ref, { once: true })

  return (
    <section
      id="models"
      className="py-24"
      style={{ borderTop: '1px solid rgba(79,110,255,0.08)' }}
    >
      <div className="max-w-7xl mx-auto px-6">
        <motion.div
          ref={ref}
          initial={{ opacity: 0, y: 20 }}
          animate={inView ? { opacity: 1, y: 0 } : {}}
          className="mb-14"
        >
          <div className="section-label mb-3">Multi-Model</div>
          <h2 className="text-3xl lg:text-4xl font-bold text-white mb-4">
            15+ LLM providers.{' '}
            <span className="gradient-text">One config.</span>
          </h2>
          <p className="text-text2 max-w-2xl leading-relaxed">
            Argos uses a unified multi-provider abstraction. Swap models without changing pipeline code.
            Configure primary, local (anonymizer), and fallback providers independently.
          </p>
        </motion.div>

        <div className="grid lg:grid-cols-2 gap-10 items-start">
          {/* Left: explanation + code */}
          <div>
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              className="space-y-3 mb-6"
            >
              <div
                className="rounded-lg p-4"
                style={{
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                  boxShadow: '0 4px 24px rgba(0,0,0,0.3)',
                }}
              >
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-2 h-2 rounded-full" style={{ background: '#4f6eff' }} />
                  <span className="text-sm font-semibold text-white">Primary LLM</span>
                  <Badge label="cloud" variant="cloud" />
                </div>
                <p className="text-text2 text-sm">
                  Used for classification and planning. Must support tool use. Any OpenAI-compatible endpoint works.
                </p>
              </div>
              <div
                className="rounded-lg p-4"
                style={{
                  background: 'var(--surface)',
                  border: '1px solid rgba(16,185,129,0.2)',
                  boxShadow: '0 4px 24px rgba(0,0,0,0.3)',
                }}
              >
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-2 h-2 rounded-full" style={{ background: '#10b981' }} />
                  <span className="text-sm font-semibold text-white">Local LLM</span>
                  <Badge label="local" variant="local" />
                </div>
                <p className="text-text2 text-sm">
                  Runs the LLM anonymizer — the only model that ever sees raw PII. Stays on your machine. Ollama or LM Studio recommended.
                </p>
              </div>
              <div
                className="rounded-lg p-4"
                style={{
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                  boxShadow: '0 4px 24px rgba(0,0,0,0.3)',
                }}
              >
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-2 h-2 rounded-full bg-text2" />
                  <span className="text-sm font-semibold text-white">Fallback LLM</span>
                  <Badge label="cloud" variant="cloud" />
                </div>
                <p className="text-text2 text-sm">
                  Activated on 5xx errors, 429 rate limits, or timeout. Transparent failover — pipeline never stalls.
                </p>
              </div>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: 0.2 }}
            >
              <CodeBlock code={configCode} language="json" title="config.json" />
            </motion.div>
          </div>

          {/* Right: provider table */}
          <motion.div
            initial={{ opacity: 0, x: 30 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5 }}
            className="rounded-lg overflow-hidden"
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
            }}
          >
            <div
              className="px-4 py-3 border-b flex items-center gap-2"
              style={{ borderColor: 'rgba(79,110,255,0.1)' }}
            >
              <div className="text-xs font-semibold tracking-wide" style={{ color: '#7b96ff' }}>SUPPORTED PROVIDERS</div>
              <span className="ml-auto text-xs text-text2 font-mono">{providers.length} total</span>
            </div>
            <div style={{ borderColor: 'rgba(79,110,255,0.06)' }}>
              {providers.map((p, i) => (
                <motion.div
                  key={p.name}
                  initial={{ opacity: 0, x: 20 }}
                  whileInView={{ opacity: 1, x: 0 }}
                  viewport={{ once: true }}
                  transition={{ delay: i * 0.04 }}
                  className="flex items-center justify-between px-4 py-3 transition-colors"
                  style={{ borderBottom: i < providers.length - 1 ? '1px solid rgba(79,110,255,0.06)' : 'none' }}
                  onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = 'rgba(79,110,255,0.04)'}
                  onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'transparent'}
                >
                  <div>
                    <div className="text-white text-sm font-medium">{p.name}</div>
                    <div className="text-text2 text-xs mt-0.5">{p.notes}</div>
                  </div>
                  <Badge
                    label={p.badge}
                    variant={p.badge as 'local' | 'cloud'}
                  />
                </motion.div>
              ))}
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  )
}
