import { Modal } from './Modal';

interface Props {
  message: string; onConfirm: () => void; onCancel: () => void;
  title?: string; confirmLabel?: string; cancelLabel?: string;
}

export function ConfirmDialog({ message, onConfirm, onCancel, title = 'Confirm deletion', confirmLabel = 'Confirm', cancelLabel = 'Cancel' }: Props) {
  return (
    <Modal title={title} role="alertdialog" size="sm" onClose={onCancel}>
      <p className="confirm-msg">{message}</p>
      <div className="row modal-actions">
        <button data-autofocus onClick={onCancel}>{cancelLabel}</button>
        <button className="danger" onClick={onConfirm}>{confirmLabel}</button>
      </div>
    </Modal>
  );
}
