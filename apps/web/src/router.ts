import { useCallback, useEffect, useState } from 'react';

export type Route =
  | { kind: 'home' }
  | { kind: 'note'; id: string }
  | { kind: 'folder'; id: string }
  | { kind: 'graph' }
  | { kind: 'settings'; tab?: string };

function parse(path: string): Route {
  if (path === '' || path === '/') return { kind: 'home' };
  let m = /^\/notes\/([^/]+)$/.exec(path);
  if (m) return { kind: 'note', id: m[1] };
  m = /^\/folders\/([^/]+)$/.exec(path);
  if (m) return { kind: 'folder', id: m[1] };
  if (path === '/graph') return { kind: 'graph' };
  m = /^\/settings(?:\/([^/]+))?$/.exec(path);
  if (m) return { kind: 'settings', tab: m[1] };
  return { kind: 'home' };
}

export function buildPath(r: Route): string {
  switch (r.kind) {
    case 'home':
      return '/';
    case 'note':
      return `/notes/${r.id}`;
    case 'folder':
      return `/folders/${r.id}`;
    case 'graph':
      return '/graph';
    case 'settings':
      return r.tab ? `/settings/${r.tab}` : '/settings';
  }
}

/** Mini router: sincroniza el estado con window.history (push + popstate). */
export function useRoute(): [Route, (r: Route, replace?: boolean) => void] {
  const [path, setPath] = useState(() =>
    typeof window === 'undefined' ? '/' : window.location.pathname,
  );

  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = useCallback((r: Route, replace = false) => {
    const p = buildPath(r);
    if (p === window.location.pathname) return;
    if (replace) window.history.replaceState(null, '', p);
    else window.history.pushState(null, '', p);
    setPath(p);
  }, []);

  return [parse(path), navigate];
}
