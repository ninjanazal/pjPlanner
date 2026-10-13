// @ts-expect-error node types are not installed; vitest runs in node
import { readFileSync } from 'node:fs';
import mainSrc from '../main.tsx?raw';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OwnersPage } from '../components/OwnersPage';
import { parseHash } from '../route';
import type { Graph, Module } from '../types';

const mod = (id: number, name: string, ownerIds: number[], extra: Partial<Module> = {}): Module => ({
  id, name, description: '', ownerIds, color: null, icon: null, apiItems: [],
  textColor: null, strokeColor: null, strokeStyle: 'solid', x: null, y: null, groupId: null, ...extra,
});
const graph: Graph = {
  owners: [{ id: 1, name: 'Ann', color: '#ff0000', icon: '🧑' }, { id: 2, name: 'Bob', color: null, icon: null }],
  modules: [mod(1, 'Auth', [1], { icon: '🔐', color: '#112233' }), mod(2, 'Billing', [1, 2]), mod(3, 'Orphan', [])],
  relations: [], groups: [],
};
const mockFetch = (status: number, body?: unknown) => {
  const f = vi.fn().mockResolvedValue({ status, ok: status < 400, json: async () => body });
  vi.stubGlobal('fetch', f);
  return f;
};
afterEach(() => vi.unstubAllGlobals());

