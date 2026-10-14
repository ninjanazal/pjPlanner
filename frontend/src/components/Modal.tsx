import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ConfirmDialog } from './ConfirmDialog';

interface Props {
  title: ReactNode;
  headerExtra?: ReactNode;
  onClose: () => void;
  // When true, closing by Esc / backdrop / X first asks to discard unsaved edits.
  dirty?: boolean;
  role?: 'dialog' | 'alertdialog';
  size?: 'md' | 'sm';
  children: ReactNode;
}

// Open modals, topmost last. Only the topmost reacts to Esc / Tab, so a confirm opened over a popup
// handles the key itself and the popup underneath stays put.
const stack: symbol[] = [];
const dirtyModals = new Set<symbol>();
// Lets route handling refuse to leave the page while a popup holds unsaved edits.
export const hasDirtyModal = () => dirtyModals.size > 0;

// Same guard for unsaved edits that live on a page instead of a popup.
export function useDirtyGuard(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const key = Symbol('page-dirty');
    dirtyModals.add(key);
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => { dirtyModals.delete(key); window.removeEventListener('beforeunload', warn); };
  }, [dirty]);
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({ title, headerExtra, onClose, dirty = false, role = 'dialog', size = 'md', children }: Props) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const [asking, setAsking] = useState(false);
  const [z] = useState(() => 100 + stack.length * 10);
  const latest = useRef({ dirty, onClose });
  latest.current = { dirty, onClose };

  const requestClose = useCallback(() => {
    if (latest.current.dirty) setAsking(true); else latest.current.onClose();
  }, []);

  const dirtyKey = useRef(Symbol('dirty'));
  useEffect(() => {
    const key = dirtyKey.current;
    if (dirty) dirtyModals.add(key); else dirtyModals.delete(key);
    return () => { dirtyModals.delete(key); };
  }, [dirty]);

  useEffect(() => {
    const me = Symbol('modal');
    stack.push(me);
    const previous = document.activeElement as HTMLElement | null;
    const dlg = dialogRef.current!;
    const first = dlg.querySelector<HTMLElement>('[data-autofocus]') ?? dlg.querySelector<HTMLElement>('.modal-body')?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? dlg).focus();

    const onKey = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== me) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); requestClose(); return; }
      if (e.key !== 'Tab') return;
      const items = [...dlg.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0 || el === document.activeElement);
      if (items.length === 0) { e.preventDefault(); dlg.focus(); return; }
      const a = document.activeElement;
      if (!dlg.contains(a)) { e.preventDefault(); items[0].focus(); }
      else if (e.shiftKey && (a === items[0] || a === dlg)) { e.preventDefault(); items[items.length - 1].focus(); }
      else if (!e.shiftKey && a === items[items.length - 1]) { e.preventDefault(); items[0].focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      stack.splice(stack.indexOf(me), 1);
      if (previous && document.contains(previous)) previous.focus();
    };
  }, [requestClose]);

  return createPortal(
    <div className="overlay" style={{ zIndex: z }} data-testid="modal-backdrop"
      onMouseDown={(e) => { if (e.target === e.currentTarget) requestClose(); }}>
      <div ref={dialogRef} className={`modal modal-${size}`} role={role} aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <div className="modal-head">
          <h2 id={titleId}>{title}</h2>
          {headerExtra}
          <button type="button" className="modal-close" onClick={requestClose} aria-label="Close">&times;</button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
      {asking && (
        <ConfirmDialog title="Discard changes?" message="You have unsaved edits. Closing now will discard them."
          confirmLabel="Discard" cancelLabel="Keep editing"
          onConfirm={() => { setAsking(false); latest.current.onClose(); }} onCancel={() => setAsking(false)} />
      )}
    </div>,
    document.body,
  );
}
