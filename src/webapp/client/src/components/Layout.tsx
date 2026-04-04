import type { ReactNode } from 'react';

type Page = 'approvals' | 'tasks' | 'memory' | 'history' | 'status' | 'configure';

interface LayoutProps {
  page: Page;
  onPageChange: (page: Page) => void;
  wsConnected: boolean;
  children: ReactNode;
}

const NAV_ITEMS: { id: Page; label: string; icon: ReactNode }[] = [
  {
    id: 'approvals',
    label: 'Approvals',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-5 h-5">
        <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  },
  {
    id: 'tasks',
    label: 'Tasks',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-5 h-5">
        <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
      </svg>
    ),
  },
  {
    id: 'memory',
    label: 'Memory',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-5 h-5">
        <path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
      </svg>
    ),
  },
  {
    id: 'history',
    label: 'History',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-5 h-5">
        <path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  },
  {
    id: 'status',
    label: 'Status',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-5 h-5">
        <circle cx="12" cy="12" r="3" />
        <path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83" />
      </svg>
    ),
  },
  {
    id: 'configure',
    label: 'Configure',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-5 h-5">
        <path d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.325.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 0 1 1.37.49l1.296 2.247a1.125 1.125 0 0 1-.26 1.431l-1.003.827c-.293.241-.438.613-.43.992a7.723 7.723 0 0 1 0 .255c-.008.378.137.75.43.991l1.004.827c.424.35.534.955.26 1.43l-1.298 2.247a1.125 1.125 0 0 1-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.47 6.47 0 0 1-.22.128c-.331.183-.581.495-.644.869l-.213 1.281c-.09.543-.56.94-1.11.94h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 0 1-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 0 1-1.369-.49l-1.297-2.247a1.125 1.125 0 0 1 .26-1.431l1.004-.827c.292-.24.437-.613.43-.991a6.932 6.932 0 0 1 0-.255c.007-.38-.138-.751-.43-.992l-1.004-.827a1.125 1.125 0 0 1-.26-1.43l1.297-2.247a1.125 1.125 0 0 1 1.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.086.22-.128.332-.183.582-.495.644-.869l.214-1.28Z" />
        <path d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
      </svg>
    ),
  },
];

// Eye SVG icon — exact same logo as the landing site
function EyeIcon({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M2 16 C6 8, 26 8, 30 16 C26 24, 6 24, 2 16 Z" stroke="#4f6eff" strokeWidth="1.2" fill="none" />
      <circle cx="16" cy="16" r="6.5" stroke="#4f6eff" strokeWidth="1" fill="none" opacity="0.9" />
      <circle cx="16" cy="16" r="4" stroke="#7b96ff" strokeWidth="0.8" fill="none" opacity="0.7" />
      <circle cx="16" cy="16" r="2" fill="#4f6eff" />
      <circle cx="16" cy="16" r="1" fill="white" opacity="0.9" />
      <line x1="2" y1="16" x2="4.5" y2="16" stroke="#4f6eff" strokeWidth="0.8" opacity="0.5" />
      <line x1="27.5" y1="16" x2="30" y2="16" stroke="#4f6eff" strokeWidth="0.8" opacity="0.5" />
    </svg>
  );
}

const PAGE_TITLES: Record<Page, string> = {
  approvals: 'Pending Approvals',
  tasks: 'Task Queue',
  memory: 'Memory Store',
  history: 'History Log',
  status: 'System Status',
  configure: 'Configuration',
};

