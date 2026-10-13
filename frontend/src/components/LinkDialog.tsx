import { useState } from 'react';
import { api } from '../api';
import type { Graph, Relation } from '../types';
import { ConfirmDialog } from './ConfirmDialog';
import { ColorField } from './LookFields';
import { Modal } from './Modal';
import type { Theme } from '../theme';
import { useAction } from './useAction';

interface Props { graph: Graph; relation: Relation; onChanged: () => void; onClose: () => void; theme?: Theme }

export function LinkDialog({ graph, relation, onChanged, onClose, theme = 'dark' }: Props) {
  const [label, setLabel] = useState(relation.label ?? '');
  const [color, setColor] = useState<string | null>(relation.color ?? null);
  const [confirming, setConfirming] = useState(false);
  const { error, run } = useAction();
  const nameOf = (id: number) => graph.modules.find((m) => m.id === id)?.name ?? `#${id}`;
  const dirty = label !== (relation.label ?? '') || color !== (relation.color ?? null);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (await run(() => api.updateRelation(relation.id, { label: label.trim() || null, color }))) onChanged();
  };
  const remove = async () => {
    setConfirming(false);
    if (await run(() => api.deleteRelation(relation.id))) onChanged();
  };

  return (
    <Modal title="Edit link" dirty={dirty} onClose={onClose} size="sm">
      <p className="link-ends"><strong>{nameOf(relation.sourceId)}</strong> &rarr; <strong>{nameOf(relation.targetId)}</strong></p>
      <form onSubmit={save}>
        <label>Label<input value={label} onChange={(e) => setLabel(e.target.value)} /></label>
        <ColorField label="Arrow colour" value={color} onChange={setColor} theme={theme} />
        {error && <p className="error" role="alert">{error}</p>}
        <div className="row modal-actions">
          <button type="submit" className="primary">Save</button>
          <button type="button" className="danger" onClick={() => setConfirming(true)}>Delete</button>
        </div>
      </form>
      {confirming && (
        <ConfirmDialog
          message="Delete this link? The two modules are kept; only the relation between them is removed."
          onConfirm={remove}
          onCancel={() => setConfirming(false)}
        />
      )}
    </Modal>
  );
}
