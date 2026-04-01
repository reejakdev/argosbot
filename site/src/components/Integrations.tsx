import { motion } from 'framer-motion'
import { useInView } from 'framer-motion'
import { useRef } from 'react'

const integrations = [
  { name: 'Notion', color: '#00d4ff', status: 'live' },
  { name: 'Google Calendar', color: '#00ff88', status: 'live' },
  { name: 'Gmail', color: '#00d4ff', status: 'live' },
  { name: 'Outlook', color: '#00d4ff', status: 'live' },
  { name: '1Password', color: '#00ff88', status: 'live' },
  { name: 'Browser Fetch', color: '#00d4ff', status: 'live' },
  { name: 'Linear', color: '#6a80a8', status: 'v2' },
  { name: 'Supabase', color: '#6a80a8', status: 'v2' },
  { name: 'Slack', color: '#6a80a8', status: 'v2' },
  { name: 'SMTP', color: '#00ff88', status: 'live' },
  { name: 'Perplexity', color: '#00d4ff', status: 'live' },
  { name: 'File System', color: '#00ff88', status: 'live' },
  { name: 'GitHub', color: '#6a80a8', status: 'v2' },
  { name: 'Fordefi', color: '#6a80a8', status: 'v2' },
  { name: 'LanceDB', color: '#00ff88', status: 'live' },
  { name: 'MCP Servers', color: '#00d4ff', status: 'live' },
]

export default function Integrations() {
  const ref = useRef(null)
  const inView = useInView(ref, { once: true })

  return (
    <section className="py-24 border-t border-[rgba(0,212,255,0.08)]">
      <div className="max-w-7xl mx-auto px-6">
        <motion.div
          ref={ref}
          initial={{ opacity: 0, y: 20 }}
          animate={inView ? { opacity: 1, y: 0 } : {}}
          className="mb-14 text-center"
        >
          <div className="section-label mb-3 text-center">// INTEGRATIONS</div>
          <h2 className="text-3xl lg:text-4xl font-bold text-white mb-4">
            Connects to your{' '}
            <span className="gradient-text">entire stack</span>
          </h2>
          <p className="text-text2 max-w-xl mx-auto leading-relaxed">
            Workers, knowledge connectors, and skill tools plug into Argos's registry.
            New integrations are a TypeScript file away.
          </p>
        </motion.div>

        <div className="flex flex-wrap gap-3 justify-center max-w-4xl mx-auto">
          {integrations.map((integration, i) => (
            <motion.div
              key={integration.name}
              initial={{ opacity: 0, scale: 0.8 }}
              whileInView={{ opacity: 1, scale: 1 }}
              viewport={{ once: true }}
              transition={{ delay: i * 0.05, duration: 0.3 }}
              whileHover={{ scale: 1.05, y: -2 }}
              className="flex items-center gap-2 px-4 py-2 hud-card rounded-sm cursor-default"
              style={{ borderColor: `${integration.color}25` }}
            >
              <div
                className="w-1.5 h-1.5 rounded-full"
                style={{
                  background: integration.color,
                  boxShadow: `0 0 6px ${integration.color}`,
                  opacity: integration.status === 'live' ? 1 : 0.4,
                }}
              />
              <span
                className="text-sm font-medium"
                style={{ color: integration.status === 'live' ? '#c8d8f0' : '#6a80a8' }}
              >
                {integration.name}
              </span>
              {integration.status !== 'live' && (
                <span className="text-xs font-mono text-text2/50 ml-1">{integration.status}</span>
              )}
            </motion.div>
          ))}
        </div>

        <motion.p
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          transition={{ delay: 0.6 }}
          className="text-center text-text2 text-sm mt-8 font-mono"
        >
          + any OpenAI-compatible endpoint + any MCP server
        </motion.p>
      </div>
    </section>
  )
}
