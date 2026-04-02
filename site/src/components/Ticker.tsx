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
        background: 'rgba(10,16,32,0.6)',
      }}
    >
      {/* Left fade */}
      <div
        className="absolute left-0 top-0 bottom-0 w-20 z-10 pointer-events-none"
        style={{ background: 'linear-gradient(to right, var(--bg2), transparent)' }}
      />
      {/* Right fade */}
      <div
        className="absolute right-0 top-0 bottom-0 w-20 z-10 pointer-events-none"
        style={{ background: 'linear-gradient(to left, var(--bg2), transparent)' }}
      />

      <div className="marquee-container">
        <div className="marquee-track">
          {doubled.map((phrase, i) => (
            <span
              key={i}
              className="inline-block mx-6 font-mono text-xs tracking-widest"
              style={{ color: phrase.startsWith('◆') ? '#7b96ff' : '#94a3b8' }}
            >
              {phrase}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
