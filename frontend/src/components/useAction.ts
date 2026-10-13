import { useState } from 'react';

export function useAction() {
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try { await fn(); return true; } catch (e) { setError((e as Error).message); return false; }
  };
  return { error, run };
}
