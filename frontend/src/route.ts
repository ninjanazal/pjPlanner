import { useEffect, useRef, useState } from 'react';
import { hasDirtyModal } from './components/Modal';

export type Route = 'diagram' | 'owners' | 'groups' | 'issues' | 'sprints' | 'projects' | 'overview';

export function parseHash(hash: string): Route {
  const h = hash.replace(/^#/, '');
  return h.startsWith('/owners') ? 'owners' : h.startsWith('/groups') ? 'groups' : h.startsWith('/issues') ? 'issues' : h.startsWith('/sprints') ? 'sprints' : h.startsWith('/projects') ? 'projects' : h.startsWith('/overview') ? 'overview' : 'diagram';
}

// `#/issues/12` opens the page of issue 12 (still the 'issues' route); null for any other hash.
export function parseIssueId(hash: string): number | null {
  const m = /^#?\/issues\/(\d+)/.exec(hash);
  return m ? Number(m[1]) : null;
}
export const issueHash = (id: number) => `#/issues/${id}`;

// `#/owners/3` opens owner 3's page, `#/owners/new` the new-owner page; null for the list and any other hash.
export type OwnerRef = number | 'new';
export function parseOwnerRef(hash: string): OwnerRef | null {
  const m = /^#?\/owners\/(new|\d+)/.exec(hash);
  return !m ? null : m[1] === 'new' ? 'new' : Number(m[1]);
}
export const ownerHash = (id: OwnerRef) => `#/owners/${id}`;

// `#/groups/3` opens group 3's page, `#/groups/new` the new-group page; null for the list and any other hash.
export type GroupRef = number | 'new';
export function parseGroupRef(hash: string): GroupRef | null {
  const m = /^#?\/groups\/(new|\d+)/.exec(hash);
  return !m ? null : m[1] === 'new' ? 'new' : Number(m[1]);
}
export const groupHash = (id: GroupRef) => `#/groups/${id}`;

export function useHashRoute(): [Route, (r: Route) => void, number | null, OwnerRef | null, GroupRef | null] {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  const [issueId, setIssueId] = useState<number | null>(() => parseIssueId(window.location.hash));
  const [ownerRef, setOwnerRef] = useState<OwnerRef | null>(() => parseOwnerRef(window.location.hash));
  const [groupRef, setGroupRef] = useState<GroupRef | null>(() => parseGroupRef(window.location.hash));
  const lastHash = useRef(window.location.hash);
  useEffect(() => {
    const on = () => {
      const next = window.location.hash;
      // Back / edited hash must not silently discard a dirty popup: undo the navigation instead.
      if (hasDirtyModal() && (parseHash(next) !== parseHash(lastHash.current) || parseIssueId(next) !== parseIssueId(lastHash.current) || parseOwnerRef(next) !== parseOwnerRef(lastHash.current) || parseGroupRef(next) !== parseGroupRef(lastHash.current))) {
        window.location.replace(lastHash.current || '#/');
        return;
      }
      lastHash.current = next;
      setRoute(parseHash(next));
      setIssueId(parseIssueId(next));
      setOwnerRef(parseOwnerRef(next));
      setGroupRef(parseGroupRef(next));
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const go = (r: Route) => { window.location.hash = r === 'diagram' ? '#/' : `#/${r}`; };
  return [route, go, issueId, ownerRef, groupRef];
}
