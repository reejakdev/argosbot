import { motion } from 'framer-motion'
import { ArrowRight, GitBranch, Shield } from 'lucide-react'

const channels = [
  { label: 'Telegram', angle: 0, color: '#00d4ff' },
  { label: 'WhatsApp', angle: 72, color: '#00ff88' },
  { label: 'Email', angle: 144, color: '#00d4ff' },
  { label: 'Discord', angle: 216, color: '#00ff88' },
  { label: 'Slack', angle: 288, color: '#ff4466' },
]

function HUDDiagram() {
  const cx = 160
  const cy = 160
  const r1 = 100
  const r2 = 65
  const r3 = 35

  return (
    <div className="relative w-80 h-80 mx-auto">
      <svg viewBox="0 0 320 320" className="w-full h-full" style={{ overflow: 'visible' }}>
        {/* Outer rotating ring */}
        <motion.circle
          cx={cx} cy={cy} r={r1}
          fill="none"
          stroke="rgba(0,212,255,0.25)"
          strokeWidth="1"
          strokeDasharray="6 4"
          animate={{ rotate: 360 }}
          transition={{ duration: 20, repeat: Infinity, ease: 'linear' }}
          style={{ transformOrigin: `${cx}px ${cy}px` }}
        />
        {/* Decorative tick marks outer */}
        {Array.from({ length: 24 }).map((_, i) => {
          const angle = (i * 15 * Math.PI) / 180
          const x1 = cx + (r1 - 5) * Math.cos(angle)
          const y1 = cy + (r1 - 5) * Math.sin(angle)
          const x2 = cx + (r1 + 3) * Math.cos(angle)
          const y2 = cy + (r1 + 3) * Math.sin(angle)
          return (
            <motion.line
              key={i}
              x1={x1} y1={y1} x2={x2} y2={y2}
              stroke="rgba(0,212,255,0.3)"
              strokeWidth={i % 6 === 0 ? 2 : 1}
              animate={{ rotate: 360 }}
              transition={{ duration: 20, repeat: Infinity, ease: 'linear' }}
              style={{ transformOrigin: `${cx}px ${cy}px` }}
            />
          )
        })}

        {/* Middle counter-rotating ring */}
        <motion.circle
          cx={cx} cy={cy} r={r2}
          fill="none"
          stroke="rgba(0,255,136,0.2)"
          strokeWidth="1"
          strokeDasharray="4 6"
          animate={{ rotate: -360 }}
          transition={{ duration: 14, repeat: Infinity, ease: 'linear' }}
          style={{ transformOrigin: `${cx}px ${cy}px` }}
        />

        {/* Inner ring */}
        <circle
          cx={cx} cy={cy} r={r3}
          fill="rgba(0,212,255,0.04)"
          stroke="rgba(0,212,255,0.35)"
          strokeWidth="1.5"
        />

        {/* Center dot */}
        <circle cx={cx} cy={cy} r={5} fill="#00d4ff" style={{ filter: 'drop-shadow(0 0 6px #00d4ff)' }} />
        <motion.circle
          cx={cx} cy={cy} r={10}
          fill="none"
          stroke="rgba(0,212,255,0.4)"
          strokeWidth="1"
          animate={{ r: [10, 18, 10], opacity: [0.6, 0, 0.6] }}
          transition={{ duration: 2.5, repeat: Infinity }}
        />

        {/* Center label */}
        <text x={cx} y={cy + 3} textAnchor="middle" fill="#00d4ff" fontSize="8" fontFamily="Courier New" letterSpacing="2">
          ARGOS
        </text>

        {/* Channel nodes */}
        {channels.map((ch, i) => {
          const rad = (ch.angle * Math.PI) / 180
          const nx = cx + r1 * Math.cos(rad)
          const ny = cy + r1 * Math.sin(rad)
          const lx = cx + (r1 + 30) * Math.cos(rad)
          const ly = cy + (r1 + 30) * Math.sin(rad)

          return (
            <g key={i}>
              {/* Line from center to node */}
              <line
                x1={cx} y1={cy} x2={nx} y2={ny}
                stroke={ch.color}
                strokeWidth="0.5"
                strokeOpacity="0.3"
              />
              {/* Node circle */}
              <motion.circle
                cx={nx} cy={ny} r={7}
                fill={`${ch.color}22`}
                stroke={ch.color}
                strokeWidth="1.5"
                animate={{ opacity: [1, 0.5, 1] }}
                transition={{ duration: 1.5 + i * 0.3, repeat: Infinity }}
                style={{ filter: `drop-shadow(0 0 4px ${ch.color})` }}
              />
              {/* Label */}
              <text
                x={lx}
                y={ly + 4}
                textAnchor={rad > Math.PI / 2 && rad < (3 * Math.PI) / 2 ? 'end' : 'start'}
                fill={ch.color}
                fontSize="7"
                fontFamily="Courier New"
                opacity="0.8"
              >
                {ch.label}
              </text>
            </g>
          )
        })}

        {/* Sweep line */}
        <motion.line
          x1={cx} y1={cy}
          x2={cx} y2={cy - r1}
          stroke="rgba(0,212,255,0.5)"
          strokeWidth="1"
          animate={{ rotate: 360 }}
          transition={{ duration: 4, repeat: Infinity, ease: 'linear' }}
          style={{ transformOrigin: `${cx}px ${cy}px` }}
        />
      </svg>

      {/* Glow overlay */}
      <div
        className="absolute inset-0 rounded-full pointer-events-none"
        style={{
          background: 'radial-gradient(circle at center, rgba(0,212,255,0.06) 0%, transparent 70%)',
        }}
      />
    </div>
  )
}

