import { motion } from 'framer-motion'
import { useInView } from 'framer-motion'
import { useRef } from 'react'
import {
  Zap, Database, Brain, CheckSquare, Puzzle,
  Globe, Lock, Eye, Mic, GitBranch, Terminal, Layers, Radio,
} from 'lucide-react'

const features = [
  {
    icon: Zap,
    color: '#5b6cf8',
    title: 'Triage Engine',
    desc: 'Fast regex pre-screen catches noise before the expensive LLM call. Messages are categorized, team-routed, and scored for urgency at near-zero cost.',
  },
  {
    icon: Database,
    color: '#16a34a',
    title: 'RAG-backed Drafts',
    desc: 'Drafts are grounded in your knowledge base. LanceDB semantic search retrieves relevant context before the planner generates any response — no hallucinated facts.',
  },
  {
    icon: Brain,
    color: '#5b6cf8',
    title: 'Knowledge Base',
    desc: 'Connect Notion, GitHub repos, Linear issues, and URLs. Argos chunks, embeds, and indexes everything. Your assistant stays current with your actual docs.',
  },
  {
    icon: CheckSquare,
    color: '#16a34a',
    title: 'Proposal Queue',
    desc: 'Every LLM action plan queues for human review. Approve, reject, or edit before anything executes. Proposals expire automatically — no stale actions lurking.',
  },
  {
    icon: Eye,
    color: '#5b6cf8',
    title: 'Vision / OCR',
    desc: 'Images and photos in Telegram or WhatsApp are passed as multimodal content blocks to Claude or Gemini. Extract text, read screenshots, analyze diagrams automatically.',
  },
  {
    icon: Mic,
    color: '#16a34a',
    title: 'Voice I/O',
    desc: 'Telegram voice messages transcribed via Whisper. Responses synthesized as voice notes via ElevenLabs TTS. Full voice workflow — send a voice note, get one back.',
  },
  {
    icon: Terminal,
    color: '#dc2626',
    title: 'Shell Exec Worker',
    desc: 'Whitelisted shell commands can be queued as proposals. Strict allowlist (no rm, no sudo), always requires human approval, stdout/stderr captured and returned.',
  },
  {
    icon: Layers,
    color: '#5b6cf8',
    title: 'Multi-agent',
    desc: 'A coordinator agent spawns N specialized sub-agents in parallel via spawn_agent tool. Each has its own context and toolset. Results merged before proposing actions.',
  },
  {
    icon: GitBranch,
    color: '#16a34a',
    title: 'Knowledge Graph',
    desc: 'After classification, named entities (persons, companies, amounts) and their relations are extracted into an entities table. Query: "what do I know about company X?"',
  },
  {
    icon: Puzzle,
    color: '#5b6cf8',
    title: 'Plugin System',
    desc: 'TypeScript plugin API with onBoot, onMessage, and onShutdown hooks. Plugins can inject messages, register tools, or trigger background tasks.',
  },
  {
    icon: Globe,
    color: '#16a34a',
    title: 'MCP Integrations',
    desc: 'Model Context Protocol support — connect Argos to any MCP server. Expose external tools (databases, APIs, services) to the planner via the standardized protocol.',
  },
  {
    icon: Lock,
    color: '#5b6cf8',
    title: 'WebAuthn Dashboard',
    desc: 'Local web app secured by FIDO2/YubiKey passkeys with TOTP backup. Review proposals, manage tasks, browse memories — all behind hardware authentication.',
  },
  {
    icon: Radio,
    color: '#16a34a',
    title: 'Streaming Responses',
    desc: 'Token-by-token SSE streaming from any provider. Messages edit in-place on Telegram (800ms throttle) and Slack (1s throttle). Automatic fallback if SSE not supported.',
  },
]

export default function Features() {
  const ref = useRef(null)
  const inView = useInView(ref, { once: true })

  return (
    <section
      id="features"
      className="py-24"
      style={{ borderTop: '1px solid #e2e2e2', background: '#f8f8f8' }}
    >
      <div className="max-w-7xl mx-auto px-6">
        <motion.div
          ref={ref}
          initial={{ opacity: 0, y: 20 }}
          animate={inView ? { opacity: 1, y: 0 } : {}}
          className="mb-14"
        >
          <div className="section-label mb-3">Features</div>
          <h2 className="text-3xl lg:text-4xl font-bold text-text mb-4">
            Built for real workflows
          </h2>
          <p className="text-text2 max-w-2xl leading-relaxed">
            Every feature is designed for operators who need to move fast without losing control.
            Read by default, act only on approval.
          </p>
        </motion.div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {features.map((feature, i) => {
            const Icon = feature.icon
            return (
              <motion.div
                key={feature.title}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.05 }}
                className="p-5 rounded-lg"
                style={{
                  background: '#ffffff',
                  border: '1px solid #e2e2e2',
                  boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
                }}
              >
                <div
                  className="w-8 h-8 rounded-md flex items-center justify-center mb-3"
                  style={{
                    background: `${feature.color}12`,
                    border: `1px solid ${feature.color}22`,
                  }}
                >
                  <Icon size={17} style={{ color: feature.color }} />
                </div>
                <h3 className="font-semibold text-text mb-2">{feature.title}</h3>
                <p className="text-sm leading-relaxed" style={{ color: '#555555' }}>{feature.desc}</p>
              </motion.div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