describe('OwnersPage', () => {
  it('lists owners with module counts and the unassigned hint', () => {
    render(<OwnersPage graph={graph} onChanged={() => {}} onOpenModule={() => {}} />);
    expect(within(screen.getByLabelText('Owner Ann')).getByText('2 modules')).toBeInTheDocument();
    expect(within(screen.getByLabelText('Owner Bob')).getByText('1 module')).toBeInTheDocument();
    expect(screen.getByText(/no owner: Orphan/)).toBeInTheDocument();
  });

  it('selecting an owner shows modules; clicking one opens it', async () => {
    const open = vi.fn();
    render(<OwnersPage graph={graph} onChanged={() => {}} onOpenModule={open} />);
    expect(screen.getByText(/Select an owner/)).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText('Owner Ann'));
    // read-only by default: identity shown, no form
    expect(screen.getByTestId('entity-head')).toHaveTextContent('🧑Ann');
    expect(screen.getByTestId('entity-head').style.borderLeft).toContain('rgb(255, 0, 0)');
    expect(screen.queryByLabelText('Name')).toBeNull();
    expect(screen.queryByText('Save owner')).toBeNull();
    expect(screen.getByLabelText('Open module Auth')).toHaveTextContent('🔐');
    expect(screen.getByLabelText('Open module Billing')).toBeInTheDocument();
    expect(screen.queryByLabelText('Open module Orphan')).toBeNull();
    await userEvent.click(screen.getByLabelText('Open module Auth'));
    expect(open).toHaveBeenCalledWith(1);
  });

  it('tiles render icon and colour accent', () => {
    render(<OwnersPage graph={graph} onChanged={() => {}} onOpenModule={() => {}} />);
    expect(screen.getByLabelText('Owner Ann')).toHaveTextContent('🧑');
    expect(screen.getByLabelText('Owner Ann').style.borderLeft).toContain('rgb(255, 0, 0)');
    expect(screen.getByLabelText('Owner Bob')).not.toHaveTextContent('🧑');
  });

  it('creates an owner with colour and icon, no email, and shows 409 inline', async () => {
    const f = mockFetch(201, { id: 9, name: 'Cy', color: '#00ff00', icon: '🔐' });
    const changed = vi.fn();
    render(<OwnersPage graph={graph} onChanged={changed} onOpenModule={() => {}} />);
    await userEvent.click(screen.getByText('Add owner'));
    expect(screen.queryByLabelText('Email')).toBeNull();
    await userEvent.type(screen.getByLabelText('Name'), 'Cy');
    fireEvent.input(screen.getByLabelText('Colour'), { target: { value: '#00ff00' } });
    await userEvent.click(screen.getByLabelText('Pick 🔐'));
    expect(screen.getByTestId('owner-preview')).toHaveTextContent('🔐Cy');
    await userEvent.click(screen.getByText('Create owner'));
    await waitFor(() => expect(changed).toHaveBeenCalled());
    expect(f.mock.calls[0][0]).toBe('/api/owners');
    expect(JSON.parse(f.mock.calls[0][1].body)).toEqual({ name: 'Cy', color: '#00ff00', icon: '🔐' });

    mockFetch(409, { error: { code: 'conflict', message: 'Owner name already exists' } });
    await userEvent.click(screen.getByText('Add owner', { selector: '.owners-list button' }));
    await userEvent.type(screen.getByLabelText('Name'), 'ann');
    await userEvent.click(screen.getByText('Create owner'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Owner name already exists');
  });

  it('edit sends null when colour and icon are reset', async () => {
    const f = mockFetch(200, { id: 1, name: 'Ann', color: null, icon: null });
    render(<OwnersPage graph={graph} onChanged={() => {}} onOpenModule={() => {}} />);
    await userEvent.click(screen.getByLabelText('Owner Ann'));
    await userEvent.click(screen.getByText('Edit'));
    expect(screen.getByLabelText('Icon')).toHaveValue('🧑');
    await userEvent.click(screen.getByText('Reset colour'));
    await userEvent.click(screen.getByText('Clear icon'));
    await userEvent.click(screen.getByText('Save owner'));
    await waitFor(() => expect(f).toHaveBeenCalled());
    expect(f.mock.calls[0][0]).toBe('/api/owners/1');
    expect(JSON.parse(f.mock.calls[0][1].body)).toEqual({ name: 'Ann', color: null, icon: null });
  });

  it('delete needs confirmation mentioning unassignment', async () => {
    const f = mockFetch(204);
    const changed = vi.fn();
    render(<OwnersPage graph={graph} onChanged={changed} onOpenModule={() => {}} />);
    await userEvent.click(screen.getByLabelText('Owner Ann'));
    await userEvent.click(screen.getByText('Edit'));
    await userEvent.click(screen.getByText('Delete owner'));
    expect(screen.getByRole('alertdialog')).toHaveTextContent(/unassigned from 2 module/);
    await userEvent.click(within(screen.getByRole('alertdialog')).getByText('Cancel'));
    expect(f).not.toHaveBeenCalled();
    await userEvent.click(screen.getByText('Delete owner'));
    await userEvent.click(screen.getByText('Confirm'));
    await waitFor(() => expect(changed).toHaveBeenCalled());
    expect(f.mock.calls[0][0]).toBe('/api/owners/1');
    expect(f.mock.calls[0][1].method).toBe('DELETE');
  });

  it('shows an empty state for an owner without modules', async () => {
    const g = { ...graph, modules: [] };
    render(<OwnersPage graph={g} onChanged={() => {}} onOpenModule={() => {}} />);
    await userEvent.click(screen.getByLabelText('Owner Bob'));
    expect(screen.getByText(/No modules assigned/)).toBeInTheDocument();
  });
});

describe('owner edit mode', () => {
  it('Edit opens the form; Cancel returns to the read-only view', async () => {
    render(<OwnersPage graph={graph} onChanged={() => {}} onOpenModule={() => {}} />);
    await userEvent.click(screen.getByLabelText('Owner Ann'));
    await userEvent.click(screen.getByText('Edit'));
    expect(screen.getByLabelText('Name')).toHaveValue('Ann');
    expect(screen.queryByLabelText('Open module Auth')).toBeNull();
    await userEvent.click(screen.getByText('Cancel', { selector: 'form button' }));
    expect(screen.queryByLabelText('Name')).toBeNull();
    expect(screen.getByLabelText('Open module Auth')).toBeInTheDocument();
  });

  it('Save returns to the read-only view', async () => {
    mockFetch(200, { id: 1, name: 'Ann', color: null, icon: null });
    render(<OwnersPage graph={graph} onChanged={() => {}} onOpenModule={() => {}} />);
    await userEvent.click(screen.getByLabelText('Owner Ann'));
    await userEvent.click(screen.getByText('Edit'));
    await userEvent.click(screen.getByText('Save owner'));
    await waitFor(() => expect(screen.queryByLabelText('Name')).toBeNull());
    expect(screen.getByText('Edit')).toBeInTheDocument();
  });
});

describe('hash routing', () => {
  it('parses hashes', () => {
    expect(parseHash('#/owners')).toBe('owners');
    expect(parseHash('#/groups')).toBe('groups');
    expect(parseHash('#/')).toBe('diagram');
    expect(parseHash('')).toBe('diagram');
  });
});

describe('fonts', () => {
  it('uses a monospace stack and no Caveat', () => {
    const css: string = readFileSync('src/styles.css', 'utf8');
    expect(css).toMatch(/--mono: 'JetBrains Mono'.*monospace/);
    expect(css).not.toMatch(/Caveat/i);
    expect(mainSrc).toContain('@fontsource/jetbrains-mono');
  });
});
