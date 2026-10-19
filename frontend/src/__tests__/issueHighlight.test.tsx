import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { cardHighlightClass, edgeHighlightClass, groupHighlightClass, normalizeHighlight } from '../highlight';
import { IssuesPanel } from '../components/IssuesPanel';
import { ModuleDialog } from '../components/ModuleDialog';
import type { Graph, Issue, Module } from '../types';

const mod = (id: number, name: string): Module => ({
  id, name, description: '', color: null, icon: null, apiItems: [],
  textColor: null, strokeColor: null, strokeStyle: 'solid', x: null, y: null, groupId: null,
});
const mk = (p: Partial<Issue> & Pick<Issue, 'id' | 'type' | 'title'>): Issue => ({
  description: '', parentId: null, ownerId: null, state: 'open', moduleId: null, sprintId: null, childIds: [], rollupModuleIds: [], ...p,
});
const modules = [mod(1, 'Auth'), mod(2, 'Billing')];
const issues = [
  mk({ id: 1, type: 'epic', title: 'Launch', moduleId: 1, rollupModuleIds: [1, 2] }),
  mk({ id: 2, type: 'task', title: 'Lonely' }),
  mk({ id: 3, type: 'task', title: 'Finished', state: 'closed', moduleId: 2 }),
];

describe('highlight mapping', () => {
  it('dims nothing without a selection or with 0 modules', () => {
    expect(normalizeHighlight(null)).toBeNull();
    expect(normalizeHighlight([])).toBeNull();
    expect(cardHighlightClass(null, 1)).toBe('');
    expect(groupHighlightClass(null)).toBe('');
  });
  it('rings touched cards and dims the rest', () => {
    const ids = normalizeHighlight([1])!;
    expect(cardHighlightClass(ids, 1)).toBe('hl-on');
    expect(cardHighlightClass(ids, 2)).toBe('hl-dim');
    expect(groupHighlightClass(ids)).toBe('hl-dim');
    expect(edgeHighlightClass(ids, 1, 2)).toBe('hl-dim');
    expect(edgeHighlightClass(normalizeHighlight(new Set([1, 2])), 1, 2)).toBe('');
  });
});

function Harness({ list = issues }: { list?: Issue[] }) {
  const [sel, setSel] = useState<number | null>(null);
  return <IssuesPanel issues={list} modules={modules} owners={[]} selectedId={list.some((i) => i.id === sel) ? sel : null} onSelect={setSel} onChanged={() => {}} />;
}

describe('IssuesPanel', () => {
  beforeEach(() => localStorage.clear());
  it('selects, toggles and clears, showing module count', async () => {
    render(<Harness />);
    expect(screen.queryByLabelText('Select issue Finished')).toBeNull();
    await userEvent.click(screen.getByLabelText('Select issue Launch'));
    expect(screen.getByText('2 modules touched')).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText('Select issue Launch'));
    expect(screen.queryByTestId('issue-selection')).toBeNull();
    await userEvent.click(screen.getByLabelText('Select issue Lonely'));
    expect(screen.getByText('0 modules')).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText('Clear selection'));
    expect(screen.queryByTestId('issue-selection')).toBeNull();
  });
  it('shows closed issues on toggle and opens the edit popup', async () => {
    render(<Harness />);
    await userEvent.click(screen.getByLabelText('Show closed'));
    expect(screen.getByLabelText('Select issue Finished')).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText('Select issue Launch'));
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(screen.getByText('Edit issue #1')).toBeInTheDocument();
  });
  it('clears selection when the issue vanishes and persists collapse', async () => {
    const { rerender } = render(<Harness />);
    await userEvent.click(screen.getByLabelText('Select issue Launch'));
    rerender(<Harness list={issues.slice(1)} />);
    expect(screen.queryByTestId('issue-selection')).toBeNull();
    await userEvent.click(screen.getByLabelText('Collapse issues'));
    expect(localStorage.getItem('pjplanner-issues-panel')).toBe('1');
    expect(screen.queryByLabelText('Select issue Lonely')).toBeNull();
  });
});

describe('ModuleDialog issues list', () => {
  const graph: Graph = { modules, owners: [], relations: [], groups: [] };
  it('lists issues linked to the module and hides the section when none', () => {
    const { unmount } = render(<ModuleDialog graph={graph} issues={issues} module={modules[1]} onChanged={() => {}} onClose={() => {}} />);
    const rows = screen.getAllByTestId('module-issue');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('#3');
    expect(rows[0]).toHaveTextContent('Finished');
    expect(rows[0]).toHaveTextContent('closed');
    unmount();
    render(<ModuleDialog graph={graph} issues={[issues[1]]} module={modules[1]} onChanged={() => {}} onClose={() => {}} />);
    expect(screen.queryByLabelText('Issues')).toBeNull();
  });
});
