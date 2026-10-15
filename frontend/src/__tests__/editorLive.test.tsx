import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LockButton } from '../components/LockButton';
import { setWriteKey } from '../api';
import { clientId, getEditor, setEditor } from '../editor';

afterEach(() => { setWriteKey(''); setEditor(null); vi.unstubAllGlobals(); });

describe('editor lease', () => {
  it('shows who is editing and takes over on request', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => {
      calls.push(`${init?.method} ${u} ${init?.body ?? ''}`);
      return u.endsWith('/access') ? Response.json({ locked: false }) : Response.json({ editor: { clientId, name: 'Me' } });
    }));
    render(<LockButton />);
    act(() => setEditor({ clientId: 'other', name: 'Ana' }));
    expect(await screen.findByText(/Ana is editing/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Take over' }));
    await waitFor(() => expect(getEditor()?.clientId).toBe(clientId));
    expect(calls.some((c) => c.includes('/editor/claim') && c.includes('"force":true'))).toBe(true);
    await waitFor(() => expect(screen.queryByText(/is editing/)).toBeNull());
  });

  it('a refused write names the editor', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { code: 'conflict', message: 'Ana is editing', extra: { editor: { clientId: 'other', name: 'Ana' } } } }, { status: 409 })));
    const { api } = await import('../api');
    await expect(api.createOwner({ name: 'x' } as any)).rejects.toThrow('Ana is editing');
    expect(getEditor()?.name).toBe('Ana');
  });
});
