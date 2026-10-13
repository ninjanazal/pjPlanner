import { useState } from 'react';
import { api } from '../api';
import { withState } from '../sprintGroups';
import type { Issue } from '../types';

// One-click close / reopen. Closed issues are kept (in their sprint, or under "Closed"), never deleted.
export function QuickClose({ issue, onChanged }: { issue: Issue; onChanged: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  const closed = issue.state === 'closed';
  const click = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setErr(null);
    try { await api.updateIssue(issue.id, withState(issue, closed ? 'open' : 'closed')); onChanged(); }
    catch (x) { setErr((x as Error).message); }
  };
  return (
    <button type="button" className={`quick-close${closed ? ' is-closed' : ''}`} aria-label={`${closed ? 'Reopen' : 'Close'} issue ${issue.title}`}
      title={err ?? (closed ? 'Reopen' : 'Mark as done')} onClick={click}>{err ? '⚠' : closed ? '↺' : '✓'}</button>
  );
}
