import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

interface ToastItem {
  id: number;
  message: string;
  type: 'success' | 'error' | 'info';
}

interface ToastContextValue {
  toast: (message: string, duration?: number) => void;
  toastError: (message: string, duration?: number) => void;
}

const ToastContext = createContext<ToastContextValue>({ toast: () => {}, toastError: () => {} });

export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const counterRef = { current: 0 };

  const addToast = useCallback((message: string, type: ToastItem['type'], duration = 2500) => {
    const id = ++counterRef.current;
    setItems((prev) => [...prev.slice(-4), { id, message, type }]);
    setTimeout(() => {
      setItems((prev) => prev.filter((t) => t.id !== id));
    }, duration);
  }, []);

  const toast = useCallback((msg: string, duration?: number) => addToast(msg, 'info', duration), [addToast]);
  const toastError = useCallback((msg: string, duration?: number) => addToast(msg, 'error', duration), [addToast]);

  function toastStyles(type: ToastItem['type']): React.CSSProperties {
    const base: React.CSSProperties = {
      background: 'rgba(13,21,48,0.97)',
      backdropFilter: 'blur(12px)',
      border: '1px solid',
      borderRadius: '8px',
      padding: '0.75rem 1rem',
      display: 'flex',
      alignItems: 'center',
      gap: '0.625rem',
      boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
    };
    if (type === 'success') return { ...base, borderColor: 'rgba(16,185,129,0.4)' };
    if (type === 'error') return { ...base, borderColor: 'rgba(239,68,68,0.4)' };
    return { ...base, borderColor: 'rgba(79,110,255,0.3)' };
  }

  function dotColor(type: ToastItem['type']): string {
    if (type === 'success') return '#10b981';
    if (type === 'error') return '#ef4444';
    return '#4f6eff';
  }

  return (
    <ToastContext.Provider value={{ toast, toastError }}>
      {children}
      <div
        className="fixed z-50 flex flex-col gap-2 pointer-events-none"
        style={{ top: 16, right: 16, maxWidth: 340 }}
      >
        {items.map((item) => (
          <div key={item.id} style={toastStyles(item.type)}>
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: dotColor(item.type),
                flexShrink: 0,
              }}
            />
            <span
              style={{
                fontFamily: "'Inter', sans-serif",
                fontSize: '0.8125rem',
                color: 'var(--text)',
                lineHeight: 1.4,
              }}
            >
              {item.message}
            </span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
