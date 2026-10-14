import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface ToastMsg { text: string; kind: 'success' | 'error' }
type Show = (text: string, kind?: ToastMsg['kind']) => void;

const ToastContext = createContext<Show | null>(null);

// Null outside a ToastProvider (e.g. isolated component tests); callers fall back to inline messages.
export const useToast = () => useContext(ToastContext);

// Small confirmation pill pinned to the bottom of the window; announced to screen readers.
export function Toast({ toast }: { toast: ToastMsg | null }) {
  if (!toast) return null;
  return createPortal(
    <div className={`toast toast-${toast.kind}`} role={toast.kind === 'error' ? 'alert' : 'status'} aria-live="polite">
      <span className="toast-icon" aria-hidden="true">{toast.kind === 'success' ? '✓' : '!'}</span>
      {toast.text}
    </div>,
    document.body,
  );
}

// One toast at a time for the whole app; a new one replaces the current one. Errors stay a little longer.
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastMsg | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const show = useCallback<Show>((text, kind = 'success') => {
    clearTimeout(timer.current);
    setToast({ text, kind });
    timer.current = setTimeout(() => setToast(null), kind === 'error' ? 5000 : 2500);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  return <ToastContext.Provider value={show}>{children}<Toast toast={toast} /></ToastContext.Provider>;
}
