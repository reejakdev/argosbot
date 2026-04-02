import { motion } from 'framer-motion'
import { GitBranch, Shield, Heart } from 'lucide-react'

const links = [
  { label: 'Pipeline', href: '#pipeline' },
  { label: 'Privacy', href: '#privacy' },
  { label: 'Features', href: '#features' },
  { label: 'Why Argos', href: '#why' },
  { label: 'FAQ', href: '#faq' },
  { label: 'Setup', href: '#setup' },
]

export default function Footer() {
  return (
    <footer
      style={{
        borderTop: '1px solid rgba(79,110,255,0.12)',
        background: 'rgba(10,16,32,0.6)',
      }}
    >
      <div className="max-w-7xl mx-auto px-6 py-16">
        <div className="grid md:grid-cols-3 gap-10 mb-10">
          {/* Logo + description */}
          <div>
            <div className="flex items-center gap-3 mb-4">
              <div
                className="w-2.5 h-2.5 rounded-full bg-green animate-pulse"
              />
              <span
                className="font-semibold text-lg text-white tracking-widest"
                style={{ letterSpacing: '0.25em' }}
              >
                ARGOS
              </span>
            </div>
            <p className="text-text2 text-sm leading-relaxed mb-4">
              A local-first, privacy-preserving AI assistant for fintech and crypto teams.
              Read by default. Sanitize before memory. Approve before action.
            </p>
            <div className="flex items-center gap-2 text-xs text-text2/60">
              <Shield size={12} style={{ color: '#10b981' }} />
              <span>MIT License — Free forever</span>
            </div>
          </div>

          {/* Navigation */}
          <div>
            <div className="text-xs font-semibold tracking-wide mb-4" style={{ color: '#7b96ff' }}>NAVIGATION</div>
            <div className="grid grid-cols-2 gap-2">
              {links.map((link) => (
                <a
                  key={link.href}
                  href={link.href}
                  className="text-text2 hover:text-text text-sm transition-colors"
                >
                  {link.label}
                </a>
              ))}
            </div>
          </div>

          {/* Links */}
          <div>
            <div className="text-xs font-semibold tracking-wide mb-4" style={{ color: '#7b96ff' }}>LINKS</div>
            <div className="space-y-2">
              <a
                href="https://github.com/reejakdev/argosbot"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 text-text2 hover:text-text text-sm transition-colors"
              >
                <GitBranch size={14} />
                GitHub Repository
              </a>
              <a
                href="https://github.com/reejakdev/argosbot/blob/main/README.md"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 text-text2 hover:text-text text-sm transition-colors"
              >
                <span className="w-3.5 h-3.5 flex items-center justify-center font-mono text-xs">D</span>
                Documentation
              </a>
              <a
                href="https://github.com/reejakdev/argosbot/issues"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 text-text2 hover:text-text text-sm transition-colors"
              >
                <span className="w-3.5 h-3.5 flex items-center justify-center font-mono text-xs">!</span>
                Report an Issue
              </a>
            </div>
          </div>
        </div>

        {/* Divider */}
        <div
          className="pt-8"
          style={{ borderTop: '1px solid rgba(79,110,255,0.08)' }}
        >
          <div className="flex flex-col md:flex-row items-center justify-between gap-4">
            <div className="text-text2/50 text-xs font-mono">
              MIT License — Copyright © 2026 Argos Contributors
            </div>
            <div className="flex items-center gap-1.5 text-text2/50 text-xs">
              <span>Built with</span>
              <Heart size={11} style={{ color: 'rgba(239,68,68,0.6)' }} />
              <span>for fintech privacy</span>
            </div>
            <div className="flex items-center gap-1.5 text-text2/40 text-xs font-mono">
              <div className="w-1.5 h-1.5 rounded-full bg-green animate-pulse" />
              <span>v1.0.0 — Local-first</span>
            </div>
          </div>
        </div>
      </div>

      {/* Bottom accent line */}
      <motion.div
        className="h-px w-full"
        style={{
          background: 'linear-gradient(to right, transparent, rgba(79,110,255,0.5), rgba(123,150,255,0.5), transparent)',
        }}
        animate={{ opacity: [0.4, 0.8, 0.4] }}
        transition={{ duration: 4, repeat: Infinity }}
      />
    </footer>
  )
}
