import { useState, useEffect } from 'react'
import { GitBranch, Menu, X } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import { LogoFull } from './Logo'

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
          ? 'backdrop-blur-xl border-b'
          : 'bg-transparent'
      }`}
      style={scrolled ? {
        background: '#ffffff',
        borderColor: '#e2e2e2',
      } : {}}
    >
      <div className="max-w-7xl mx-auto px-6 flex items-center justify-between h-16">
        {/* Logo */}
        <a href="#" className="flex items-center">
          <LogoFull height={28} />
        </a>

        {/* Desktop Links */}
        <div className="hidden md:flex items-center gap-7">
          {links.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="text-text2 hover:text-text text-sm font-medium transition-colors duration-200"
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
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium transition-all duration-200 rounded-md"
            style={{
              border: '1px solid #e2e2e2',
              color: '#1a1a1a',
              background: '#ffffff',
            }}
            onMouseEnter={e => {
              (e.currentTarget as HTMLElement).style.background = '#f8f8f8'
              ;(e.currentTarget as HTMLElement).style.borderColor = '#5b6cf8'
            }}
            onMouseLeave={e => {
              (e.currentTarget as HTMLElement).style.background = '#ffffff'
              ;(e.currentTarget as HTMLElement).style.borderColor = '#e2e2e2'
            }}
          >
            <GitBranch size={14} />
            <span>GitHub</span>
          </a>
        </div>

        {/* Mobile hamburger */}
        <button
          className="md:hidden text-text2 hover:text-text transition-colors"
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
            className="md:hidden backdrop-blur-xl border-b"
            style={{
              background: '#ffffff',
              borderColor: '#e2e2e2',
            }}
          >
            <div className="px-6 py-4 flex flex-col gap-4">
              {links.map((link) => (
                <a
                  key={link.href}
                  href={link.href}
                  onClick={() => setMobileOpen(false)}
                  className="text-text2 hover:text-text text-sm font-medium transition-colors"
                >
                  {link.label}
                </a>
              ))}
              <a
                href="https://github.com/reejakdev/argosbot"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 text-sm font-medium"
                style={{ color: '#5b6cf8' }}
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
