interface BadgeProps {
  label: string
  variant?: 'local' | 'cloud' | 'human' | 'default'
}

export function Badge({ label, variant = 'default' }: BadgeProps) {
  const styles = {
    local:   'bg-green/10 text-green border border-green/25',
    cloud:   'bg-blue/10 text-blue2 border border-blue/25',
    human:   'bg-red/10 text-red border border-red/25',
    default: 'bg-text2/10 text-text2 border border-text2/20',
  }

  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${styles[variant]}`}>
      {label}
    </span>
  )
}
