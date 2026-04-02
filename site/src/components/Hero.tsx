import { motion } from 'framer-motion'
import { ArrowRight, GitBranch, Shield } from 'lucide-react'

// 8 nodes × 45° = 121px arc gap at labelR=155 — no overlap possible
const channels = [
  { label: 'Telegram',  angle:   0,  color: '#4f6eff' },
  { label: 'WhatsApp',  angle:  45,  color: '#059669' },
  { label: 'Discord',   angle:  90,  color: '#6366f1' },
  { label: 'Slack',     angle: 135,  color: '#d97706' },
  { label: 'Email',     angle: 180,  color: '#059669' },
  { label: 'GitHub',    angle: 225,  color: '#3a56e8' },
  { label: 'Notion',    angle: 270,  color: '#3a56e8' },
  { label: '+ any MCP', angle: 315,  color: '#9ca3af' },
]

function HUDDiagram() {
  const size = 380
  const cx   = size / 2
  const cy   = size / 2
  const r1   = 118
  const r2   = 76
  const r3   = 40

  return (
    <div className="relative mx-auto" style={{ width: size, height: size, overflow: 'visible' }}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        style={{ overflow: 'visible' }}
      >
        <g transform={`translate(${cx} ${cy})`}>

          {/* Outer dashed ring — rotates CW */}
          <motion.circle
            cx={0} cy={0} r={r1}
            fill="none"
            stroke="rgba(79,110,255,0.25)"
            strokeWidth="1"
            strokeDasharray="5 4"
            animate={{ rotate: 360 }}
            transition={{ duration: 24, repeat: Infinity, ease: 'linear' }}
            style={{ transformOrigin: '0px 0px' }}
          />

          {/* Outer tick marks */}
          <motion.g
            animate={{ rotate: 360 }}
            transition={{ duration: 24, repeat: Infinity, ease: 'linear' }}
            style={{ transformOrigin: '0px 0px' }}
          >
            {Array.from({ length: 36 }).map((_, i) => {
              const a = (i * 10 * Math.PI) / 180
              const isMajor = i % 9 === 0
              const inner = r1 - (isMajor ? 7 : 4)
              const outer = r1 + (isMajor ? 4 : 2)
              return (
                <line
                  key={i}
                  x1={inner * Math.cos(a)} y1={inner * Math.sin(a)}
                  x2={outer * Math.cos(a)} y2={outer * Math.sin(a)}
                  stroke="rgba(79,110,255,0.3)"
                  strokeWidth={isMajor ? 1.5 : 0.8}
                />
              )
            })}
          </motion.g>

          {/* Middle ring — counter-rotates */}
          <motion.circle
            cx={0} cy={0} r={r2}
            fill="none"
            stroke="rgba(79,110,255,0.2)"
            strokeWidth="1"
            strokeDasharray="3 7"
            animate={{ rotate: -360 }}
            transition={{ duration: 16, repeat: Infinity, ease: 'linear' }}
            style={{ transformOrigin: '0px 0px' }}
          />

          {/* Inner static ring */}
          <circle
            cx={0} cy={0} r={r3}
            fill="rgba(79,110,255,0.04)"
            stroke="rgba(79,110,255,0.4)"
            strokeWidth="1.5"
          />

          {/* Center dot */}
          <circle cx={0} cy={0} r={5} fill="#4f6eff" />
          {/* Pulse ring */}
          <motion.circle
            cx={0} cy={0} r={10}
            fill="none"
            stroke="rgba(79,110,255,0.4)"
            strokeWidth="1"
            animate={{ r: [10, 22, 10], opacity: [0.7, 0, 0.7] }}
            transition={{ duration: 2.5, repeat: Infinity }}
          />

          {/* Channel nodes */}
          {channels.map((ch, i) => {
            const rad    = (ch.angle * Math.PI) / 180
            const nx     = r1 * Math.cos(rad)
            const ny     = r1 * Math.sin(rad)
            const labelR = r1 + 37
            const lx     = labelR * Math.cos(rad)
            const ly     = labelR * Math.sin(rad)

            return (
              <g key={i}>
                <line
                  x1={0} y1={0} x2={nx} y2={ny}
                  stroke={ch.color}
                  strokeWidth="0.6"
                  strokeOpacity="0.25"
                  strokeDasharray="3 3"
                />
                <motion.circle
                  cx={nx} cy={ny} r={7}
                  fill={`${ch.color}18`}
                  stroke={ch.color}
                  strokeWidth="1.5"
                  animate={{ opacity: [1, 0.5, 1] }}
                  transition={{ duration: 1.6 + i * 0.35, repeat: Infinity }}
                />
                <text
                  x={lx}
                  y={ly + 4}
                  textAnchor="middle"
                  fill="#374151"
                  fontSize="9"
                  fontFamily="JetBrains Mono, Courier New"
                  opacity="1"
                  style={{ userSelect: 'none' }}
                >
                  {ch.label}
                </text>
              </g>
            )
          })}

        </g>
      </svg>

      {/* Radial glow */}
      <div
        className="absolute inset-0 rounded-full pointer-events-none"
        style={{
          background: 'transparent',
        }}
      />
    </div>
  )
}

