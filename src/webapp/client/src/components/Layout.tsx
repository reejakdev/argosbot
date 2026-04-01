import type { ReactNode } from 'react';

type Page = 'approvals' | 'tasks' | 'memory' | 'history' | 'status';

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
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-6 h-6">
        <path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  },
  {
    id: 'tasks',
    label: 'Tasks',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-6 h-6">
        <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
      </svg>
    ),
  },
  {
    id: 'memory',
    label: 'Memory',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-6 h-6">
        <path d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
      </svg>
    ),
  },
  {
    id: 'history',
    label: 'History',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-6 h-6">
        <path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  },
  {
    id: 'status',
    label: 'Status',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-6 h-6">
        <circle cx="12" cy="12" r="3" />
        <path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83" />
      </svg>
    ),
  },
];

export default function Layout({ page, onPageChange, wsConnected, children }: LayoutProps) {
  return (
    <div className="min-h-dvh" style={{ paddingBottom: 'calc(80px + var(--safe-bottom))' }}>
      {/* Header */}
      <header
        className="sticky top-0 z-10 flex items-center justify-between px-4 py-3 border-b"
        style={{
          background: 'var(--surface)',
          borderColor: 'var(--border)',
          paddingTop: 'calc(12px + var(--safe-top))',
        }}
      >
        <h1 className="text-lg font-semibold tracking-tight">🔭 Argos</h1>
        <div
          className="w-2 h-2 rounded-full transition-colors"
          style={{ background: wsConnected ? 'var(--green)' : 'var(--muted)', boxShadow: wsConnected ? '0 0 6px var(--green)' : 'none' }}
          title={wsConnected ? 'Live' : 'Disconnected'}
        />
      </header>

      {/* Page content */}
      <div className="px-4 py-3">{children}</div>

      {/* Bottom nav */}
      <nav
        className="fixed bottom-0 left-0 right-0 z-10 flex border-t"
        style={{ background: 'var(--surface)', borderColor: 'var(--border)', paddingBottom: 'var(--safe-bottom)' }}
      >
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            onClick={() => onPageChange(item.id)}
            className="flex-1 flex flex-col items-center gap-1 py-3 text-xs cursor-pointer border-none bg-transparent transition-colors"
            style={{ color: page === item.id ? 'var(--accent)' : 'var(--muted)' }}
          >
            {item.icon}
            {item.label}
          </button>
        ))}
      </nav>
    </div>
  );
}
