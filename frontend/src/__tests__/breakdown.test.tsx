import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BreakdownDialog } from '../components/BreakdownDialog';
import { childTypes } from '../issueTree';
import type { Issue, Module } from '../types';

const mod = (id: number, name: string): Module => ({
  id, name, description: '', ownerIds: [], color: null, icon: null, apiItems: [],
  textColor: null, strokeColor: null, strokeStyle: 'solid', x: null, y: null, groupId: null,
});
const epic: Issue = { id: 7, type: 'epic', title: 'Launch', description: '', parentId: null, ownerId: null, state: 'open', moduleId: null, sprintId: null, childIds: [], rollupModuleIds: [] };
afterEach(() => vi.unstubAllGlobals());

describe('breakdown', () => {
  it('knows what each type can contain', () => {
    expect(childTypes('epic')).toEqual(['story', 'bug', 'task']);
    expect(childTypes('story')).toEqual(['task']);
    expect(childTypes('bug')).toEqual(['task']);
    expect(childTypes('task')).toEqual([]);
  });
  it('creates one child per filled row with its module, skipping blanks', async () => {
    const f = vi.fn().mockResolvedValue({ status: 201, ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', f);
    const changed = vi.fn();
    render(<BreakdownDialog parent={epic} modules={[mod(1, 'Auth'), mod(2, 'Billing')]} owners={[]} onClose={() => {}} onChanged={changed} />);
    await userEvent.type(screen.getByLabelText('Title 1'), 'Login form');
    await userEvent.click(within(screen.getByRole('group', { name: 'Module 1' })).getByText('Auth'));
    await userEvent.type(screen.getByLabelText('Title 2'), 'Invoices');
    await userEvent.click(within(screen.getByRole('group', { name: 'Module 2' })).getByText('Billing'));
    await userEvent.click(screen.getByText('Create 2 issues'));
    await waitFor(() => expect(changed).toHaveBeenCalled());
    expect(f).toHaveBeenCalledTimes(2);
    expect(JSON.parse(f.mock.calls[0][1].body)).toMatchObject({ type: 'task', title: 'Login form', parentId: 7, moduleId: 1 });
    expect(JSON.parse(f.mock.calls[1][1].body)).toMatchObject({ title: 'Invoices', moduleId: 2 });
  });
});
