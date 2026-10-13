import { api } from '../api';
import type { Graph } from '../types';
import { EntityPage } from './EntityPage';

interface Props { graph: Graph; onChanged: () => void; onOpenModule: (id: number) => void }

export function GroupsPage({ graph, onChanged, onOpenModule }: Props) {
  return (
    <EntityPage
      noun="group" items={graph.groups ?? []} groups={graph.groups ?? []} modules={graph.modules}
      membersOf={(id) => graph.modules.filter((m) => m.groupId === id)}
      save={(id, v) => (id == null ? api.createGroup(v) : api.updateGroup(id, v))}
      remove={api.deleteGroup}
      deleteMessage={(g, n) => `Delete group "${g.name}"? Its child groups move up one level, its ${n} module(s) become ungrouped, and no modules are deleted.`}
      emptyMembers="No modules in this group. Set a module's Group in its panel on the diagram."
      onChanged={onChanged} onOpenModule={onOpenModule}
    />
  );
}