export default function Layout({ page, onPageChange, wsConnected, children }: LayoutProps) {
  return (
    <div className="flex min-h-dvh" style={{ background: 'var(--bg)' }}>
      {/* Sidebar */}
      <aside
        className="hidden md:flex flex-col fixed left-0 top-0 bottom-0 w-56 z-20"
        style={{
          background: 'var(--bg2)',
          borderRight: '1px solid var(--border)',
        }}
      >
        {/* Logo */}
        <div
          className="flex items-center gap-2.5 px-5 py-5"
          style={{ borderBottom: '1px solid var(--border)' }}
        >
          <EyeIcon />
          <span
            style={{
              fontFamily: "'Inter', sans-serif",
              fontSize: '1rem',
              fontWeight: 700,
              letterSpacing: '0.08em',
              color: '#111827',
            }}
          >
            ARGOS
          </span>
        </div>

        {/* Nav */}
        <nav className="flex-1 py-3 px-2 flex flex-col gap-0.5">
          {NAV_ITEMS.map((item) => {
            const isActive = page === item.id;
            return (
              <button
                key={item.id}
                onClick={() => onPageChange(item.id)}
                className="flex items-center gap-3 px-3 py-2.5 w-full text-left cursor-pointer transition-all"
                style={{
                  background: isActive ? '#e4e4e4' : 'transparent',
                  borderLeft: isActive ? '2px solid #4f6eff' : '2px solid transparent',
                  borderRadius: isActive ? '0 6px 6px 0' : '6px',
                  color: isActive ? '#111827' : '#374151',
                  fontFamily: "'Inter', sans-serif",
                  fontSize: '0.8125rem',
                  fontWeight: isActive ? 600 : 400,
                  border: 'none',
                  borderLeft: isActive ? '2px solid #4f6eff' : '2px solid transparent',
                  outline: 'none',
                  transition: 'all 0.15s ease',
                }}
              >
                <span
                  style={{
                    color: isActive ? '#4f6eff' : 'var(--text2)',
                    opacity: isActive ? 1 : 0.6,
                  }}
                >
                  {item.icon}
                </span>
                {item.label}
              </button>
            );
          })}
        </nav>

        {/* Bottom status */}
        <div
          className="px-4 py-4 flex flex-col gap-2"
          style={{ borderTop: '1px solid var(--border)' }}
        >
          <div className="flex items-center gap-2">
            <span className="status-dot status-dot-online" />
            <span
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '0.6rem',
                fontWeight: 700,
                letterSpacing: '0.1em',
                color: '#059669',
              }}
            >
              SYSTEM ONLINE
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className={`status-dot ${wsConnected ? 'status-dot-cyan' : 'status-dot-muted'}`} />
            <span
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '0.6rem',
                letterSpacing: '0.08em',
                color: wsConnected ? '#4f6eff' : 'var(--text2)',
              }}
            >
              {wsConnected ? 'WS CONNECTED' : 'WS OFFLINE'}
            </span>
          </div>
        </div>
      </aside>

      {/* Main */}
      <div className="flex-1 flex flex-col md:ml-56" style={{ minWidth: 0 }}>
        {/* Top bar (desktop) */}
        <header
          className="hidden md:flex items-center justify-between px-6 py-3 sticky top-0 z-10"
          style={{
            background: 'rgba(255,255,255,0.95)',
            backdropFilter: 'blur(12px)',
            borderBottom: '1px solid #e5e7eb',
          }}
        >
          <span className="label-mono">{PAGE_TITLES[page]}</span>
          <div className="flex items-center gap-2">
            <span className={`status-dot ${wsConnected ? 'status-dot-cyan' : 'status-dot-muted'}`} />
            <span
              style={{
                fontFamily: "'JetBrains Mono', monospace",
                fontSize: '0.6rem',
                color: wsConnected ? '#4f6eff' : 'var(--text2)',
                letterSpacing: '0.08em',
              }}
            >
              {wsConnected ? 'LIVE' : 'OFFLINE'}
            </span>
          </div>
        </header>

        {/* Mobile header */}
        <header
          className="md:hidden sticky top-0 z-10 flex items-center justify-between px-4 py-3"
          style={{
            background: 'var(--bg2)',
            borderBottom: '1px solid var(--border)',
            paddingTop: 'calc(12px + var(--safe-top))',
          }}
        >
          <div className="flex items-center gap-2">
            <EyeIcon />
            <span
              style={{
                fontFamily: "'Inter', sans-serif",
                fontSize: '0.9rem',
                fontWeight: 700,
                letterSpacing: '0.08em',
                color: '#111827',
              }}
            >
              ARGOS
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className={`status-dot ${wsConnected ? 'status-dot-online' : 'status-dot-muted'}`} />
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 px-4 py-4 md:px-6 md:py-5" style={{ paddingBottom: 'calc(80px + var(--safe-bottom))' }}>
          {children}
        </main>
      </div>

      {/* Mobile bottom nav */}
      <nav
        className="md:hidden fixed bottom-0 left-0 right-0 z-10 flex"
        style={{
          background: 'var(--bg2)',
          borderTop: '1px solid var(--border)',
          paddingBottom: 'var(--safe-bottom)',
        }}
      >
        {NAV_ITEMS.map((item) => {
          const isActive = page === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onPageChange(item.id)}
              className="flex-1 flex flex-col items-center gap-1 py-3 cursor-pointer transition-all"
              style={{
                background: 'transparent',
                border: 'none',
                borderTop: isActive ? '2px solid #4f6eff' : '2px solid transparent',
                color: isActive ? '#4f6eff' : 'var(--text2)',
                fontFamily: "'Inter', sans-serif",
                fontSize: '0.55rem',
                fontWeight: isActive ? 600 : 400,
                letterSpacing: '0.06em',
                textTransform: 'uppercase',
                outline: 'none',
              }}
            >
              {item.icon}
              {item.label}
            </button>
          );
        })}
      </nav>
    </div>
  );
}
