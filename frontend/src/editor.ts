import type { Editor } from './types';

// Who may write in the active project: the server keeps one editor lease per project. Each tab has its own client id so
// two tabs of one person count as two clients; the display name is only a label (there are no accounts).
const rand = () => Math.random().toString(36).slice(2, 10);
export const clientId: string = (() => {
  try {
    let v = sessionStorage.getItem('pjplanner.client');
    if (!v) { v = rand(); sessionStorage.setItem('pjplanner.client', v); }
    return v;
  } catch { return rand(); }
})();

const NAME_KEY = 'pjplanner.name';
export const getName = (): string => { try { return localStorage.getItem(NAME_KEY) || `Anonymous-${clientId.slice(0, 4)}`; } catch { return `Anonymous-${clientId.slice(0, 4)}`; } };
export const setName = (n: string) => { try { if (n.trim()) localStorage.setItem(NAME_KEY, n.trim()); else localStorage.removeItem(NAME_KEY); } catch { /* storage unavailable */ } };

let editor: Editor = null;
export const getEditor = () => editor;
export const setEditor = (e: Editor) => {
  if (e?.clientId === editor?.clientId && e?.name === editor?.name) return;
  editor = e;
  window.dispatchEvent(new Event('pjplanner:editor'));
};
export const isMe = (e: Editor) => e?.clientId === clientId;
