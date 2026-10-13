import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LockButton } from '../components/LockButton';
import { getWriteKey, setWriteKey } from '../api';

const serve = (handler: (url: string, init?: RequestInit) => Response) =>
  vi.stubGlobal('fetch', vi.fn(async (u: string, init?: RequestInit) => handler(u, init)));

afterEach(() => { setWriteKey(''); vi.unstubAllGlobals(); });

describe('write lock', () => {
  it('is hidden when the server needs no key', async () => {
    serve(() => Response.json({ locked: false }));
    render(<LockButton />);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('stays available with a stale key so it can be replaced', async () => {
    serve(() => Response.json({ error: { code: 'unauthorized', message: 'no' } }, { status: 401 }));
    render(<LockButton />);
    expect(await screen.findByRole('button', { name: /locked, read only/i })).toBeTruthy();
  });

  it('rejects a wrong key and keeps the right one', async () => {
    serve((u, init) => {
      if (u.endsWith('/access')) return Response.json({ locked: true });
      const k = (init?.headers as Record<string, string>)['x-api-key'];
      return k === 'secret' ? Response.json({ ok: true }) : Response.json({ error: { code: 'unauthorized', message: 'no' } }, { status: 401 });
    });
    render(<LockButton />);
    fireEvent.click(await screen.findByRole('button', { name: /locked, read only/i }));
    fireEvent.change(screen.getByLabelText('Write key'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    await screen.findByText('That is not the write key.');
    expect(getWriteKey()).toBe('');
    fireEvent.change(screen.getByLabelText('Write key'), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /editing unlocked/i })).toBeTruthy());
    expect(getWriteKey()).toBe('secret');
  });
});
