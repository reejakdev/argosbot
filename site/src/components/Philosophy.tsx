import { motion } from 'framer-motion'
import { useInView } from 'framer-motion'
import { useRef } from 'react'
import { Eye, ShieldCheck, UserCheck } from 'lucide-react'

const principles = [
  {
    icon: Eye,
    color: '#4f6eff',
    title: 'Read by default',
    desc: 'Argos observes every message, every channel, every thread. But observation is not action. The system accumulates context silently — building a picture of what matters — without ever reaching out or modifying anything on its own.',
  },
  {
    icon: ShieldCheck,
    color: '#10b981',
    title: 'Sanitize before memory',
    desc: 'Before any message is classified, stored, or reasoned about, it passes through a sanitization layer. Raw content is stripped of PII, crypto addresses, and injections. Your memory store and your LLM context only ever see safe, anonymized representations.',
  },
  {
    icon: UserCheck,
    color: '#ef4444',
    title: 'Approve before action',
    desc: 'Every action — draft reply, calendar event, Notion page, transaction review — is presented as a proposal. You have the final word. Always. The system\'s job is to reduce cognitive load and surface options, not to decide for you.',
  },
]

export default function Philosophy() {
  const ref = useRef(null)
  const inView = useInView(ref, { once: true })

  return (
    <section
      id="philosophy"
      className="py-24"
      style={{
        borderTop: '1px solid #f3f4f6',
        background: 'var(--bg2)',
      }}
    >
      <div className="max-w-7xl mx-auto px-6">
        <motion.div
          ref={ref}
          initial={{ opacity: 0, y: 20 }}
          animate={inView ? { opacity: 1, y: 0 } : {}}
          className="mb-14 text-center"
        >
          <div className="section-label mb-3 text-center">Philosophy</div>
          <h2 className="text-3xl lg:text-4xl font-bold text-text mb-8">Design Principles</h2>

          {/* Quote block */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            whileInView={{ opacity: 1, scale: 1 }}
            viewport={{ once: true }}
            className="max-w-3xl mx-auto mb-14"
          >
            <div
              className="relative p-8 rounded-xl"
              style={{
                background: 'linear-gradient(135deg, #f9fafb, rgba(123,150,255,0.04))',
                border: '1px solid #e5e7eb',
                boxShadow: '0 4px 32px rgba(0,0,0,0.4)',
              }}
            >
              <blockquote className="text-xl lg:text-2xl font-light text-text leading-relaxed italic">
                "Named after Argos Panoptes — the hundred-eyed giant of Greek mythology who never slept
                and guarded everything — but acted only on Zeus's orders."
              </blockquote>
              <div className="mt-5 flex items-center justify-center gap-3">
                <div className="w-8 h-px" style={{ background: 'rgba(79,110,255,0.4)' }} />
                <span className="text-text2 text-sm font-medium tracking-wider">GREEK MYTHOLOGY</span>
                <div className="w-8 h-px" style={{ background: 'rgba(79,110,255,0.4)' }} />
              </div>
            </div>
          </motion.div>
        </motion.div>

        <div className="grid md:grid-cols-3 gap-6">
          {principles.map((p, i) => {
            const Icon = p.icon
            return (
              <motion.div
                key={p.title}
                initial={{ opacity: 0, y: 30 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.15, duration: 0.5 }}
                className="rounded-xl p-6 text-center"
                style={{
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                  boxShadow: '0 4px 24px rgba(0,0,0,0.35)',
                }}
              >
                <div
                  className="w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-4"
                  style={{
                    background: `${p.color}12`,
                    border: `1px solid ${p.color}25`,
                  }}
                >
                  <Icon size={20} style={{ color: p.color }} />
                </div>
                <h3 className="font-semibold text-text text-lg mb-3">{p.title}</h3>
                <p className="text-text2 text-sm leading-relaxed">{p.desc}</p>
              </motion.div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
