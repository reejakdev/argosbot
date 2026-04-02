const phrases = [
  '// READ BY DEFAULT',
  '◆ SANITIZE BEFORE MEMORY',
  '// APPROVE BEFORE ACTION',
  '◆ LOCAL-FIRST ARCHITECTURE',
  '// PII ANONYMIZED BEFORE LLM',
  '◆ 15+ LLM PROVIDERS',
  '// WEBAUTHN APPROVAL',
  '◆ MIT LICENSE',
  '// ZERO RAW DATA STORED',
  '◆ PASSKEY + YUBIKEY SUPPORT',
  '// PLUGIN API IN TYPESCRIPT',
  '◆ LANCEDB VECTOR SEARCH',
  '// 5 MESSAGING CHANNELS',
  '◆ OPEN SOURCE',
  '// END-TO-END PRIVACY',
  '◆ HUMAN IN THE LOOP',
]

export default function Ticker() {
  const doubled = [...phrases, ...phrases]

  return (
    <div
      className="relative py-3 overflow-hidden"
      style={{
        borderTop: '1px solid rgba(79,110,255,0.1)',
        borderBottom: '1px solid rgba(79,110,255,0.1)',
        background: '#f2f0ec',
      }}
    >
      {/* Left fade */}
      <div
        className="absolute left-0 top-0 bottom-0 w-20 z-10 pointer-events-none"
        style={{ background: 'linear-gradient(to right, #f2f0ec, transparent)' }}
      />
      {/* Right fade */}
      <div
        className="absolute right-0 top-0 bottom-0 w-20 z-10 pointer-events-none"
        style={{ background: 'linear-gradient(to left, #f2f0ec, transparent)' }}
      />

      <div className="marquee-container">
        <div className="marquee-track">
          {doubled.map((phrase, i) => (
            <span
              key={i}
              className="inline-block mx-6 font-mono text-xs tracking-widest"
              style={{ color: phrase.startsWith('◆') ? '#4f6eff' : '#6b7280' }}
            >
              {phrase}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
