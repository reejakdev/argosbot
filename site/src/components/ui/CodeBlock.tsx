interface CodeBlockProps {
  code: string
  language?: string
  title?: string
}

export function CodeBlock({ code, language = 'json', title }: CodeBlockProps) {
  return (
    <div className="hud-card rounded-sm overflow-hidden">
      {title && (
        <div className="flex items-center gap-2 px-4 py-2 border-b border-[rgba(0,212,255,0.1)] bg-[rgba(0,212,255,0.03)]">
          <div className="flex gap-1.5">
            <div className="w-2.5 h-2.5 rounded-full bg-red/60" />
            <div className="w-2.5 h-2.5 rounded-full bg-[#ffaa00]/60" />
            <div className="w-2.5 h-2.5 rounded-full bg-green/60" />
          </div>
          <span className="font-mono text-xs text-text2 ml-2">{title}</span>
          <span className="ml-auto font-mono text-xs text-text2/40">{language}</span>
        </div>
      )}
      <pre className="p-4 text-xs overflow-x-auto leading-relaxed">
        <code className="text-text">{code}</code>
      </pre>
    </div>
  )
}
