import { motion } from 'framer-motion'
import { useInView } from 'framer-motion'
import { useRef } from 'react'
import {
  Zap, FileText, BookOpen, Brain, CheckSquare, Puzzle, Link2, Bell, Key
} from 'lucide-react'

const features = [
  {
    icon: Zap,
    color: '#4f6eff',
    title: 'Triage Engine',
    desc: 'Fast regex pre-screen catches noise before the expensive LLM call. Messages are categorized, team-routed, and scored for urgency at near-zero cost.',
  },
  {
    icon: FileText,
    color: '#10b981',
    title: 'RAG-backed Drafts',
    desc: 'Drafts are grounded in your knowledge base. LanceDB semantic search retrieves relevant context before the planner generates any response — no hallucinated facts.',
  },
  {
    icon: BookOpen,
    color: '#4f6eff',
    title: 'Knowledge Base',
    desc: 'Connect Notion pages, GitHub repos, and URLs. Argos chunks, embeds, and indexes them in LanceDB. Your assistant stays current with your actual documentation.',
  },
  {
    icon: Brain,
    color: '#10b981',
    title: 'Personal Memory',
    desc: 'Anonymized summaries stored with FTS5 full-text search and semantic embeddings. Configurable TTL (default 30 days). Auto-archives high-importance memories for 1 year.',
  },
  {
    icon: CheckSquare,
    color: '#ef4444',
    title: 'Proposal Queue',
    desc: 'Every LLM action plan queues for human review. Approve, reject, or edit before anything executes. Proposals expire automatically — no stale actions lurking.',
  },
  {
    icon: Puzzle,
    color: '#4f6eff',
    title: 'Plugin System',
    desc: 'TypeScript plugin API with onBoot, onMessage, and onShutdown hooks. Plugins can inject messages, register tools, or trigger background tasks. Full lifecycle control.',
  },
  {
    icon: Link2,
    color: '#10b981',
    title: 'MCP Integrations',
    desc: 'Model Context Protocol support — connect Argos to any MCP server. Expose external tools (databases, APIs, services) to the planner via the standardized protocol.',
  },
  {
    icon: Bell,
    color: '#4f6eff',
    title: 'Briefing Mode',
    desc: 'Scheduled heartbeat that synthesizes open tasks, pending proposals, and recent memories into a concise daily briefing. Delivered to your chosen channel.',
  },
  {
    icon: Key,
    color: '#ef4444',
    title: 'WebAuthn Dashboard',
    desc: 'Local web app secured by FIDO2/YubiKey passkeys with TOTP backup. Review proposals, manage tasks, browse memories — all behind hardware authentication.',
  },
]

export default function Features() {
  const ref = useRef(null)
  const inView = useInView(ref, { once: true })

  return (
    <section
      id="features"
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
          <div className="section-label mb-3">Capabilities</div>
          <h2 className="text-3xl lg:text-4xl font-bold text-white mb-4">
            Everything you need.{' '}
            <span className="gradient-text">Nothing you don't.</span>
          </h2>
          <p className="text-text2 max-w-2xl leading-relaxed">
            Argos ships with 9 core capabilities built for professional use in fintech and crypto environments.
            No feature flags, no paywalls — MIT licensed.
          </p>
        </motion.div>

        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-5">
          {features.map((feature, i) => {
            const Icon = feature.icon
            return (
              <motion.div
                key={feature.title}
                initial={{ opacity: 0, y: 30 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.07, duration: 0.5 }}
                whileHover={{ y: -3 }}
                className="p-5 rounded-lg group cursor-default transition-all duration-200"
                style={{
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                  boxShadow: '0 4px 24px rgba(0,0,0,0.35)',
                }}
              >
                <div
                  className="w-9 h-9 rounded-lg flex items-center justify-center mb-4 transition-transform duration-300 group-hover:scale-110"
                  style={{
                    background: `${feature.color}12`,
                    border: `1px solid ${feature.color}22`,
                  }}
                >
                  <Icon size={17} style={{ color: feature.color }} />
                </div>
                <h3 className="font-semibold text-white mb-2">{feature.title}</h3>
                <p className="text-text2 text-sm leading-relaxed">{feature.desc}</p>
              </motion.div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