export default function Hero() {
  return (
    <section
      id="hero"
      className="relative min-h-screen flex items-center pt-16 overflow-hidden"
      style={{
        background: 'transparent',
      }}
    >
      <div className="max-w-7xl mx-auto px-6 grid lg:grid-cols-2 gap-16 items-center w-full py-20">

        {/* Left: copy */}
        <div>
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
            className="flex items-center gap-3 mb-6"
          >
            <div
              className="flex items-center gap-2 px-3 py-1.5 rounded-full"
              style={{
                border: '1px solid rgba(5,150,105,0.3)',
                background: 'rgba(5,150,105,0.06)',
              }}
            >
              <div className="w-1.5 h-1.5 rounded-full bg-green animate-pulse" />
              <span className="text-xs font-semibold text-green">System Online</span>
            </div>
            <div
              className="flex items-center gap-2 px-3 py-1.5 rounded-full"
              style={{
                border: '1px solid rgba(79,110,255,0.25)',
                background: 'rgba(79,110,255,0.05)',
              }}
            >
              <Shield size={11} style={{ color: '#4f6eff' }} />
              <span className="text-xs font-semibold" style={{ color: '#4f6eff' }}>Privacy-First</span>
            </div>
          </motion.div>

          <motion.h1
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3, duration: 0.7 }}
            className="text-4xl lg:text-5xl xl:text-6xl font-bold leading-tight mb-6"
            style={{ color: '#0f1117' }}
          >
            Your messages.{' '}
            <span className="gradient-text">Monitored.</span>
            <br />
            Your actions.{' '}
            <span style={{ color: '#059669' }}>Approved by you.</span>
          </motion.h1>

          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.5 }}
            className="text-text2 text-lg leading-relaxed mb-6 max-w-lg"
          >
            Argos watches your Telegram, WhatsApp, Email, Discord, and Slack —
            classifies every message, drafts responses, and{' '}
            <span className="font-medium" style={{ color: '#374151' }}>never acts without your explicit approval.</span>
          </motion.p>

          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.6 }}
            className="text-sm mb-8 leading-relaxed"
            style={{
              color: '#6b7280',
              borderLeft: '2px solid rgba(79,110,255,0.3)',
              paddingLeft: '1rem',
              fontFamily: 'JetBrains Mono, Courier New, monospace',
            }}
          >
            All PII anonymized before any LLM sees it. Cloud models only see{' '}
            <span style={{ color: '#4f6eff' }}>[PERSON_1]</span>,{' '}
            <span style={{ color: '#4f6eff' }}>[AMOUNT_1]</span>,{' '}
            <span style={{ color: '#4f6eff' }}>[ADDR_1]</span>.{' '}
            <span className="text-text2">Never the real thing.</span>
          </motion.p>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.7 }}
            className="flex flex-wrap gap-4"
          >
            <a
              href="#setup"
              className="flex items-center gap-2 px-6 py-3 font-semibold text-sm rounded-md transition-all duration-200"
              style={{
                background: '#4f6eff',
                color: '#fff',
                boxShadow: '0 4px 16px rgba(79,110,255,0.25)',
              }}
              onMouseEnter={e => {
                (e.currentTarget as HTMLElement).style.background = '#3a56e8'
                ;(e.currentTarget as HTMLElement).style.boxShadow = '0 6px 24px rgba(79,110,255,0.35)'
              }}
              onMouseLeave={e => {
                (e.currentTarget as HTMLElement).style.background = '#4f6eff'
                ;(e.currentTarget as HTMLElement).style.boxShadow = '0 4px 16px rgba(79,110,255,0.25)'
              }}
            >
              Get Started <ArrowRight size={15} />
            </a>
            <a
              href="https://github.com/reejakdev/argosbot"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 px-6 py-3 text-sm font-medium rounded-md transition-all duration-200"
              style={{
                border: '1px solid rgba(79,110,255,0.3)',
                color: '#4f6eff',
                background: '#ffffff',
              }}
              onMouseEnter={e => {
                (e.currentTarget as HTMLElement).style.background = 'rgba(79,110,255,0.05)'
                ;(e.currentTarget as HTMLElement).style.borderColor = 'rgba(79,110,255,0.5)'
              }}
              onMouseLeave={e => {
                (e.currentTarget as HTMLElement).style.background = '#ffffff'
                ;(e.currentTarget as HTMLElement).style.borderColor = 'rgba(79,110,255,0.3)'
              }}
            >
              <GitBranch size={15} /> View on GitHub
            </a>
          </motion.div>

          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 1 }}
            className="flex items-center gap-8 mt-10 pt-8"
            style={{ borderTop: '1px solid rgba(0,0,0,0.08)' }}
          >
            {[
              { val: '5',    label: 'Channels' },
              { val: '15+',  label: 'LLM Providers' },
              { val: '0',    label: 'Actions without approval', highlight: true },
              { val: 'MIT',  label: 'License' },
            ].map((stat) => (
              <div key={stat.label}>
                <div
                  className="text-2xl font-bold font-mono"
                  style={{ color: stat.highlight ? '#059669' : '#4f6eff' }}
                >
                  {stat.val}
                </div>
                <div className="text-text2 text-xs mt-0.5 leading-tight max-w-[80px]">{stat.label}</div>
              </div>
            ))}
          </motion.div>
        </div>

        {/* Right: HUD diagram */}
        <motion.div
          initial={{ opacity: 0, scale: 0.85 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.4, duration: 0.9, ease: 'easeOut' }}
          className="flex justify-center items-center"
        >
          <HUDDiagram />
        </motion.div>

      </div>

      {/* Bottom fade */}
      <div
        className="absolute bottom-0 left-0 right-0 h-32 pointer-events-none"
        style={{ background: 'linear-gradient(transparent, rgba(250,249,247,0.9))' }}
      />
    </section>
  )
}
