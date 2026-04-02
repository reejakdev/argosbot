import { motion } from 'framer-motion'
import { useInView } from 'framer-motion'
import { useRef } from 'react'
import { MessageCircle, Phone, Mail, Hash, MessagesSquare } from 'lucide-react'
import { Badge } from './ui/Badge'

const channels = [
  {
    icon: MessageCircle,
    color: '#4f6eff',
    name: 'Telegram',
    proto: 'MTProto + Bot API',
    desc: 'Full MTProto user client via gramjs — reads your actual Telegram as if you were logged in. Alternative bot mode for group/channel monitoring.',
    features: ['MTProto user client', 'Bot mode alternative', 'Group & channel support', 'Media metadata'],
    status: 'production',
  },
  {
    icon: Phone,
    color: '#059669',
    name: 'WhatsApp',
    proto: 'Baileys (multi-device)',
    desc: 'Multi-device WhatsApp via Baileys — no WhatsApp Business API needed. Connects as your personal account with full QR pairing.',
    features: ['Personal + Business', 'QR code pairing', 'Group monitoring', 'Multi-device protocol'],
    status: 'production',
  },
  {
    icon: Mail,
    color: '#4f6eff',
    name: 'Email',
    proto: 'IMAP + SMTP',
    desc: 'Standard IMAP polling with IDLE support for near-real-time delivery. Works with Gmail, Outlook, FastMail, Proton Bridge, and any IMAP server.',
    features: ['IMAP IDLE support', 'SMTP sending', 'TLS/STARTTLS', 'Any provider'],
    status: 'production',
  },
  {
    icon: Hash,
    color: '#059669',
    name: 'Discord',
    proto: 'Discord Bot API',
    desc: 'Discord bot integration for server and DM monitoring. Requires bot token with message intent. Ideal for team server awareness.',
    features: ['Server channels', 'DM monitoring', 'Bot API', 'Thread support'],
    status: 'v2',
  },
  {
    icon: MessagesSquare,
    color: '#dc2626',
    name: 'Slack',
    proto: 'Slack Bot API',
    desc: 'Slack workspace monitoring via bot token. Subscribe to channels, DMs, and app mentions. Works with Slack Free and Pro workspaces.',
    features: ['Channel monitoring', 'App mentions', 'DM inbox', 'Workspace events'],
    status: 'v2',
  },
]

export default function Channels() {
  const ref = useRef(null)
  const inView = useInView(ref, { once: true })

  return (
    <section
      id="channels"
      className="py-24"
      style={{
        borderTop: '1px solid #e5e7eb',
        background: '#f5f5f5',
      }}
    >
      <div className="max-w-7xl mx-auto px-6">
        <motion.div
          ref={ref}
          initial={{ opacity: 0, y: 20 }}
          animate={inView ? { opacity: 1, y: 0 } : {}}
          className="mb-14"
        >
          <div className="section-label mb-3">Channels</div>
          <h2 className="text-3xl lg:text-4xl font-bold mb-4" style={{ color: '#111827' }}>
            5 channels.{' '}
            <span className="gradient-text">One unified inbox.</span>
          </h2>
          <p className="text-text2 max-w-2xl leading-relaxed">
            Argos ingests messages from every platform you use. Each channel is isolated — one failure
            never crashes the others. The pipeline handles deduplication automatically.
          </p>
        </motion.div>

        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-5">
          {channels.map((ch, i) => {
            const Icon = ch.icon
            return (
              <motion.div
                key={ch.name}
                initial={{ opacity: 0, y: 30 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.1, duration: 0.5 }}
                whileHover={{ y: -4 }}
                className="p-5 rounded-lg group cursor-default transition-all duration-200"
                style={{
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                  boxShadow: '0 1px 4px #e5e7eb, 0 4px 16px rgba(0,0,0,0.04)',
                }}
              >
                {/* Header */}
                <div className="flex items-center gap-3 mb-4">
                  <div
                    className="w-10 h-10 rounded-lg flex items-center justify-center"
                    style={{
                      background: `${ch.color}10`,
                      border: `1px solid ${ch.color}25`,
                    }}
                  >
                    <Icon size={18} style={{ color: ch.color }} />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold" style={{ color: '#111827' }}>{ch.name}</span>
                      <Badge
                        label={ch.status === 'production' ? 'live' : ch.status}
                        variant={ch.status === 'production' ? 'local' : 'default'}
                      />
                    </div>
                    <div className="text-xs text-text2 font-mono mt-0.5">{ch.proto}</div>
                  </div>
                </div>

                <p className="text-text2 text-sm leading-relaxed mb-4">{ch.desc}</p>

                {/* Features */}
                <div className="space-y-1.5">
                  {ch.features.map((f) => (
                    <div key={f} className="flex items-center gap-2 text-xs text-text2">
                      <div
                        className="w-1 h-1 rounded-full flex-shrink-0"
                        style={{ background: ch.color }}
                      />
                      {f}
                    </div>
                  ))}
                </div>
              </motion.div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
