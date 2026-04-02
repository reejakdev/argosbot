import { useEffect, useState } from 'react';
import { get, ApiError } from './api.ts';
import Login from './pages/Login.tsx';
import Setup from './pages/Setup.tsx';
import Layout from './components/Layout.tsx';
import Proposals from './pages/Proposals.tsx';
import Tasks from './pages/Tasks.tsx';
import MemoryPage from './pages/MemoryPage.tsx';
import History from './pages/History.tsx';
import Status from './pages/Status.tsx';
import { ToastProvider } from './components/Toast.tsx';
import { useWebSocket } from './hooks/useWebSocket.ts';

type AppState = 'loading' | 'setup' | 'login' | 'app';
type Page = 'approvals' | 'tasks' | 'memory' | 'history' | 'status';

export default function App() {
  const [appState, setAppState] = useState<AppState>('loading');
  const [page, setPage] = useState<Page>('approvals');
  const [wsConnected, setWsConnected] = useState(false);

  useWebSocket({
    onOpen: () => setWsConnected(true),
    onClose: () => setWsConnected(false),
    enabled: appState === 'app',
  });

  useEffect(() => {
    checkAuth();
  }, []);

  async function checkAuth() {
    try {
      // First check if any auth method is registered
      const status = await get<{ registered: boolean; totp: boolean }>('/auth/status');
      if (!status.registered) {
        setAppState('setup');
        return;
      }
      // Check if we have a valid session
      await get('/status');
      setAppState('app');
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        setAppState('login');
      } else {
        // network error or no auth configured — show setup
        setAppState('setup');
      }
    }
  }

  if (appState === 'loading') {
    return (
      <div
        className="flex items-center justify-center min-h-screen"
        style={{ background: 'var(--bg)' }}
      >
        <span
          style={{
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: '0.65rem',
            letterSpacing: '0.2em',
            color: 'rgba(79,110,255,0.4)',
          }}
        >
          INITIALIZING...
        </span>
      </div>
    );
  }

  if (appState === 'setup') {
    return (
      <ToastProvider>
        <Setup onComplete={() => setAppState('login')} />
      </ToastProvider>
    );
  }

  if (appState === 'login') {
    return (
      <ToastProvider>
        <Login onLogin={() => setAppState('app')} />
      </ToastProvider>
    );
  }

  return (
    <ToastProvider>
      <Layout page={page} onPageChange={setPage} wsConnected={wsConnected}>
        {page === 'approvals' && <Proposals />}
        {page === 'tasks' && <Tasks />}
        {page === 'memory' && <MemoryPage />}
        {page === 'history' && <History />}
        {page === 'status' && <Status onLogout={() => setAppState('login')} />}
      </Layout>
    </ToastProvider>
  );
}
