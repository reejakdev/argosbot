import { motion } from 'framer-motion'
import { useInView } from 'framer-motion'
import { useRef } from 'react'
import { Check, X } from 'lucide-react'

const rows = [
  {
    feature: 'Raw messages stored on cloud',
    argos: false,
    generic: true,
    argosNote: 'Never stored or sent',
    genericNote: 'Trained on / logged',
  },
  {
    feature: 'PII anonymized before LLM',
    argos: true,
    generic: false,
    argosNote: 'Structural enforcement',
    genericNote: 'Policy / TOS only',
  },
  {
    feature: 'Action requires human approval',
    argos: true,
    generic: false,
    argosNote: 'WebAuthn gated',
    genericNote: 'Often autonomous',
  },
  {
    feature: 'Data stays on your machine',
    argos: true,
    generic: false,
    argosNote: '100% local-first',
    genericNote: 'Cloud dependent',
  },
  {
    feature: 'Open source / auditable',
    argos: true,
    generic: false,
    argosNote: 'MIT license',
    genericNote: 'Closed source',
  },
  {
    feature: 'Pluggable LLM provider',
    argos: true,
    generic: false,
    argosNote: '15+ providers',
    genericNote: 'Single vendor lock-in',
  },
  {
    feature: 'Plugin / extension API',
    argos: true,
    generic: false,
    argosNote: 'TypeScript SDK',
    genericNote: 'Limited / none',
  },
  {
    feature: 'Crypto / fintech aware',
    argos: true,
    generic: false,
    argosNote: 'Address & tx redaction',
    genericNote: 'Generic only',
  },
]

const boxes = [
  {
    color: '#4f6eff',
    title: 'Privacy by architecture',
    body: 'Generic AI assistants promise privacy in their terms of service. Argos enforces it structurally. The pipeline is designed so that raw data physically cannot reach a cloud model — not because we ask nicely, but because the anonymizer runs locally before any external call is made.',
  },
  {
    color: '#10b981',
    title: 'Human-in-the-loop',
    body: 'Most AI tools optimize for autonomy. Argos optimizes for trust. Every proposed action is a checkpoint. You\'re not signing a blank check — you\'re reviewing a specific, reversible proposal with full context about what will happen and why.',
  },
  {
    color: '#ef4444',
    title: 'Built for fintech & crypto',
    body: 'Ethereum addresses, transaction hashes, ENS names, DeFi protocol names, custody flows — Argos knows the vocabulary. The anonymizer has specific patterns for crypto PII that generic tools miss entirely.',
  },
]

export default function WhyArgos() {
  const ref = useRef(null)
  const inView = useInView(ref, { once: true })

  return (
    <section
      id="why"
      className="py-24"
      style={{ borderTop: '1px solid #f3f4f6' }}
    >
      <div className="max-w-7xl mx-auto px-6">
        <motion.div
          ref={ref}
          initial={{ opacity: 0, y: 20 }}
          animate={inView ? { opacity: 1, y: 0 } : {}}
          className="mb-14"
        >
          <div className="section-label mb-3">Why Argos</div>
          <h2 className="text-3xl lg:text-4xl font-bold text-text mb-4">
            Not just another{' '}
            <span className="gradient-text">AI assistant</span>
          </h2>
          <p className="text-text2 max-w-2xl leading-relaxed">
            The AI assistant market is full of tools that optimize for convenience.
            Argos optimizes for trust, control, and privacy — without sacrificing capability.
          </p>
        </motion.div>

        {/* Comparison table */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          className="rounded-xl overflow-hidden mb-10"
          style={{
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            boxShadow: '0 4px 32px rgba(0,0,0,0.4)',
          }}
        >
          <table className="w-full">
            <thead>
              <tr style={{ borderBottom: '1px solid rgba(79,110,255,0.08)' }}>
                <th className="text-left px-5 py-4 text-text2 text-sm font-medium">Feature</th>
                <th className="px-5 py-4 text-center">
                  <div className="flex items-center justify-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-green animate-pulse" />
                    <span className="font-semibold text-sm" style={{ color: '#10b981' }}>ARGOS</span>
                  </div>
                </th>
                <th className="px-5 py-4 text-center">
                  <span className="text-text2 text-sm font-medium">Generic AI Assistant</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <motion.tr
                  key={row.feature}
                  initial={{ opacity: 0, x: -20 }}
                  whileInView={{ opacity: 1, x: 0 }}
                  viewport={{ once: true }}
                  transition={{ delay: i * 0.06 }}
                  style={{ borderBottom: '1px solid #f9fafb' }}
                  onMouseEnter={e => (e.currentTarget as HTMLElement).style.background = '#ebebeb'}
                  onMouseLeave={e => (e.currentTarget as HTMLElement).style.background = 'transparent'}
                  className="transition-colors"
                >
                  <td className="px-5 py-3.5 text-sm text-text">{row.feature}</td>
                  <td className="px-5 py-3.5 text-center">
                    <div className="flex flex-col items-center gap-0.5">
                      <div
                        className="flex items-center justify-center w-6 h-6 rounded-full"
                        style={{ background: row.argos ? 'rgba(16,185,129,0.12)' : 'rgba(239,68,68,0.12)' }}
                      >
                        {row.argos
                          ? <Check size={12} style={{ color: '#10b981' }} />
                          : <X size={12} style={{ color: '#ef4444' }} />
                        }
                      </div>
                      <span className="text-xs text-text2/60 font-mono">{row.argosNote}</span>
                    </div>
                  </td>
                  <td className="px-5 py-3.5 text-center">
                    <div className="flex flex-col items-center gap-0.5">
                      <div
                        className="flex items-center justify-center w-6 h-6 rounded-full"
                        style={{ background: row.generic ? 'rgba(239,68,68,0.12)' : 'rgba(148,163,184,0.1)' }}
                      >
                        {row.generic
                          ? <X size={12} style={{ color: '#ef4444' }} />
                          : <Check size={12} className="text-text2" />
                        }
                      </div>
                      <span className="text-xs text-text2/60 font-mono">{row.genericNote}</span>
                    </div>
                  </td>
                </motion.tr>
              ))}
            </tbody>
          </table>
        </motion.div>

        {/* 3-col explanation boxes */}
        <div className="grid md:grid-cols-3 gap-5">
          {boxes.map((box, i) => (
            <motion.div
              key={box.title}
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.15 }}
              className="rounded-lg p-6"
              style={{
                background: 'var(--surface)',
                border: `1px solid ${box.color}20`,
                boxShadow: '0 4px 24px rgba(0,0,0,0.35)',
              }}
            >
              <div
                className="w-1 h-8 rounded-full mb-4"
                style={{ background: box.color }}
              />
              <h3 className="font-semibold text-text mb-3">{box.title}</h3>
              <p className="text-text2 text-sm leading-relaxed">{box.body}</p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  )
}