export default function Hero() {
  return (
    <section
      className="relative min-h-screen flex items-center pt-16 overflow-hidden"
      style={{
        background: 'radial-gradient(ellipse at 70% 50%, rgba(0,212,255,0.05) 0%, transparent 60%)',
      }}
    >
      {/* Corner decorations */}
      <div className="absolute top-20 left-6 text-text2/20 font-mono text-xs leading-loose">
        {['SYS.INIT', 'AUTH.OK', 'PIPELINE.READY', 'PRIVACY.ON'].map((t, i) => (
          <motion.div
            key={t}
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.5 + i * 0.15 }}
          >
            &gt; {t}
          </motion.div>
        ))}
      </div>

      <div className="absolute top-20 right-6 text-text2/20 font-mono text-xs leading-loose text-right">
        {['v1.0.0', 'MIT', 'LOCAL-FIRST', 'OPEN-SOURCE'].map((t, i) => (
          <motion.div
            key={t}
            initial={{ opacity: 0, x: 10 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.5 + i * 0.15 }}
          >
            {t}
          </motion.div>
        ))}
      </div>

      <div className="max-w-7xl mx-auto px-6 grid lg:grid-cols-2 gap-12 items-center w-full py-20">
        {/* Left: Text content */}
        <div>
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
            className="flex items-center gap-3 mb-6"
          >
            <div className="flex items-center gap-2 px-3 py-1.5 border border-green/30 bg-green/5 rounded-sm">
              <div className="w-1.5 h-1.5 rounded-full bg-green animate-pulse" />
              <span className="font-mono text-xs text-green tracking-widest">SYSTEM ONLINE</span>
            </div>
            <div className="flex items-center gap-2 px-3 py-1.5 border border-cyan/20 bg-cyan/5 rounded-sm">
              <Shield size={11} className="text-cyan" />
              <span className="font-mono text-xs text-cyan tracking-widest">PRIVACY-FIRST</span>
            </div>
          </motion.div>

          <motion.h1
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3, duration: 0.7 }}
            className="text-4xl lg:text-5xl xl:text-6xl font-bold leading-tight mb-6 text-white"
          >
            Your messages.{' '}
            <span className="glow-cyan text-cyan">Monitored.</span>
            <br />
            Your actions.{' '}
            <span className="glow-green text-green">Approved by you.</span>
          </motion.h1>

          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.5 }}
            className="text-text2 text-lg leading-relaxed mb-8 max-w-lg"
          >
            Argos is a local-first AI assistant that watches your Telegram, WhatsApp, Email, Discord,
            and Slack — classifies every message, drafts responses, and{' '}
            <span className="text-text">never acts without your explicit approval.</span>
          </motion.p>

          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.6 }}
            className="text-text2/70 text-sm font-mono mb-8 border-l-2 border-cyan/30 pl-4"
          >
            All PII anonymized before any LLM sees it. Cloud models only see{' '}
            <span className="text-cyan">[PERSON_1]</span>,{' '}
            <span className="text-green">[AMOUNT_1]</span>,{' '}
            <span className="text-cyan">[ADDR_1]</span>. Never the real thing.
          </motion.p>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.7 }}
            className="flex flex-wrap gap-4"
          >
            <a
              href="#setup"
              className="flex items-center gap-2 px-6 py-3 text-bg font-semibold text-sm rounded-sm transition-all duration-200 hover:scale-105"
              style={{
                background: 'linear-gradient(135deg, #00d4ff, #00ff88)',
                boxShadow: '0 0 20px rgba(0,212,255,0.3)',
              }}
            >
              Get Started
              <ArrowRight size={16} />
            </a>
            <a
              href="https://github.com/reejakdev/argosbot"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 px-6 py-3 border border-[rgba(0,212,255,0.3)] text-cyan text-sm font-mono rounded-sm hover:bg-cyan/10 hover:border-cyan/60 transition-all duration-200"
            >
              <GitBranch size={15} />
              View on GitHub
            </a>
          </motion.div>

          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 1 }}
            className="flex items-center gap-6 mt-10"
          >
            {[
              { val: '5', label: 'Channels' },
              { val: '15+', label: 'LLM Providers' },
              { val: '100%', label: 'Local-first' },
              { val: 'MIT', label: 'License' },
            ].map((stat) => (
              <div key={stat.label} className="text-center">
                <div className="text-xl font-bold text-cyan font-mono">{stat.val}</div>
                <div className="text-text2 text-xs mt-0.5">{stat.label}</div>
              </div>
            ))}
          </motion.div>
        </div>

        {/* Right: HUD Diagram */}
        <motion.div
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.4, duration: 0.8, ease: 'easeOut' }}
          className="flex justify-center items-center"
        >
          <HUDDiagram />
        </motion.div>
      </div>

      {/* Bottom gradient fade */}
      <div
        className="absolute bottom-0 left-0 right-0 h-32 pointer-events-none"
        style={{ background: 'linear-gradient(transparent, rgba(4,5,13,0.8))' }}
      />
    </section>
  )
}
