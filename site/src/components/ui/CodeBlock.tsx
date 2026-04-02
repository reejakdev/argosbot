interface CodeBlockProps {
  code: string
  language?: string
  title?: string
}

export function CodeBlock({ code, language = 'json', title }: CodeBlockProps) {
  return (
    <div
      className="overflow-hidden"
      style={{
        background: '#080e22',
        border: '1px solid #e5e7eb',
        borderRadius: '8px',
        boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
      }}
    >
      {title && (
        <div
          className="flex items-center gap-2 px-4 py-2.5 border-b"
          style={{
            borderColor: 'rgba(79,110,255,0.1)',
            background: '#ebebeb',
          }}
        >
          <div className="flex gap-1.5">
            <div className="w-2.5 h-2.5 rounded-full" style={{ background: '#ef4444', opacity: 0.7 }} />
            <div className="w-2.5 h-2.5 rounded-full" style={{ background: '#f59e0b', opacity: 0.7 }} />
            <div className="w-2.5 h-2.5 rounded-full" style={{ background: '#10b981', opacity: 0.7 }} />
          </div>
          <span className="font-mono text-xs text-text2 ml-2">{title}</span>
          <span className="ml-auto font-mono text-xs" style={{ color: 'rgba(148,163,184,0.4)' }}>{language}</span>
        </div>
      )}
      <pre className="p-4 text-xs overflow-x-auto leading-relaxed">
        <code style={{ color: '#c4d4f0' }}>{code}</code>
      </pre>
    </div>
  )
}
