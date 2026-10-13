import { act, render, screen, waitFor } from '@testing-library/react';
import { Modal } from '../components/Modal';
import { useHashRoute } from '../route';

function Host({ dirty }: { dirty: boolean }) {
  const [route] = useHashRoute();
  return <div>route:{route}{route === 'diagram' && <Modal title="Edit" dirty={dirty} onClose={() => {}}><input aria-label="f" /></Modal>}</div>;
}
const navigate = (hash: string) => act(async () => { window.location.hash = hash; await new Promise((r) => setTimeout(r, 20)); });

describe('route guard', () => {
  beforeEach(() => { window.location.hash = '#/'; });
  it('keeps a dirty popup open and restores the hash on navigation away', async () => {
    render(<Host dirty />);
    await navigate('#/owners');
    await waitFor(() => expect(window.location.hash).toBe('#/'));
    expect(screen.getByText('route:diagram', { exact: false })).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
  it('navigates normally when the popup is clean', async () => {
    render(<Host dirty={false} />);
    await navigate('#/owners');
    expect(screen.getByText('route:owners')).toBeInTheDocument();
  });
});
