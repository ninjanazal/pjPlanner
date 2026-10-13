import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { Modal } from '../components/Modal';
import { ModuleDialog } from '../components/ModuleDialog';
import { LinkDialog } from '../components/LinkDialog';
import type { Graph } from '../types';

function Host({ dirty = false, onClose = () => {} }: { dirty?: boolean; onClose?: () => void }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button onClick={() => setOpen(true)}>opener</button>
      {open && (
        <Modal title="Hello" dirty={dirty} onClose={() => { onClose(); setOpen(false); }}>
          <input aria-label="first" /><button>second</button>
        </Modal>
      )}
    </>
  );
}

describe('Modal', () => {
  it('is a labelled modal dialog', () => {
    render(<Host />);
    const d = screen.getByRole('dialog', { name: 'Hello' });
    expect(d).toHaveAttribute('aria-modal', 'true');
  });
  it('closes on Esc, the close button and a backdrop click, but not on clicks inside', async () => {
    const onClose = vi.fn();
    render(<Host onClose={onClose} />);
    await userEvent.click(screen.getByText('second'));
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    await userEvent.click(screen.getByText('opener'));
    await userEvent.click(screen.getByLabelText('Close'));
    expect(onClose).toHaveBeenCalledTimes(2);
    await userEvent.click(screen.getByText('opener'));
    fireEvent.mouseDown(screen.getByTestId('modal-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(3);
  });
  it('asks before discarding when dirty, and keeps the dialog on "Keep editing"', async () => {
    const onClose = vi.fn();
    render(<Host dirty onClose={onClose} />);
    await userEvent.keyboard('{Escape}');
    const confirm = screen.getByRole('alertdialog');
    expect(onClose).not.toHaveBeenCalled();
    // Esc on the confirm closes only the confirm
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Hello' })).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByTestId('modal-backdrop'));
    await userEvent.click(within(screen.getByRole('alertdialog')).getByText('Discard'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(confirm).not.toBeInTheDocument();
  });
  it('stacks a confirm above the popup', async () => {
    render(<Host dirty />);
    await userEvent.keyboard('{Escape}');
    const z = (el: HTMLElement) => Number(el.closest<HTMLElement>('.overlay')!.style.zIndex);
    expect(z(screen.getByRole('alertdialog'))).toBeGreaterThan(z(screen.getByRole('dialog', { name: 'Hello' })));
  });
  it('moves focus in, traps Tab, and restores focus on close', async () => {
    render(<Host />);
    const opener = screen.getByText('opener');
    opener.focus();
    await userEvent.keyboard('{Escape}');
    expect(opener).toHaveFocus();
    await userEvent.click(opener);
    const d = screen.getByRole('dialog');
    expect(d).toContainElement(document.activeElement as HTMLElement);
    for (let i = 0; i < 6; i++) { await userEvent.tab(); expect(d).toContainElement(document.activeElement as HTMLElement); }
    await userEvent.tab({ shift: true });
    expect(d).toContainElement(document.activeElement as HTMLElement);
  });
});

const mod = (over = {}) => ({ id: 1, name: 'Auth', description: 'Handles login', ownerIds: [1], color: null, icon: '🔐', apiItems: [{ id: 5, kind: 'endpoint' as const, name: 'login', signature: 'POST /login', description: '' }], textColor: null, strokeColor: null, strokeStyle: 'solid' as const, x: null, y: null, groupId: 7, ...over });
const graph: Graph = {
  owners: [{ id: 1, name: 'Ann', color: '#ff0000', icon: '🧑' }],
  modules: [mod(), mod({ id: 2, name: 'Billing', apiItems: [], groupId: null })],
  relations: [{ id: 3, sourceId: 1, targetId: 2, label: 'uses', color: null }],
  groups: [{ id: 7, name: 'Core', color: '#0000ff', icon: '🧱', parentId: null }],
};

describe('ModuleDialog read vs edit', () => {
  it('opens read-only with header, group chip, API, owners and description, then switches to edit', async () => {
    render(<ModuleDialog graph={graph} module={graph.modules[0]} onChanged={() => {}} onClose={() => {}} />);
    const d = screen.getByRole('dialog', { name: /Auth/ });
    expect(within(d).getByText('Core')).toHaveClass('chip');
    expect(within(d).getByLabelText('API overview')).toBeInTheDocument();
    expect(within(d).getByText('Ann')).toHaveClass('chip');
    expect(within(d).getByText('Handles login')).toBeInTheDocument();
    expect(screen.queryByLabelText('Name')).toBeNull();
    await userEvent.click(screen.getByText('Edit'));
    expect(screen.getByLabelText('Name')).toHaveValue('Auth');
    expect(screen.getByRole('dialog', { name: 'Edit Auth' })).toBeInTheDocument();
    expect(screen.getByText('Save')).toBeInTheDocument();
    expect(screen.getByText('Delete')).toBeInTheDocument();
  });
  it('opens a new module straight in edit mode', () => {
    render(<ModuleDialog graph={graph} module={null} onChanged={() => {}} onClose={() => {}} />);
    expect(screen.getByRole('dialog', { name: 'New module' })).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toBeInTheDocument();
  });
  it('Cancel returns to read mode; with edits it confirms the discard first', async () => {
    const onClose = vi.fn();
    render(<ModuleDialog graph={graph} module={graph.modules[0]} onChanged={() => {}} onClose={onClose} />);
    await userEvent.click(screen.getByText('Edit'));
    await userEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByLabelText('Name')).toBeNull();
    await userEvent.click(screen.getByText('Edit'));
    await userEvent.type(screen.getByLabelText('Name'), 'X');
    await userEvent.click(screen.getByText('Cancel'));
    expect(screen.getByLabelText('Name')).toHaveValue('AuthX');
    await userEvent.click(screen.getByText('Discard'));
    expect(screen.queryByLabelText('Name')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });
  it('Esc with unsaved edits asks to discard before closing the popup', async () => {
    const onClose = vi.fn();
    render(<ModuleDialog graph={graph} module={graph.modules[0]} onChanged={() => {}} onClose={onClose} />);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1); // clean view mode closes at once
    await userEvent.click(screen.getByText('Edit'));
    await userEvent.type(screen.getByLabelText('Name'), 'X');
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByText('Discard'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe('LinkDialog popup', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('shows both ends, is a labelled dialog and guards dirty edits', async () => {
    const onClose = vi.fn();
    render(<LinkDialog graph={graph} relation={graph.relations[0]} onChanged={() => {}} onClose={onClose} />);
    expect(screen.getByRole('dialog', { name: 'Edit link' })).toHaveTextContent('Auth → Billing');
    await userEvent.type(screen.getByLabelText('Label'), '!');
    await userEvent.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.click(screen.getByText('Discard'));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('group chip', () => {
  const m = {
    id: 1, name: 'Alpha', description: 'saved desc', ownerIds: [], color: null, icon: null, apiItems: [],
    textColor: null, strokeColor: null, strokeStyle: 'solid' as const, x: 5, y: 6, groupId: 1,
  };
  const g: Graph = { owners: [], relations: [], modules: [m], groups: [{ id: 1, name: 'Billing', color: null, icon: null, parentId: null }] };
  const stub = (status: number, body?: unknown) => {
    const f = vi.fn().mockResolvedValue({ status, ok: status < 400, json: async () => body });
    vi.stubGlobal('fetch', f);
    return f;
  };
  afterEach(() => vi.unstubAllGlobals());

  it('x ungroups immediately with the saved values and no confirm', async () => {
    const f = stub(200, { ...m, groupId: null });
    const changed = vi.fn();
    render(<ModuleDialog graph={g} module={m} onChanged={changed} onClose={() => {}} />);
    await userEvent.click(screen.getByLabelText('Remove from group'));
    await vi.waitFor(() => expect(changed).toHaveBeenCalledWith(1));
    expect(f.mock.calls[0][0]).toBe('/api/modules/1');
    expect(JSON.parse(f.mock.calls[0][1].body)).toMatchObject({ name: 'Alpha', description: 'saved desc', groupId: null });
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
  it('ignores unsaved form edits and shows a failure inline', async () => {
    stub(500, { error: { code: 'error', message: 'Boom' } });
    const changed = vi.fn();
    render(<ModuleDialog graph={g} module={m} onChanged={changed} onClose={() => {}} />);
    await userEvent.click(screen.getByLabelText('Remove from group'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Boom');
    expect(changed).not.toHaveBeenCalled();
  });
  it('edit mode has no chip x; the Group select can pick None and saves groupId null', async () => {
    const f = stub(200, { ...m, groupId: null });
    render(<ModuleDialog graph={g} module={m} onChanged={() => {}} onClose={() => {}} />);
    await userEvent.click(screen.getByText('Edit'));
    expect(screen.queryByLabelText('Remove from group')).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText('Group'), 'None');
    await userEvent.click(screen.getByText('Save'));
    await vi.waitFor(() => expect(f).toHaveBeenCalled());
    expect(JSON.parse(f.mock.calls[0][1].body)).toMatchObject({ groupId: null });
  });
});
