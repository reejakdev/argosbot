import { motion } from 'framer-motion'
import { useInView } from 'framer-motion'
import { useRef } from 'react'

const categories = [
  {
    label: 'Communication',
    items: [
      { name: 'Telegram',        status: 'live' },
      { name: 'WhatsApp',        status: 'live' },
      { name: 'Email (IMAP)',    status: 'live' },
      { name: 'Email (SMTP)',    status: 'live' },
      { name: 'Discord',         status: 'live' },
      { name: 'Slack',           status: 'live' },
      { name: 'Gmail (MCP)',     status: 'live' },
      { name: 'Outlook (MCP)',   status: 'live' },
    ],
  },
  {
    label: 'Productivity & Docs',
    items: [
      { name: 'Notion',          status: 'live' },
      { name: 'Google Calendar', status: 'live' },
      { name: 'Linear',          status: 'live' },
      { name: 'GitHub',          status: 'live' },
      { name: 'File System',     status: 'live' },
      { name: 'Local Docs',      status: 'live' },
      { name: 'URLs / Web',      status: 'live' },
      { name: 'Confluence',      status: 'v2' },
      { name: 'Jira',            status: 'v2' },
    ],
  },
  {
    label: 'Knowledge & Search',
    items: [
      { name: 'Vector Search (LanceDB)', status: 'live' },
      { name: 'Full-text Search (FTS5)', status: 'live' },
      { name: 'Perplexity (web)',        status: 'live' },
      { name: 'Memory store',            status: 'live' },
      { name: 'Brave Search',            status: 'v2' },
    ],
  },
  {
    label: 'Dev & Infrastructure',
    items: [
      { name: 'Supabase',        status: 'live' },
      { name: 'Browser (Puppeteer)', status: 'live' },
      { name: 'Fetch / API call', status: 'live' },
      { name: 'Docker',          status: 'v2' },
      { name: 'Vercel',          status: 'v2' },
    ],
  },
  {
    label: 'Security & Credentials',
    items: [
      { name: '1Password',       status: 'live' },
      { name: 'WebAuthn / YubiKey', status: 'live' },
      { name: 'TOTP (2FA)',      status: 'live' },
      { name: 'Vault (v2)',      status: 'v2' },
    ],
  },
  {
    label: 'On-chain / Wallet',
    items: [
      { name: 'EVM (any chain)', status: 'live' },
      { name: 'Solana',          status: 'live' },
      { name: 'JSON-RPC',        status: 'live' },
      { name: 'ENS lookup',      status: 'v2' },
      { name: 'On-chain reads',  status: 'v2' },
    ],
  },
]

const statusStyle = {
  live: { dot: '#10b981', text: '#f0f4ff', border: 'rgba(16,185,129,0.15)' },
  v2:   { dot: '#94a3b8', text: '#94a3b8', border: 'rgba(148,163,184,0.1)' },
}

export default function Integrations() {
  const ref = useRef(null)
  const inView = useInView(ref, { once: true })

  return (
    <section
      id="integrations"
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
          <div className="section-label mb-3">Integrations</div>
          <h2 className="text-3xl lg:text-4xl font-bold text-white mb-4">
            Every tool in your context
          </h2>
          <p className="text-text2 max-w-xl leading-relaxed">
            Argos indexes your docs, connects to your tools, and gives the planner full context before proposing any action.
            Built on MCP — add any new server with one config line.
          </p>
        </motion.div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {categories.map((cat, ci) => (
            <motion.div
              key={cat.label}
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: ci * 0.07 }}
              className="p-5 rounded-lg"
              style={{
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                boxShadow: '0 4px 24px rgba(0,0,0,0.35)',
              }}
            >
              <div className="section-label mb-4" style={{ fontSize: '10px' }}>
                {cat.label}
              </div>
              <div className="flex flex-col gap-1.5">
                {cat.items.map((item) => {
                  const s = statusStyle[item.status as keyof typeof statusStyle]
                  return (
                    <div
                      key={item.name}
                      className="flex items-center justify-between px-3 py-1.5 rounded-md"
                      style={{ background: 'rgba(0,0,0,0.2)', border: `1px solid ${s.border}` }}
                    >
                      <div className="flex items-center gap-2">
                        <div
                          className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                          style={{ background: s.dot }}
                        />
                        <span className="text-sm" style={{ color: s.text }}>{item.name}</span>
                      </div>
                      {item.status !== 'live' && (
                        <span className="font-mono text-[10px] text-text2/40">{item.status}</span>
                      )}
                    </div>
                  )
                })}
              </div>
            </motion.div>
          ))}
        </div>

        <motion.div
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          transition={{ delay: 0.5 }}
          className="mt-8 p-4 text-center rounded-lg"
          style={{
            border: '1px solid rgba(79,110,255,0.12)',
            background: 'rgba(79,110,255,0.04)',
          }}
        >
          <span className="font-mono text-sm text-text2">
            + any <span style={{ color: '#7b96ff' }}>MCP server</span> · any <span style={{ color: '#7b96ff' }}>OpenAI-compatible</span> endpoint · any <span style={{ color: '#10b981' }}>local Ollama model</span>
          </span>
        </motion.div>
      </div>
    </section>
  )
}
