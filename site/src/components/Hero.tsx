import { motion } from 'framer-motion'
import { ArrowRight, GitBranch, Shield } from 'lucide-react'

const channels = [
  { label: 'Telegram', angle: -90, color: '#00d4ff' },
  { label: 'WhatsApp', angle: -18, color: '#00ff88' },
  { label: 'Email',    angle:  54, color: '#00d4ff' },
  { label: 'Discord',  angle: 126, color: '#00ff88' },
  { label: 'Slack',    angle: 198, color: '#00d4ff' },
]

function HUDDiagram() {
  const size  = 320
  const cx    = size / 2  // 160
  const cy    = size / 2  // 160
  const r1    = 108       // outer ring (channel nodes)
  const r2    = 70        // middle ring
  const r3    = 38        // inner ring

  return (
    <div className="relative mx-auto" style={{ width: size, height: size }}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        style={{ overflow: 'visible' }}
      >
        {/* ── All rotating elements anchored at center via <g translate> ── */}
        <g transform={`translate(${cx} ${cy})`}>

          {/* Outer dashed ring — rotates CW */}
          <motion.circle
            cx={0} cy={0} r={r1}
            fill="none"
            stroke="rgba(0,212,255,0.2)"
            strokeWidth="1"
            strokeDasharray="5 4"
            animate={{ rotate: 360 }}
            transition={{ duration: 24, repeat: Infinity, ease: 'linear' }}
            style={{ transformOrigin: '0px 0px' }}
          />

          {/* Outer tick marks — rotate with outer ring */}
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
                  stroke="rgba(0,212,255,0.25)"
                  strokeWidth={isMajor ? 1.5 : 0.8}
                />
              )
            })}
          </motion.g>

          {/* Middle ring — counter-rotates */}
          <motion.circle
            cx={0} cy={0} r={r2}
            fill="none"
            stroke="rgba(0,255,136,0.18)"
            strokeWidth="1"
            strokeDasharray="3 7"
            animate={{ rotate: -360 }}
            transition={{ duration: 16, repeat: Infinity, ease: 'linear' }}
            style={{ transformOrigin: '0px 0px' }}
          />

          {/* Inner static ring */}
          <circle
            cx={0} cy={0} r={r3}
            fill="rgba(0,212,255,0.04)"
            stroke="rgba(0,212,255,0.4)"
            strokeWidth="1.5"
          />

          {/* ── SWEEP LINE — now perfectly centered ── */}
          <motion.g
            animate={{ rotate: 360 }}
            transition={{ duration: 4, repeat: Infinity, ease: 'linear' }}
            style={{ transformOrigin: '0px 0px' }}
          >
            {/* Gradient sweep sector */}
            <defs>
              <radialGradient id="sweep-grad" cx="0%" cy="0%" r="100%">
                <stop offset="0%" stopColor="#00d4ff" stopOpacity="0.6" />
                <stop offset="100%" stopColor="#00d4ff" stopOpacity="0" />
              </radialGradient>
            </defs>
            {/* Sweep line */}
            <line
              x1={0} y1={0} x2={0} y2={-r1}
              stroke="rgba(0,212,255,0.7)"
              strokeWidth="1.5"
            />
            {/* Trailing glow arc */}
            <path
              d={`M 0 0 L ${r1 * Math.sin(-0.5)} ${-r1 * Math.cos(-0.5)} A ${r1} ${r1} 0 0 1 0 ${-r1} Z`}
              fill="rgba(0,212,255,0.07)"
            />
          </motion.g>

          {/* ── Center ── */}
          <circle cx={0} cy={0} r={5} fill="#00d4ff" style={{ filter: 'drop-shadow(0 0 6px #00d4ff)' }} />
          {/* Pulse ring */}
          <motion.circle
            cx={0} cy={0} r={10}
            fill="none"
            stroke="rgba(0,212,255,0.45)"
            strokeWidth="1"
            animate={{ r: [10, 22, 10], opacity: [0.7, 0, 0.7] }}
            transition={{ duration: 2.5, repeat: Infinity }}
          />

          {/* ── Channel nodes ── */}
          {channels.map((ch, i) => {
            const rad = (ch.angle * Math.PI) / 180
            const nx  = r1 * Math.cos(rad)
            const ny  = r1 * Math.sin(rad)
            // Label offset — push outward
            const labelR = r1 + 26
            const lx = labelR * Math.cos(rad)
            const ly = labelR * Math.sin(rad)

            return (
              <g key={i}>
                {/* Spoke from center */}
                <line
                  x1={0} y1={0} x2={nx} y2={ny}
                  stroke={ch.color}
                  strokeWidth="0.6"
                  strokeOpacity="0.25"
                  strokeDasharray="3 3"
                />
                {/* Node */}
                <motion.circle
                  cx={nx} cy={ny} r={7}
                  fill={`${ch.color}18`}
                  stroke={ch.color}
                  strokeWidth="1.5"
                  animate={{ opacity: [1, 0.5, 1] }}
                  transition={{ duration: 1.6 + i * 0.35, repeat: Infinity }}
                  style={{ filter: `drop-shadow(0 0 5px ${ch.color})` }}
                />
                {/* Label */}
                <text
                  x={lx}
                  y={ly + 4}
                  textAnchor="middle"
                  fill={ch.color}
                  fontSize="9"
                  fontFamily="Courier New"
                  opacity="0.85"
                  style={{ userSelect: 'none' }}
                >
                  {ch.label}
                </text>
              </g>
            )
          })}

        </g>{/* end translate group */}
      </svg>

      {/* Radial glow behind */}
      <div
        className="absolute inset-0 rounded-full pointer-events-none"
        style={{
          background: 'radial-gradient(circle at center, rgba(0,212,255,0.08) 0%, transparent 65%)',
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
        background: 'radial-gradient(ellipse at 70% 50%, rgba(0,212,255,0.05) 0%, transparent 60%)',
      }}
    >
      {/* Corner HUD decorations */}
      <div className="absolute top-20 left-6 text-text2/20 font-mono text-xs leading-loose select-none">
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
      <div className="absolute top-20 right-6 text-text2/20 font-mono text-xs leading-loose text-right select-none">
        {['v1.0.0', 'MIT', 'PRIVACY-FIRST', 'OPEN-SOURCE'].map((t, i) => (
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

      <div className="max-w-7xl mx-auto px-6 grid lg:grid-cols-2 gap-16 items-center w-full py-20">

        {/* ── Left: copy ── */}
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
            className="text-4xl lg:text-5xl xl:text-6xl font-bold leading-tight mb-6"
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
            className="text-text2 text-lg leading-relaxed mb-6 max-w-lg"
          >
            Argos watches your Telegram, WhatsApp, Email, Discord, and Slack —
            classifies every message, drafts responses, and{' '}
            <span className="text-white font-medium">never acts without your explicit approval.</span>
          </motion.p>

          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.6 }}
            className="text-text2/70 text-sm font-mono mb-8 border-l-2 border-cyan/30 pl-4 leading-relaxed"
          >
            All PII anonymized before any LLM sees it. Cloud models only see{' '}
            <span className="text-cyan">[PERSON_1]</span>,{' '}
            <span className="text-green">[AMOUNT_1]</span>,{' '}
            <span className="text-cyan">[ADDR_1]</span>.{' '}
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
              className="flex items-center gap-2 px-6 py-3 text-bg font-semibold text-sm rounded-sm transition-all duration-200 hover:scale-105 hover:brightness-110"
              style={{
                background: 'linear-gradient(135deg, #00d4ff, #00ff88)',
                boxShadow: '0 0 24px rgba(0,212,255,0.3)',
              }}
            >
              Get Started <ArrowRight size={15} />
            </a>
            <a
              href="https://github.com/reejakdev/argosbot"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 px-6 py-3 border border-cyan/30 text-cyan text-sm font-mono rounded-sm hover:bg-cyan/10 hover:border-cyan/60 transition-all duration-200"
            >
              <GitBranch size={15} /> View on GitHub
            </a>
          </motion.div>

          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 1 }}
            className="flex items-center gap-8 mt-10 pt-8 border-t border-white/5"
          >
            {[
              { val: '5',    label: 'Channels' },
              { val: '15+',  label: 'LLM Providers' },
              { val: '0',    label: 'Actions without approval', dim: true },
              { val: 'MIT',  label: 'License' },
            ].map((stat) => (
              <div key={stat.label}>
                <div className={`text-2xl font-bold font-mono ${stat.dim ? 'text-green glow-green' : 'text-cyan glow-cyan'}`}>
                  {stat.val}
                </div>
                <div className="text-text2 text-xs mt-0.5 leading-tight max-w-[80px]">{stat.label}</div>
              </div>
            ))}
          </motion.div>
        </div>

        {/* ── Right: HUD diagram ── */}
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
        style={{ background: 'linear-gradient(transparent, rgba(4,5,13,0.85))' }}
      />
    </section>
  )
}
