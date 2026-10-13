import { act, render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { ColorField, EMOJI } from '../components/LookFields';
import { ModuleDialog } from '../components/ModuleDialog';
import { EntityPage } from '../components/EntityPage';
import { addSavedColor, removeSavedColor, getSavedColors, useSavedColors, SAVED_COLORS_KEY } from '../savedColors';
import type { Graph } from '../types';

beforeEach(() => { localStorage.clear(); act(() => { window.dispatchEvent(new Event('storage')); }); });
afterEach(() => vi.restoreAllMocks());

describe('savedColors store', () => {
  it('adds newest first, dedupes case-insensitively, lowercases, persists', () => {
    addSavedColor('#AABBCC'); addSavedColor('#112233'); addSavedColor('#aabbcc');
    expect(getSavedColors()).toEqual(['#aabbcc', '#112233']);
    expect(JSON.parse(localStorage.getItem(SAVED_COLORS_KEY)!)).toEqual(['#aabbcc', '#112233']);
  });
  it('caps at 24 and removes', () => {
    for (let i = 0; i < 30; i++) addSavedColor('#' + i.toString(16).padStart(6, '0'));
    expect(getSavedColors()).toHaveLength(24);
    expect(getSavedColors()[0]).toBe('#00001d');
    removeSavedColor('#00001D');
    expect(getSavedColors()).toHaveLength(23);
  });
  it('tolerates corrupt and unavailable storage', () => {
    localStorage.setItem(SAVED_COLORS_KEY, '{nope');
    expect(getSavedColors()).toEqual([]);
    localStorage.setItem(SAVED_COLORS_KEY, JSON.stringify(['#abc', 5, '#ABCDEF']));
    expect(getSavedColors()).toEqual(['#abcdef']);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('x'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('x'); });
    expect(getSavedColors()).toEqual([]);
    expect(() => addSavedColor('#123456')).not.toThrow();
  });
  it('hook updates on storage events', () => {
    const { result } = renderHook(() => useSavedColors());
    expect(result.current).toEqual([]);
    act(() => { localStorage.setItem(SAVED_COLORS_KEY, '["#010203"]'); window.dispatchEvent(new Event('storage')); });
    expect(result.current).toEqual(['#010203']);
  });
});

function Host({ initial }: { initial: string | null }) {
  const [v, setV] = useState<string | null>(initial);
  return <><ColorField value={v} onChange={setV} /><output data-testid="v">{v ?? 'null'}</output></>;
}

describe('ColorField saved colours', () => {
  it('Save colour is disabled for null and already-saved values; saving keeps the value', async () => {
    const { unmount } = render(<Host initial={null} />);
    expect(screen.getByText('Save colour')).toBeDisabled();
    unmount();
    render(<Host initial="#ABCDEF" />);
    await userEvent.click(screen.getByText('Save colour'));
    expect(screen.getByText('Save colour')).toBeDisabled();
    expect(screen.getByTestId('v')).toHaveTextContent('#ABCDEF');
    expect(getSavedColors()).toEqual(['#abcdef']);
  });
  it('swatch click sets the value; x removes it', async () => {
    addSavedColor('#112233');
    render(<Host initial={null} />);
    await userEvent.click(screen.getByLabelText('Use saved colour #112233'));
    expect(screen.getByTestId('v')).toHaveTextContent('#112233');
    await userEvent.click(screen.getByLabelText('Remove saved colour #112233'));
    expect(screen.queryByLabelText('Remove saved colour #112233')).toBeNull();
  });
});

const graph: Graph = { owners: [], modules: [], relations: [], groups: [] };
const mod = { id: 1, name: 'A', description: '', ownerIds: [], color: null, icon: null, apiItems: [], textColor: null, strokeColor: null, strokeStyle: 'solid' as const, x: null, y: null, groupId: null };

describe('random icon on create', () => {
  it('ModuleDialog: create pre-fills, edit of icon-less module stays blank, pristine create closes without prompt', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const onClose = vi.fn();
    const { unmount } = render(<ModuleDialog graph={graph} module={null} onChanged={() => {}} onClose={onClose} />);
    expect(screen.getByLabelText('Icon')).toHaveValue(EMOJI[0]);
    await userEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByText('Discard changes?')).toBeNull();
    expect(onClose).toHaveBeenCalled();
    unmount();
    render(<ModuleDialog graph={{ ...graph, modules: [mod] }} module={mod} onChanged={() => {}} onClose={() => {}} />);
    await userEvent.click(screen.getByText('Edit'));
    expect(screen.getByLabelText('Icon')).toHaveValue('');
  });
  it('EntityPage: create pre-fills, edit stays blank', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.999);
    const props = { noun: 'owner' as const, modules: [], membersOf: () => [], save: vi.fn(), remove: vi.fn(), deleteMessage: () => '', emptyMembers: '', onChanged: () => {}, onOpenModule: () => {} };
    render(<EntityPage {...props} items={[{ id: 1, name: 'Ann', color: null, icon: null }]} />);
    await userEvent.click(screen.getByText(/^Add owner|^\+ ?Add/));
    expect(screen.getByLabelText('Icon')).toHaveValue(EMOJI[EMOJI.length - 1]);
    await userEvent.click(screen.getByText('Cancel'));
    await userEvent.click(screen.getByLabelText('Owner Ann'));
    await userEvent.click(screen.getByText(/^Edit/));
    expect(screen.getByLabelText('Icon')).toHaveValue('');
  });
});
