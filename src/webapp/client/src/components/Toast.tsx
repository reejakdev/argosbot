import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

interface ToastContextValue {
  toast: (message: string, duration?: number) => void;
}

const ToastContext = createContext<ToastContextValue>({ toast: () => {} });

export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState('');
  const [visible, setVisible] = useState(false);
  const timerRef = { current: 0 as ReturnType<typeof setTimeout> };

  const toast = useCallback((msg: string, duration = 2500) => {
    clearTimeout(timerRef.current);
    setMessage(msg);
    setVisible(true);
    timerRef.current = setTimeout(() => setVisible(false), duration);
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div
        className="fixed z-50 left-4 right-4 transition-opacity duration-200 pointer-events-none"
        style={{
          bottom: 'calc(90px + var(--safe-bottom))',
          opacity: visible ? 1 : 0,
        }}
      >
        <div className="bg-accent text-white px-4 py-3 rounded-xl text-sm font-medium shadow-lg">
          {message}
        </div>
      </div>
    </ToastContext.Provider>
  );
}
