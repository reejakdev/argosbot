import { motion } from 'framer-motion'
import { ArrowRight, GitBranch, Shield } from 'lucide-react'

const channels = [
  { label: 'Telegram', angle: -90,  color: '#4f6eff' },
  { label: 'WhatsApp', angle: -18,  color: '#7b96ff' },
  { label: 'Email',    angle:  54,  color: '#4f6eff' },
  { label: 'Discord',  angle: 126,  color: '#7b96ff' },
  { label: 'Slack',    angle: 198,  color: '#4f6eff' },
]

function HUDDiagram() {
  const size = 320
  const cx   = size / 2
  const cy   = size / 2
  const r1   = 108
  const r2   = 70
  const r3   = 38

  return (
    <div className="relative mx-auto" style={{ width: size, height: size }}>
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
            stroke="rgba(79,110,255,0.2)"
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
                  stroke="rgba(79,110,255,0.22)"
                  strokeWidth={isMajor ? 1.5 : 0.8}
                />
              )
            })}
          </motion.g>

          {/* Middle ring — counter-rotates */}
          <motion.circle
            cx={0} cy={0} r={r2}
            fill="none"
            stroke="rgba(123,150,255,0.15)"
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
            stroke="rgba(79,110,255,0.35)"
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
            const labelR = r1 + 26
            const lx     = labelR * Math.cos(rad)
            const ly     = labelR * Math.sin(rad)

            return (
              <g key={i}>
                <line
                  x1={0} y1={0} x2={nx} y2={ny}
                  stroke={ch.color}
                  strokeWidth="0.6"
                  strokeOpacity="0.2"
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
                  fill={ch.color}
                  fontSize="9"
                  fontFamily="JetBrains Mono, Courier New"
                  opacity="0.8"
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
          background: 'radial-gradient(circle at center, rgba(79,110,255,0.07) 0%, transparent 65%)',
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
        background: 'radial-gradient(ellipse at 70% 50%, rgba(79,110,255,0.06) 0%, transparent 60%)',
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
                border: '1px solid rgba(16,185,129,0.3)',
                background: 'rgba(16,185,129,0.06)',
              }}
            >
              <div className="w-1.5 h-1.5 rounded-full bg-green animate-pulse" />
              <span className="text-xs font-semibold text-green">System Online</span>
            </div>
            <div
              className="flex items-center gap-2 px-3 py-1.5 rounded-full"
              style={{
                border: '1px solid rgba(79,110,255,0.25)',
                background: 'rgba(79,110,255,0.06)',
              }}
            >
              <Shield size={11} style={{ color: '#7b96ff' }} />
              <span className="text-xs font-semibold" style={{ color: '#7b96ff' }}>Privacy-First</span>
            </div>
          </motion.div>

          <motion.h1
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3, duration: 0.7 }}
            className="text-4xl lg:text-5xl xl:text-6xl font-bold leading-tight mb-6"
          >
            Your messages.{' '}
            <span className="gradient-text">Monitored.</span>
            <br />
            Your actions.{' '}
            <span style={{ color: '#10b981' }}>Approved by you.</span>
          </motion.h1>

          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.5 }}
            className="text-text2 text-lg leading-relaxed mb-6 max-w-lg"
          >
            Argos watches your Telegram, WhatsApp, Email, Discord, and Slack —
            classifies every message, drafts responses, and{' '}
            <span className="text-text font-medium">never acts without your explicit approval.</span>
          </motion.p>

          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.6 }}
            className="text-sm mb-8 leading-relaxed"
            style={{
              color: 'rgba(148,163,184,0.75)',
              borderLeft: '2px solid rgba(79,110,255,0.3)',
              paddingLeft: '1rem',
              fontFamily: 'JetBrains Mono, Courier New, monospace',
            }}
          >
            All PII anonymized before any LLM sees it. Cloud models only see{' '}
            <span style={{ color: '#7b96ff' }}>[PERSON_1]</span>,{' '}
            <span style={{ color: '#7b96ff' }}>[AMOUNT_1]</span>,{' '}
            <span style={{ color: '#7b96ff' }}>[ADDR_1]</span>.{' '}
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
                boxShadow: '0 4px 20px rgba(79,110,255,0.3)',
              }}
              onMouseEnter={e => {
                (e.currentTarget as HTMLElement).style.background = '#6279ff'
                ;(e.currentTarget as HTMLElement).style.boxShadow = '0 6px 28px rgba(79,110,255,0.45)'
              }}
              onMouseLeave={e => {
                (e.currentTarget as HTMLElement).style.background = '#4f6eff'
                ;(e.currentTarget as HTMLElement).style.boxShadow = '0 4px 20px rgba(79,110,255,0.3)'
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
                border: '1px solid rgba(79,110,255,0.25)',
                color: '#7b96ff',
                background: 'rgba(79,110,255,0.06)',
              }}
              onMouseEnter={e => {
                (e.currentTarget as HTMLElement).style.background = 'rgba(79,110,255,0.12)'
                ;(e.currentTarget as HTMLElement).style.borderColor = 'rgba(79,110,255,0.45)'
              }}
              onMouseLeave={e => {
                (e.currentTarget as HTMLElement).style.background = 'rgba(79,110,255,0.06)'
                ;(e.currentTarget as HTMLElement).style.borderColor = 'rgba(79,110,255,0.25)'
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
            style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}
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
                  style={{ color: stat.highlight ? '#10b981' : '#7b96ff' }}
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
        style={{ background: 'linear-gradient(transparent, rgba(6,11,31,0.9))' }}
      />
    </section>
  )
}
