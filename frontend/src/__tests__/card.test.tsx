import { render, screen } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { ModuleCard } from '../components/ModuleCard';
import { CARD_BASE_H, CARD_MAX_W, CARD_MIN_W, cardHeight, cardWidth } from '../layout';

const renderCard = (data: any, selected = false) =>
  render(<ReactFlowProvider><ModuleCard {...({ data, selected } as any)} /></ReactFlowProvider>);

describe('ModuleCard', () => {
  it('shows name, owners and api count', () => {
    renderCard({ name: 'Wallet', owners: ['Jose', 'Pedro'], color: null, icon: '💰', apiItems: [{ kind: 'function', name: 'a', signature: '' }, { kind: 'type', name: 'b', signature: '' }] });
    expect(screen.getByText(/Wallet/)).toBeInTheDocument();
    expect(screen.getByText('Owners: Jose, Pedro')).toBeInTheDocument();
    expect(screen.getByText('2 API items')).toBeInTheDocument();
    expect(screen.queryAllByTestId('card-api-row')).toHaveLength(0);
  });
  it('shows owner icons in the owners line', () => {
    renderCard({ name: 'W', owners: ['🧑 Ann', 'Bob'], color: null, icon: null, apiItems: [] });
    expect(screen.getByText('Owners: 🧑 Ann, Bob')).toHaveAttribute('title', 'Owners: 🧑 Ann, Bob');
  });
  it('uses a placeholder without owners and tints with the module colour', () => {
    renderCard({ name: 'Solo', owners: [], color: '#ff0000', icon: null, apiItems: [] });
    expect(screen.getByText('Owners: -')).toBeInTheDocument();
    expect(screen.getByTestId('module-card').style.getPropertyValue('--card-bg')).toBe('#ff0000');
  });
  it('applies text colour, stroke colour and stroke style', () => {
    renderCard({ name: 'S', owners: [], color: null, icon: null, apiItems: [], textColor: '#112233', strokeColor: '#445566', strokeStyle: 'dashed' });
    const st = screen.getByTestId('module-card').style;
    expect(st.getPropertyValue('--card-fg')).toBe('#112233');
    expect(st.getPropertyValue('--card-bc')).toBe('#445566');
    expect(st.getPropertyValue('--card-bs')).toBe('dashed');
  });
  it('keeps long names on one truncated line with a title and bounded width', () => {
    const name = 'A'.repeat(80);
    renderCard({ name, owners: ['x'], color: null, icon: null, apiItems: [] });
    expect(screen.getByTitle(name)).toHaveClass('card-name');
    expect(screen.getByTestId('module-card').style.width).toBe(`${CARD_MAX_W}px`);
    expect(cardWidth('Hi')).toBe(CARD_MIN_W);
    expect(cardWidth('LedStrips Controler Service', '💡')).toBeGreaterThan(CARD_MIN_W);
    expect(cardWidth('LedStrips Controler Service', '💡')).toBeLessThan(CARD_MAX_W);
  });
  it('adds no style overrides by default', () => {
    renderCard({ name: 'D', owners: [], color: null, icon: null, apiItems: [], textColor: null, strokeColor: null, strokeStyle: 'solid' });
    expect(screen.getByTestId('module-card').getAttribute('style')).not.toMatch(/--card/);
  });
  it('opens the full api list with method and signature tooltip when selected', () => {
    const items = [{ kind: 'endpoint', name: 'POST /login', signature: 'POST /login (u,p)' },
      ...Array.from({ length: 6 }, (_, i) => ({ kind: 'function', name: `f${i}`, signature: `f${i}()` }))];
    renderCard({ name: 'A', owners: [], color: null, icon: null, apiItems: items }, true);
    expect(screen.getAllByTestId('card-api-row')).toHaveLength(7);
    expect(screen.getByText('POST')).toHaveClass('m-POST');
    expect(screen.getByTitle('POST /login: POST /login (u,p)')).toBeInTheDocument();
  });
  it('card height grows with rows, capped at 5 plus the more row', () => {
    expect(cardHeight(0)).toBe(CARD_BASE_H);
    expect(cardHeight(3)).toBeGreaterThan(cardHeight(1));
    expect(cardHeight(5)).toBeLessThan(cardHeight(6));
    expect(cardHeight(6)).toBe(cardHeight(50));
  });
});
