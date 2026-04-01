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
    color: '#00d4ff',
    title: 'Privacy by architecture',
    body: 'Generic AI assistants promise privacy in their terms of service. Argos enforces it structurally. The pipeline is designed so that raw data physically cannot reach a cloud model — not because we ask nicely, but because the anonymizer runs locally before any external call is made.',
  },
  {
    color: '#00ff88',
    title: 'Human-in-the-loop',
    body: 'Most AI tools optimize for autonomy. Argos optimizes for trust. Every proposed action is a checkpoint. You\'re not signing a blank check — you\'re reviewing a specific, reversible proposal with full context about what will happen and why.',
  },
  {
    color: '#ff4466',
    title: 'Built for fintech & crypto',
    body: 'Ethereum addresses, transaction hashes, ENS names, DeFi protocol names, custody flows — Argos knows the vocabulary. The anonymizer has specific patterns for crypto PII that generic tools miss entirely.',
  },
]

export default function WhyArgos() {
  const ref = useRef(null)
  const inView = useInView(ref, { once: true })

  return (
    <section id="why" className="py-24 border-t border-[rgba(0,212,255,0.08)]">
      <div className="max-w-7xl mx-auto px-6">
        <motion.div
          ref={ref}
          initial={{ opacity: 0, y: 20 }}
          animate={inView ? { opacity: 1, y: 0 } : {}}
          className="mb-14"
        >
          <div className="section-label mb-3">// WHY ARGOS</div>
          <h2 className="text-3xl lg:text-4xl font-bold text-white mb-4">
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
          className="hud-card rounded-sm overflow-hidden mb-10"
        >
          <table className="w-full">
            <thead>
              <tr className="border-b border-[rgba(0,212,255,0.1)]">
                <th className="text-left px-5 py-4 text-text2 text-sm font-mono tracking-wide">Feature</th>
                <th className="px-5 py-4 text-center">
                  <div className="flex items-center justify-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-green animate-pulse" />
                    <span className="text-green font-mono text-sm tracking-widest">ARGOS</span>
                  </div>
                </th>
                <th className="px-5 py-4 text-center">
                  <span className="text-text2 font-mono text-sm tracking-wide">Generic AI Assistant</span>
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
                  className="border-b border-[rgba(0,212,255,0.06)] hover:bg-cyan/5 transition-colors"
                >
                  <td className="px-5 py-3.5 text-sm text-text">{row.feature}</td>
                  <td className="px-5 py-3.5 text-center">
                    <div className="flex flex-col items-center gap-0.5">
                      <div className={`flex items-center justify-center w-6 h-6 rounded-full ${row.argos ? 'bg-green/15' : 'bg-red/15'}`}>
                        {row.argos
                          ? <Check size={12} className="text-green" />
                          : <X size={12} className="text-red" />
                        }
                      </div>
                      <span className="text-xs text-text2/60 font-mono">{row.argosNote}</span>
                    </div>
                  </td>
                  <td className="px-5 py-3.5 text-center">
                    <div className="flex flex-col items-center gap-0.5">
                      <div className={`flex items-center justify-center w-6 h-6 rounded-full ${row.generic ? 'bg-red/15' : 'bg-text2/15'}`}>
                        {row.generic
                          ? <X size={12} className="text-red" />
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
              className="hud-card rounded-sm p-6"
              style={{ borderColor: `${box.color}25` }}
            >
              <div
                className="w-1 h-8 rounded-full mb-4"
                style={{ background: box.color, boxShadow: `0 0 10px ${box.color}60` }}
              />
              <h3 className="font-bold text-white mb-3">{box.title}</h3>
              <p className="text-text2 text-sm leading-relaxed">{box.body}</p>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  )
}
