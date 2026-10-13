import { useEffect, useState } from 'react';
import { api, getWriteKey, setWriteKey } from '../api';
import { Modal } from './Modal';

// Header lock: the server is read-only until the write key is entered. Hidden when the server runs without a key.
export function LockButton() {
  const [required, setRequired] = useState(false);
  const [key, setKey] = useState(getWriteKey());
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // A 401 (stale key) still means a key is required, so keep the unlock dialog reachable.
    api.access().then((a) => setRequired(a?.locked === true)).catch((e) => setRequired(e?.status === 401));
    const sync = () => setKey(getWriteKey());
    const ask = () => { setError(null); setOpen(true); };
    window.addEventListener('pjplanner:key', sync);
    window.addEventListener('pjplanner:locked', ask);
    return () => { window.removeEventListener('pjplanner:key', sync); window.removeEventListener('pjplanner:locked', ask); };
  }, []);

  if (!required) return null;
  const unlocked = key !== '';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const previous = getWriteKey();
    setWriteKey(draft.trim());
    try { await api.unlock(); setOpen(false); setDraft(''); setError(null); }
    catch { setWriteKey(previous); setError('That is not the write key.'); }
  };

  return (
    <>
      <button className="icon-btn lock-btn" aria-label={unlocked ? 'Editing unlocked' : 'Locked, read only'} title={unlocked ? 'Editing unlocked (click to lock)' : 'Read only. Unlock to edit'}
        onClick={() => { if (unlocked) setWriteKey(''); else { setError(null); setOpen(true); } }}>{unlocked ? '🔓' : '🔒'}</button>
      {open && (
        <Modal title="Unlock editing" size="sm" onClose={() => setOpen(false)}>
          <form onSubmit={submit}>
            <p className="hint">Everyone can look; changing anything needs the write key (<code>WRITE_KEY</code> in the server's <code>.env</code>). It stays in this browser.</p>
            <label>Write key<input data-autofocus type="password" aria-label="Write key" value={draft} onChange={(e) => setDraft(e.target.value)} autoComplete="off" /></label>
            {error && <p className="error" role="alert">{error}</p>}
            <div className="row modal-actions">
              <button type="submit" className="primary" disabled={!draft.trim()}>Unlock</button>
              <button type="button" onClick={() => setOpen(false)}>Cancel</button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
