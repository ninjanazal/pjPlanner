import { api } from '../api';
import type { Graph } from '../types';
import { EntityPage } from './EntityPage';

interface Props { graph: Graph; onChanged: () => void; onOpenModule: (id: number) => void }

export function OwnersPage({ graph, onChanged, onOpenModule }: Props) {
  const unassigned = graph.modules.filter((m) => m.ownerIds.length === 0);
  return (
    <EntityPage
      noun="owner" items={graph.owners} modules={graph.modules}
      membersOf={(id) => graph.modules.filter((m) => m.ownerIds.includes(id))}
      save={(id, v) => (id == null ? api.createOwner(v) : api.updateOwner(id, v))}
      remove={api.deleteOwner}
      deleteMessage={(o, n) => `Delete owner "${o.name}"? They will be unassigned from ${n} module(s); the modules are kept.`}
      emptyMembers="No modules assigned. Assign this owner from a module's panel on the diagram."
      footerHint={unassigned.length > 0 && (
        <p className="hint">{unassigned.length} module{unassigned.length === 1 ? ' has' : 's have'} no owner: {unassigned.map((m) => m.name).join(', ')}</p>
      )}
      onChanged={onChanged} onOpenModule={onOpenModule}
    />
  );
}
