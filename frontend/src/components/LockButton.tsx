import { useEffect, useState } from 'react';
import { api, getWriteKey, setWriteKey } from '../api';
import { getEditor, getName, isMe, setEditor, setName } from '../editor';
import { Modal } from './Modal';

// Header lock: the server is read-only until the write key is entered. Hidden when the server runs without a key.
export function LockButton() {
  const [required, setRequired] = useState(false);
  const [key, setKey] = useState(getWriteKey());
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [editor, setEd] = useState(getEditor());
  const [name, setNameDraft] = useState(getName());
  const mine = isMe(editor);

  useEffect(() => {
    // A 401 (stale key) still means a key is required, so keep the unlock dialog reachable.
    api.access().then((a) => setRequired(a?.locked === true)).catch((e) => setRequired(e?.status === 401));
    const sync = () => setKey(getWriteKey());
    const ask = () => { setError(null); setOpen(true); };
    const syncEditor = () => setEd(getEditor());
    window.addEventListener('pjplanner:editor', syncEditor);
    window.addEventListener('pjplanner:key', sync);
    window.addEventListener('pjplanner:locked', ask);
    return () => { window.removeEventListener('pjplanner:editor', syncEditor); window.removeEventListener('pjplanner:key', sync); window.removeEventListener('pjplanner:locked', ask); };
  }, []);

  // While this tab holds the lease it keeps it alive; a refused heartbeat means someone took over (the 409 already updated the editor).
  useEffect(() => {
    if (!mine) return;
    const t = setInterval(() => { api.editorHeartbeat().catch(() => {}); }, 10_000);
    // Closing or reloading the tab frees the project at once instead of after the lease runs out.
    const leave = () => api.releaseEditor(true).catch(() => {});
    window.addEventListener('pagehide', leave);
    return () => { clearInterval(t); window.removeEventListener('pagehide', leave); };
  }, [mine]);

  const takeOver = () => api.claimEditor(true).then((r) => setEditor(r?.editor ?? null)).catch(() => {});
  const status = editor && !mine && (
    <span className="editor-status" role="status">{editor.name} is editing <button type="button" onClick={takeOver}>Take over</button></span>
  );
  if (!required) return <>{status}</>;
  const unlocked = key !== '';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const previous = getWriteKey();
    setWriteKey(draft.trim());
    setName(name);
    try { await api.unlock(); api.claimEditor().then((r) => setEditor(r?.editor ?? null)).catch(() => {}); setOpen(false); setDraft(''); setError(null); }
    catch { setWriteKey(previous); setError('That is not the write key.'); }
  };

  return (
    <>
      {status}
      <button className="icon-btn lock-btn" aria-label={unlocked ? 'Editing unlocked' : 'Locked, read only'} title={unlocked ? 'Editing unlocked (click to lock)' : 'Read only. Unlock to edit'}
        onClick={() => { if (unlocked) { if (mine) api.releaseEditor().catch(() => {}); setWriteKey(''); } else { setError(null); setOpen(true); } }}>{unlocked ? '🔓' : '🔒'}</button>
      {open && (
        <Modal title="Unlock editing" size="sm" onClose={() => setOpen(false)}>
          <form onSubmit={submit}>
            <p className="hint">Everyone can look; changing anything needs the write key (<code>WRITE_KEY</code> in the server's <code>.env</code>). It stays in this browser.</p>
            <label>Write key<input data-autofocus type="password" aria-label="Write key" value={draft} onChange={(e) => setDraft(e.target.value)} autoComplete="off" /></label>
            <label>Your name (shown to others while you edit)<input aria-label="Your name" value={name} maxLength={40} onChange={(e) => setNameDraft(e.target.value)} autoComplete="off" /></label>
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
