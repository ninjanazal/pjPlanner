import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EstimatePicker } from '../components/EstimatePicker';
import { POKER_CARDS } from '../estimate';

describe('EstimatePicker', () => {
  it('offers the poker cards, super easy to super hard', () => {
    render(<EstimatePicker value={null} onChange={() => {}} />);
    expect(POKER_CARDS).toEqual([1, 2, 3, 5, 8, 10]);
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['1super easy', '2easy', '3small', '5medium', '8hard', '10super hard']);
  });
  it('picks a card and clears it when clicked again', async () => {
    const change = vi.fn();
    const { rerender } = render(<EstimatePicker value={null} onChange={change} />);
    await userEvent.click(screen.getByRole('button', { name: /^8/ }));
    expect(change).toHaveBeenLastCalledWith(8);
    rerender(<EstimatePicker value={8} onChange={change} />);
    expect(screen.getByRole('button', { name: /^8/ })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByRole('button', { name: /^8/ }));
    expect(change).toHaveBeenLastCalledWith(null);
  });
  it('keeps an older off-scale value visible as a custom card', () => {
    render(<EstimatePicker value={13} onChange={() => {}} />);
    expect(screen.getByRole('button', { name: /^13/ })).toHaveAttribute('aria-pressed', 'true');
  });
});
