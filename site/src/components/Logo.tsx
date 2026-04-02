interface LogoIconProps {
  size?: number
  className?: string
}

// Argos logo — an eye with radar rings inside
// Represents the "hundred-eyed giant who never slept"
export function LogoIcon({ size = 32, className = '' }: LogoIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
    >
      {/* Outer eye outline */}
      <path
        d="M2 16 C6 8, 26 8, 30 16 C26 24, 6 24, 2 16 Z"
        stroke="#4f6eff"
        strokeWidth="1.2"
        fill="none"
      />
      {/* Iris — outer ring */}
      <circle cx="16" cy="16" r="6.5" stroke="#4f6eff" strokeWidth="1" fill="none" opacity="0.9" />
      {/* Iris — middle ring */}
      <circle cx="16" cy="16" r="4" stroke="#7b96ff" strokeWidth="0.8" fill="none" opacity="0.7" />
      {/* Pupil */}
      <circle cx="16" cy="16" r="2" fill="#4f6eff" />
      {/* Pupil glow center */}
      <circle cx="16" cy="16" r="1" fill="white" opacity="0.9" />
      {/* Corner tick marks on outer eye */}
      <line x1="2" y1="16" x2="4.5" y2="16" stroke="#4f6eff" strokeWidth="0.8" opacity="0.5" />
      <line x1="27.5" y1="16" x2="30" y2="16" stroke="#4f6eff" strokeWidth="0.8" opacity="0.5" />
    </svg>
  )
}

// Full wordmark: icon + ARGOS text
export function LogoFull({ height = 28 }: { height?: number }) {
  const iconSize = height
  return (
    <div className="flex items-center gap-2.5">
      <LogoIcon size={iconSize} />
      <span
        className="font-semibold tracking-widest"
        style={{
          fontSize: height * 0.6,
          letterSpacing: '0.22em',
          color: '#0f1117',
        }}
      >
        ARGOS
      </span>
    </div>
  )
}
