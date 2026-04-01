import { useEffect, useRef, useCallback } from 'react';
import type { WSEvent } from '../types.ts';

interface UseWebSocketOptions {
  onMessage?: (event: WSEvent) => void;
  onOpen?: () => void;
  onClose?: () => void;
  enabled?: boolean;
}

export function useWebSocket(options: UseWebSocketOptions = {}) {
  const wsRef = useRef<WebSocket | null>(null);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${window.location.host}/ws`);

    ws.onopen = () => optionsRef.current.onOpen?.();
    ws.onclose = () => {
      optionsRef.current.onClose?.();
      wsRef.current = null;
      // Reconnect after 3s if still enabled
      if (optionsRef.current.enabled !== false) {
        setTimeout(connect, 3000);
      }
    };
    ws.onerror = () => ws.close();
    ws.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data as string) as WSEvent;
        optionsRef.current.onMessage?.(event);
      } catch { /* ignore malformed messages */ }
    };

    wsRef.current = ws;
  }, []);

  useEffect(() => {
    if (options.enabled === false) {
      wsRef.current?.close();
      return;
    }
    connect();
    return () => {
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [options.enabled, connect]);

  return wsRef;
}
