import { useState, useEffect } from 'react'
import { GitBranch, Menu, X } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'

const links = [
  { label: 'Pipeline', href: '#pipeline' },
  { label: 'Privacy', href: '#privacy' },
  { label: 'Features', href: '#features' },
  { label: 'Why', href: '#why' },
  { label: 'FAQ', href: '#faq' },
  { label: 'Setup', href: '#setup' },
]

export default function Nav() {
  const [scrolled, setScrolled] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)

  useEffect(() => {
    const handler = () => setScrolled(window.scrollY > 20)
    window.addEventListener('scroll', handler)
    return () => window.removeEventListener('scroll', handler)
  }, [])

  return (
    <motion.nav
      initial={{ y: -60, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.6, ease: 'easeOut' }}
      className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
        scrolled
          ? 'bg-bg/90 backdrop-blur-xl border-b border-[rgba(0,212,255,0.12)]'
          : 'bg-transparent'
      }`}
    >
      <div className="max-w-7xl mx-auto px-6 flex items-center justify-between h-16">
        {/* Logo */}
        <a href="#" className="flex items-center gap-3 group">
          <div className="relative">
            <div
              className="w-2.5 h-2.5 rounded-full bg-green animate-pulse-glow"
              style={{ boxShadow: '0 0 8px #00ff88, 0 0 16px rgba(0,255,136,0.4)' }}
            />
          </div>
          <span
            className="font-mono font-bold text-lg tracking-widest text-white glow-cyan"
            style={{ letterSpacing: '0.3em' }}
          >
            ARGOS
          </span>
        </a>

        {/* Desktop Links */}
        <div className="hidden md:flex items-center gap-6">
          {links.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="text-text2 hover:text-cyan text-sm font-medium transition-colors duration-200 font-mono tracking-wide"
            >
              {link.label}
            </a>
          ))}
        </div>

        {/* GitHub */}
        <div className="hidden md:flex items-center gap-3">
          <a
            href="https://github.com/reejakdev/argosbot"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 px-4 py-2 border border-[rgba(0,212,255,0.2)] text-cyan text-sm font-mono hover:bg-cyan/10 hover:border-cyan/50 transition-all duration-200 rounded-sm group"
          >
            <GitBranch size={14} />
            <span>GitHub</span>
          </a>
        </div>

        {/* Mobile hamburger */}
        <button
          className="md:hidden text-text2 hover:text-cyan transition-colors"
          onClick={() => setMobileOpen(!mobileOpen)}
        >
          {mobileOpen ? <X size={20} /> : <Menu size={20} />}
        </button>
      </div>

      {/* Mobile menu */}
      <AnimatePresence>
        {mobileOpen && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="md:hidden bg-bg2/95 backdrop-blur-xl border-b border-[rgba(0,212,255,0.12)]"
          >
            <div className="px-6 py-4 flex flex-col gap-4">
              {links.map((link) => (
                <a
                  key={link.href}
                  href={link.href}
                  onClick={() => setMobileOpen(false)}
                  className="text-text2 hover:text-cyan text-sm font-mono tracking-wide transition-colors"
                >
                  {link.label}
                </a>
              ))}
              <a
                href="https://github.com/reejakdev/argosbot"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 text-cyan text-sm font-mono"
              >
                <GitBranch size={14} />
                GitHub
              </a>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.nav>
  )
}
