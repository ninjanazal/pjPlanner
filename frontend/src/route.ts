import { useEffect, useRef, useState } from 'react';
import { hasDirtyModal } from './components/Modal';

export type Route = 'diagram' | 'owners' | 'groups' | 'issues' | 'sprints' | 'projects';

export function parseHash(hash: string): Route {
  const h = hash.replace(/^#/, '');
  return h.startsWith('/owners') ? 'owners' : h.startsWith('/groups') ? 'groups' : h.startsWith('/issues') ? 'issues' : h.startsWith('/sprints') ? 'sprints' : h.startsWith('/projects') ? 'projects' : 'diagram';
}

export function useHashRoute(): [Route, (r: Route) => void] {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  const lastHash = useRef(window.location.hash);
  useEffect(() => {
    const on = () => {
      const next = window.location.hash;
      // Back / edited hash must not silently discard a dirty popup: undo the navigation instead.
      if (hasDirtyModal() && parseHash(next) !== parseHash(lastHash.current)) {
        window.location.replace(lastHash.current || '#/');
        return;
      }
      lastHash.current = next;
      setRoute(parseHash(next));
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const go = (r: Route) => { window.location.hash = r === 'diagram' ? '#/' : `#/${r}`; };
  return [route, go];
}
