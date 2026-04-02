import { motion } from 'framer-motion'
import { useInView } from 'framer-motion'
import { useRef } from 'react'
import { Lock, Database, Cpu, ShieldAlert } from 'lucide-react'

const rules = [
  {
    icon: Database,
    color: '#059669',
    title: 'Raw content is never stored',
    desc: 'Messages exist in memory only during processing. No raw text ever touches the database. Only SHA-256 hashes and anonymized summaries are persisted.',
  },
  {
    icon: Lock,
    color: '#4f6eff',
    title: 'PII anonymized before any LLM',
    desc: 'ETH/BTC addresses, transaction hashes, amounts, names, emails, phone numbers — all replaced with typed placeholders before the first token is sent to any model.',
  },
  {
    icon: Cpu,
    color: '#059669',
    title: 'LLM anonymizer runs local-only',
    desc: 'The model that strips your PII never runs on a cloud provider. Sending raw data to a cloud model to anonymize it would defeat the purpose entirely. Local model only.',
  },
  {
    icon: ShieldAlert,
    color: '#dc2626',
    title: 'Every action requires approval',
    desc: 'No autonomous execution. Every proposal from the planner hits a human checkpoint with expiry. High-risk actions require a fresh YubiKey/passkey assertion cryptographically bound to the proposal ID.',
  },
]

const flowSteps = [
  { label: 'Raw Message', sub: 'From Telegram / WhatsApp / Email', color: '#dc2626', dot: true },
  { label: 'Regex Anonymizer', sub: 'Replaces addresses, amounts, PII', color: '#4f6eff', dot: false },
  { label: 'LLM Anonymizer', sub: 'Local model only — deep semantic anon', color: '#059669', dot: false },
  { label: 'Classify + Plan', sub: 'Cloud LLM sees only [PLACEHOLDERS]', color: '#4f6eff', dot: false },
  { label: 'De-anonymize', sub: 'Real values restored from local map', color: '#059669', dot: false },
  { label: 'You Approve', sub: 'WebAuthn / passkey / TOTP', color: '#dc2626', dot: true },
]

export default function Privacy() {
  const ref = useRef(null)
  const inView = useInView(ref, { once: true })

  return (
    <section
      id="privacy"
      className="py-24"
      style={{
        borderTop: '1px solid #e5e7eb',
        background: '#ebebeb',
      }}
    >
      <div className="max-w-7xl mx-auto px-6">
        <motion.div
          ref={ref}
          initial={{ opacity: 0, y: 20 }}
          animate={inView ? { opacity: 1, y: 0 } : {}}
          className="mb-14"
        >
          <div className="section-label mb-3">Privacy Model</div>
          <h2 className="text-3xl lg:text-4xl font-bold mb-4" style={{ color: '#111827' }}>
            Privacy is{' '}
            <span className="gradient-text">architecture</span>, not policy
          </h2>
          <p className="text-text2 max-w-2xl leading-relaxed">
            Most AI tools promise privacy in their terms of service. Argos enforces it structurally —
            your raw data physically cannot reach a cloud model.
          </p>
        </motion.div>

        <div className="grid lg:grid-cols-2 gap-12 items-start">
          {/* Left: Rules */}
          <div className="space-y-4">
            {rules.map((rule, i) => {
              const Icon = rule.icon
              return (
                <motion.div
                  key={rule.title}
                  initial={{ opacity: 0, x: -30 }}
                  whileInView={{ opacity: 1, x: 0 }}
                  viewport={{ once: true }}
                  transition={{ delay: i * 0.1, duration: 0.5 }}
                  className="flex items-start gap-4 p-5 rounded-lg"
                  style={{
                    background: 'var(--surface)',
                    border: '1px solid var(--border)',
                    boxShadow: '0 1px 3px #e5e7eb',
                  }}
                >
                  <div className="flex-shrink-0 mt-0.5">
                    <div
                      className="w-8 h-8 rounded-lg flex items-center justify-center"
                      style={{ background: `${rule.color}10`, border: `1px solid ${rule.color}25` }}
                    >
                      <Icon size={16} style={{ color: rule.color }} />
                    </div>
                  </div>
                  <div>
                    <h3 className="font-semibold mb-1.5" style={{ color: '#111827' }}>{rule.title}</h3>
                    <p className="text-text2 text-sm leading-relaxed">{rule.desc}</p>
                  </div>
                </motion.div>
              )
            })}
          </div>

          {/* Right: Data flow diagram */}
          <motion.div
            initial={{ opacity: 0, x: 30 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.6 }}
            className="rounded-lg p-6"
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              boxShadow: '0 1px 3px #e5e7eb',
            }}
          >
            <div className="text-xs font-semibold tracking-wide mb-6" style={{ color: '#4f6eff' }}>
              DATA FLOW DIAGRAM
            </div>
            <div className="space-y-0">
              {flowSteps.map((step, i) => (
                <div key={step.label} className="relative">
                  <div className="flex items-start gap-4">
                    <div className="flex flex-col items-center flex-shrink-0 w-6">
                      <motion.div
                        className="w-3 h-3 rounded-full border-2 flex-shrink-0"
                        style={{ borderColor: step.color, background: step.dot ? step.color : 'transparent' }}
                        animate={{ opacity: [1, 0.6, 1] }}
                        transition={{ duration: 2, repeat: Infinity, delay: i * 0.3 }}
                      />
                      {i < flowSteps.length - 1 && (
                        <motion.div
                          className="w-px flex-1 my-1"
                          style={{ background: `linear-gradient(to bottom, ${step.color}50, ${flowSteps[i + 1].color}30)`, minHeight: '28px' }}
                          initial={{ scaleY: 0 }}
                          whileInView={{ scaleY: 1 }}
                          viewport={{ once: true }}
                          transition={{ delay: 0.2 + i * 0.15, duration: 0.4 }}
                        />
                      )}
                    </div>
                    <div className="pb-4">
                      <div className="font-semibold text-sm" style={{ color: '#111827' }}>{step.label}</div>
                      <div className="text-text2 text-xs mt-0.5">{step.sub}</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* Placeholder example */}
            <div
              className="mt-4 p-3 rounded-lg"
              style={{
                background: '#e4e4e4',
                border: '1px solid #e5e7eb',
              }}
            >
              <div className="font-mono text-xs mb-2" style={{ color: '#9ca3af' }}>Cloud model receives:</div>
              <code className="text-xs leading-loose block" style={{ color: '#1f2937', fontFamily: 'JetBrains Mono, Courier New, monospace' }}>
                <span style={{ color: '#4f6eff' }}>[PERSON_1]</span> wants to send{' '}
                <span style={{ color: '#4f6eff' }}>[AMT_10K-100K_USDC]</span> to{' '}
                <span style={{ color: '#4f6eff' }}>[ADDR_1]</span>
                <br />
                via <span style={{ color: '#6b7280' }}>[NETWORK_1]</span>. Please draft a reply.
              </code>
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  )
}
