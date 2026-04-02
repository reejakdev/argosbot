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

  const borderColor = (type: ToastItem['type']) => {
    if (type === 'success') return '#00ff88';
    if (type === 'error') return '#ff4466';
    return '#00d4ff';
  };

  const textColor = (type: ToastItem['type']) => {
    if (type === 'success') return '#00ff88';
    if (type === 'error') return '#ff4466';
    return '#00d4ff';
  };

  return (
    <ToastContext.Provider value={{ toast, toastError }}>
      {children}
      <div
        className="fixed z-50 flex flex-col gap-2 pointer-events-none"
        style={{ top: 16, right: 16, maxWidth: 320 }}
      >
        {items.map((item) => (
          <div
            key={item.id}
            className="hud-card px-4 py-3"
            style={{
              borderColor: borderColor(item.type),
              background: 'rgba(8,12,24,0.97)',
              backdropFilter: 'blur(8px)',
            }}
          >
            <span
              style={{
                fontFamily: "'Courier New', monospace",
                fontSize: '0.7rem',
                color: textColor(item.type),
                letterSpacing: '0.06em',
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
