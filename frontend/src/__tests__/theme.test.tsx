import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useTheme } from '../theme';

function Probe() {
  const { theme, toggle } = useTheme();
  return <button onClick={toggle}>{theme}</button>;
}

describe('theme', () => {
  beforeEach(() => localStorage.clear());

  it('defaults to dark, toggles, persists and applies data-theme', async () => {
    const { unmount } = render(<Probe />);
    expect(screen.getByRole('button')).toHaveTextContent('dark');
    await userEvent.click(screen.getByRole('button'));
    expect(screen.getByRole('button')).toHaveTextContent('light');
    expect(localStorage.getItem('pjplanner-theme')).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    unmount();
    render(<Probe />);
    expect(screen.getByRole('button')).toHaveTextContent('light');
  });

  it('uses prefers-color-scheme when nothing saved', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    render(<Probe />);
    expect(screen.getByRole('button')).toHaveTextContent('light');
    vi.unstubAllGlobals();
  });
});
