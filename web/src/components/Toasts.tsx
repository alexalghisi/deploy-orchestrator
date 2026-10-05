import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

interface Toast {
  id: number;
  tone: 'error' | 'info';
  message: string;
}

interface ToastApi {
  error(message: string): void;
  info(message: string): void;
}

const ToastContext = createContext<ToastApi>({ error() {}, info() {} });

export const useToast = (): ToastApi => useContext(ToastContext);

let nextId = 0;

export function ToastProvider({ children, timeoutMs = 6000 }: { children: ReactNode; timeoutMs?: number }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => setToasts((all) => all.filter((t) => t.id !== id)), []);
  const push = useCallback(
    (tone: Toast['tone'], message: string) => {
      const id = ++nextId;
      setToasts((all) => [...all.slice(-3), { id, tone, message }]);
      setTimeout(() => dismiss(id), timeoutMs);
    },
    [dismiss, timeoutMs],
  );
  const api = useMemo<ToastApi>(() => ({ error: (m) => push('error', m), info: (m) => push('info', m) }), [push]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast--${t.tone}`} role={t.tone === 'error' ? 'alert' : 'status'}>
            <span>{t.message}</span>
            <button type="button" className="toast__close" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
