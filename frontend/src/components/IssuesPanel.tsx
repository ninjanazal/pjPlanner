import { useState } from 'react';
import type { Issue, Module, Owner, Sprint } from '../types';
import { buildTree, hideClosed, type IssueNode } from '../issueTree';
import { QuickClose } from './QuickClose';
import { IssueDialog, StateBadge, TypeBadge } from './IssuesPage';

const KEY = 'pjplanner-issues-panel';
const readCollapsed = () => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } };

interface Props {
  issues: Issue[]; sprints?: Sprint[]; modules: Module[]; owners: Owner[];
  selectedId: number | null; onSelect: (id: number | null) => void; onChanged: () => void;
}

export function IssuesPanel({ issues, sprints = [], modules, owners, selectedId, onSelect, onChanged }: Props) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [showClosed, setShowClosed] = useState(false);
  const [editing, setEditing] = useState<Issue | null>(null);
  const toggle = () => setCollapsed((c) => {
    try { localStorage.setItem(KEY, c ? '0' : '1'); } catch { /* storage unavailable */ }
    return !c;
  });
  const all = buildTree(issues);
  const tree = showClosed ? all : hideClosed(all);
  const selected = issues.find((i) => i.id === selectedId);

  return (
    <aside className={`issues-panel${collapsed ? ' collapsed' : ''}`} aria-label="Issues panel">
      <div className="row between">
        <strong>Issues</strong>
        <button type="button" aria-expanded={!collapsed} aria-label={collapsed ? 'Expand issues' : 'Collapse issues'} onClick={toggle}>{collapsed ? '+' : '-'}</button>
      </div>
      {!collapsed && (
        <>
          <label className="check"><input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} />Show closed</label>
          {selected && (
            <div className="row wrap" data-testid="issue-selection">
              <span className="chip">#{selected.id} {selected.title}
                <button type="button" className="chip-x" aria-label="Clear selection" onClick={() => onSelect(null)}>x</button>
              </span>
              <span className="hint">{selected.rollupModuleIds.length === 1 ? '1 module touched' : selected.rollupModuleIds.length === 0 ? '0 modules' : `${selected.rollupModuleIds.length} modules touched`}</span>
              <button type="button" onClick={() => setEditing(selected)}>Open</button>
            </div>
          )}
          <div className="issues-panel-body">
            {tree.length === 0 && <p className="hint">No open issues.</p>}
            <ul className="issue-tree">
              {tree.map((n) => <Row key={n.issue.id} node={n} depth={0} selectedId={selectedId} onSelect={onSelect} onChanged={onChanged} />)}
            </ul>
          </div>
        </>
      )}
      {editing && (
        <IssueDialog key={editing.id} issue={editing} issues={issues} sprints={sprints} modules={modules} owners={owners}
          onClose={() => setEditing(null)} onChanged={() => { setEditing(null); onChanged(); }} />
      )}
    </aside>
  );
}

function Row({ node, depth, selectedId, onSelect, onChanged }: { node: IssueNode; depth: number; selectedId: number | null; onSelect: (id: number | null) => void; onChanged: () => void }) {
  const i = node.issue;
  const sel = i.id === selectedId;
  return (
    <li>
      <div className="issue-row" style={{ marginLeft: depth * 14 }}>
        <QuickClose issue={i} onChanged={onChanged} />
        <StateBadge state={i.state} />
        <TypeBadge type={i.type} />
        <span className="hint">#{i.id}</span>
        <button type="button" className={`issue-title${sel ? ' sel' : ''}`} aria-pressed={sel} aria-label={`Select issue ${i.title}`}
          onClick={() => onSelect(sel ? null : i.id)}>{i.title}</button>
      </div>
      {node.children.length > 0 && <ul>{node.children.map((c) => <Row key={c.issue.id} node={c} depth={depth + 1} selectedId={selectedId} onSelect={onSelect} onChanged={onChanged} />)}</ul>}
    </li>
  );
}
