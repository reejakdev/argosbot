import { motion } from 'framer-motion'
import { useInView } from 'framer-motion'
import { useRef } from 'react'
import {
  Download, ShieldCheck, EyeOff, Tag, Lightbulb, UserCheck
} from 'lucide-react'
import { Card } from './ui/Card'
import { Badge } from './ui/Badge'

const steps = [
  {
    num: '01',
    icon: Download,
    title: 'Ingest',
    desc: 'Messages arrive from Telegram MTProto, WhatsApp Baileys, IMAP email, Discord bot, or Slack bot. Each channel is isolated — one failure never crashes the pipeline.',
    badge: 'local',
    badgeLabel: 'local',
    color: '#00d4ff',
  },
  {
    num: '02',
    icon: ShieldCheck,
    title: 'Sanitize',
    desc: 'Regex fast-screen catches 10+ injection patterns instantly. Suspicious content gets a deeper LLM scan. Injections are quarantined and flagged before anything else runs.',
    badge: 'local',
    badgeLabel: 'local',
    color: '#00ff88',
  },
  {
    num: '03',
    icon: EyeOff,
    title: 'Anonymize',
    desc: 'ETH/BTC/SOL addresses, tx hashes, ENS names, exact amounts, emails, phone numbers — all replaced with typed placeholders like [ADDR_1] and [AMT_10K-100K_USDC]. A local lookup table holds the real values, never sent anywhere.',
    badge: 'local',
    badgeLabel: 'local',
    color: '#00ff88',
  },
  {
    num: '04',
    icon: Tag,
    title: 'Classify',
    desc: 'The anonymized content reaches the LLM classifier at temperature=0 for deterministic output. It assigns category, team routing, task detection, and completion signals.',
    badge: 'cloud',
    badgeLabel: 'cloud ok',
    color: '#00d4ff',
  },
  {
    num: '05',
    icon: Lightbulb,
    title: 'Plan',
    desc: 'The planner uses tool use to draft replies, schedule calendar events, create Notion pages, or prepare transaction review packs. Everything is a proposal — nothing executes yet.',
    badge: 'cloud',
    badgeLabel: 'cloud ok',
    color: '#00d4ff',
  },
  {
    num: '06',
    icon: UserCheck,
    title: 'Approve',
    desc: 'Every proposal hits your approval queue. You review, accept, or reject via the WebAuthn dashboard (YubiKey, passkey, or TOTP). High-risk actions require a fresh cryptographic assertion bound to the proposal ID.',
    badge: 'human',
    badgeLabel: 'human',
    color: '#ff4466',
  },
]

function StepCard({ step, index }: { step: typeof steps[0]; index: number }) {
  const ref = useRef(null)
  const inView = useInView(ref, { once: true, margin: '-50px' })
  const Icon = step.icon

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 40 }}
      animate={inView ? { opacity: 1, y: 0 } : {}}
      transition={{ delay: index * 0.1, duration: 0.5 }}
    >
      <Card hover className="h-full">
        <div className="flex items-start gap-4">
          <div className="flex-shrink-0">
            <div
              className="w-10 h-10 rounded-sm flex items-center justify-center"
              style={{
                background: `${step.color}15`,
                border: `1px solid ${step.color}30`,
              }}
            >
              <Icon size={18} style={{ color: step.color }} />
            </div>
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 mb-2">
              <span className="font-mono text-xs text-text2/50">{step.num}</span>
              <h3 className="font-bold text-white text-base">{step.title}</h3>
              <Badge
                label={step.badgeLabel}
                variant={step.badge as 'local' | 'cloud' | 'human'}
              />
            </div>
            <p className="text-text2 text-sm leading-relaxed">{step.desc}</p>
          </div>
        </div>
      </Card>
    </motion.div>
  )
}

export default function Pipeline() {
  const ref = useRef(null)
  const inView = useInView(ref, { once: true })

  return (
    <section id="pipeline" className="py-24 max-w-7xl mx-auto px-6">
      <motion.div
        ref={ref}
        initial={{ opacity: 0, y: 20 }}
        animate={inView ? { opacity: 1, y: 0 } : {}}
        className="mb-14"
      >
        <div className="section-label mb-3">// ARCHITECTURE</div>
        <h2 className="text-3xl lg:text-4xl font-bold text-white mb-4">
          The 6-Step{' '}
          <span className="gradient-text">Privacy Pipeline</span>
        </h2>
        <p className="text-text2 max-w-2xl leading-relaxed">
          Every message passes through a deterministic pipeline before any AI touches it.
          Privacy is enforced at the architecture level — not a policy, not a checkbox.
        </p>
      </motion.div>

      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-5 mb-12">
        {steps.map((step, i) => (
          <StepCard key={step.title} step={step} index={i} />
        ))}
      </div>

      {/* Key insight box */}
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        className="hud-card hud-card-green rounded-sm p-6"
        style={{ background: 'rgba(0,255,136,0.04)' }}
      >
        <div className="flex items-start gap-4">
          <EyeOff size={20} className="text-green flex-shrink-0 mt-0.5" />
          <div>
            <div className="font-mono text-xs text-green tracking-widest mb-2">KEY INSIGHT — ANONYMIZATION</div>
            <p className="text-text leading-relaxed text-sm">
              The LLM anonymizer that de-identifies sensitive data runs{' '}
              <span className="text-green font-semibold">exclusively on local models</span> (Ollama, LM Studio, etc.).
              Running it on a cloud model would be self-defeating — you'd be sending the raw PII to the very service
              you're trying to protect against. The cloud classifier and planner only ever see sanitized, anonymized
              placeholders. The real values live in an in-memory lookup table that never leaves your machine.
            </p>
          </div>
        </div>
      </motion.div>
    </section>
  )
}
