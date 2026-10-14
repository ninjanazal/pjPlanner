import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { randomColor } from '../randomColor';
import { ColorField } from '../components/LookFields';

describe('randomColor', () => {
  it('always returns a #rrggbb string', () => {
    for (const r of [0, 0.25, 0.5, 0.75, 0.999]) expect(randomColor(() => r)).toMatch(/^#[0-9a-f]{6}$/);
  });
  it('maps the hue range onto different colours', () => {
    const rgb = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
    const [r0, g0, b0] = rgb(randomColor(() => 0)); // red end
    expect(r0).toBeGreaterThan(g0); expect(r0).toBeGreaterThan(b0);
    const [r1, g1, b1] = rgb(randomColor(() => 1 / 3)); // green
    expect(g1).toBeGreaterThan(r1); expect(g1).toBeGreaterThan(b1);
    const [r2, g2, b2] = rgb(randomColor(() => 2 / 3)); // blue
    expect(b2).toBeGreaterThan(r2); expect(b2).toBeGreaterThan(g2);
  });
});

describe('ColorField random button', () => {
  it('sets a random colour, also when none is set yet', async () => {
    const onChange = vi.fn();
    render(<ColorField value={null} onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: 'Random colour' }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toMatch(/^#[0-9a-f]{6}$/);
  });
  it('is named after the field it belongs to', () => {
    render(<ColorField label="Text colour" value="#112233" onChange={() => {}} />);
    expect(screen.getByRole('button', { name: 'Random text colour' })).toBeEnabled();
  });
});
