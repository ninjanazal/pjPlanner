import { useState } from 'react';
import { useToast } from './Toast';

// `toastErrors`: report failures as a toast (when a ToastProvider is present) instead of through `error`.
export function useAction(toastErrors = false) {
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();
  // `done`: optional success toast text.
  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setError(null);
    try { await fn(); if (done) toast?.(done); return true; } catch (e) {
      const msg = (e as Error).message;
      if (toastErrors && toast) toast(msg, 'error'); else setError(msg);
      return false;
    }
  };
  return { error, run };
}
