import { motion } from 'framer-motion'
import { useInView } from 'framer-motion'
import { useRef } from 'react'
import { CheckCircle2, Circle, Hexagon } from 'lucide-react'

const v1Done = [
  'Telegram MTProto + Bot',
  'WhatsApp via Baileys',
  'Email IMAP + SMTP',
  'Injection sanitizer',
  'Regex anonymizer',
  'LLM anonymizer (local)',
  'Claude classifier',
  'Multi-provider LLM abstraction',
  'Planning with tool use',
  'Proposal queue',
  'WebAuthn / YubiKey auth',
  'TOTP backup auth',
  'Approval gateway',
  'Google Calendar worker',
  'Notion worker',
  'Tx review packs (read-only)',
  'SQLite WAL + FTS5',
  'LanceDB vector search',
  'Plugin API + registry',
  'MCP client support',
  'Cron scheduler',
  'Briefing mode (heartbeat)',
  'Setup wizard',
  'Health check (doctor)',
  'Audit log (immutable)',
]

const v2Next = [
  'React Native / Expo mobile app',
  'macOS menu bar (Tauri)',
  'Discord channel integration',
  'Slack channel integration',
  'Linear worker',
  'GitHub PRs + issues reader',
  'Fordefi simulation API',
  'On-chain RPC data reads',
  'Knowledge base UI',
  'Proposal diff editor',
]

const v3Future = [
  'Multi-user / multi-employee',
  'Telegram org bot mode',
  'Docker image + compose',
  'SOC2 / audit log export',
  'SSO / SAML support',
  'White-label packaging',
  'Admin dashboard',
  'Policy engine (RBAC)',
  'Encrypted backup',
  'API for third-party integrations',
]

function RoadmapColumn({
  title,
  version,
  items,
  color,
  icon: Icon,
  index,
}: {
  title: string
  version: string
  items: string[]
  color: string
  icon: React.FC<{ size?: number; className?: string; style?: React.CSSProperties }>
  index: number
}) {
  const ref = useRef(null)

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 30 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ delay: index * 0.15, duration: 0.5 }}
      className="hud-card rounded-sm overflow-hidden"
    >
      <div
        className="px-5 py-4 border-b border-[rgba(0,212,255,0.1)]"
        style={{ background: `${color}08` }}
      >
        <div className="flex items-center gap-3">
          <Icon size={16} style={{ color }} />
          <div>
            <div className="font-mono text-xs tracking-widest" style={{ color, opacity: 0.7 }}>
              {version}
            </div>
            <div className="font-bold text-white text-sm">{title}</div>
          </div>
          <span className="ml-auto text-xs font-mono text-text2">{items.length} items</span>
        </div>
      </div>
      <div className="p-5 space-y-2">
        {items.map((item, i) => (
          <motion.div
            key={item}
            initial={{ opacity: 0, x: -10 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            transition={{ delay: index * 0.1 + i * 0.03 }}
            className="flex items-center gap-2.5 text-sm"
          >
            <Icon
              size={13}
              style={{ color, flexShrink: 0, opacity: version === 'v1 — DONE' ? 1 : 0.5 }}
            />
            <span className={version === 'v1 — DONE' ? 'text-text' : 'text-text2'}>{item}</span>
          </motion.div>
        ))}
      </div>
    </motion.div>
  )
}

export default function Roadmap() {
  const ref = useRef(null)
  const inView = useInView(ref, { once: true })

  return (
    <section className="py-24 border-t border-[rgba(0,212,255,0.08)]">
      <div className="max-w-7xl mx-auto px-6">
        <motion.div
          ref={ref}
          initial={{ opacity: 0, y: 20 }}
          animate={inView ? { opacity: 1, y: 0 } : {}}
          className="mb-14"
        >
          <div className="section-label mb-3">// ROADMAP</div>
          <h2 className="text-3xl lg:text-4xl font-bold text-white mb-4">
            Built in the open.{' '}
            <span className="gradient-text">Shipped iteratively.</span>
          </h2>
          <p className="text-text2 max-w-2xl leading-relaxed">
            v1 ships with the full privacy pipeline and 5 channels. Mobile and enterprise features follow.
            Everything is open source and community-driven.
          </p>
        </motion.div>

        <div className="grid md:grid-cols-3 gap-5">
          <RoadmapColumn
            title="Core Pipeline"
            version="v1 — DONE"
            items={v1Done}
            color="#00ff88"
            icon={CheckCircle2}
            index={0}
          />
          <RoadmapColumn
            title="Native + Extended"
            version="v2 — NEXT"
            items={v2Next}
            color="#00d4ff"
            icon={Circle}
            index={1}
          />
          <RoadmapColumn
            title="Multi-user / Enterprise"
            version="v3 — FUTURE"
            items={v3Future}
            color="#6a80a8"
            icon={Hexagon}
            index={2}
          />
        </div>
      </div>
    </section>
  )
}
