import { useEffect, useState } from 'react';

/**
 * A small router.
 *
 * `react-router` would be six components and a dependency for a console with five screens and no
 * nested layouts. This is the whole of what those screens need: the current path, a way to change
 * it without a reload, and the back button working.
 */

/** Paths the API serves. A click on one must leave the SPA rather than route inside it. */
const SERVER_PATHS = ['/auth', '/api', '/webhooks', '/healthz', '/readyz', '/health'];

export function usePath(): string {
  const [path, setPath] = useState(() => window.location.pathname);

  useEffect(() => {
    const onPop = () => { setPath(window.location.pathname); };
    window.addEventListener('popstate', onPop);
    // Anchors are intercepted here rather than replaced with a Link component, so `@d3cloud/ui`'s
    // own Link keeps working and nothing has to know it is inside a router.
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      const anchor = (event.target as HTMLElement | null)?.closest('a');
      if (anchor === null || anchor === undefined) return;

      const href = anchor.getAttribute('href');
      if (href === null || !href.startsWith('/')) return;
      if (anchor.target === '_blank' || anchor.hasAttribute('download')) return;
      // The server owns these, and they are real navigations — `/auth/oidc/start` redirects to the
      // identity provider. Intercepting one turns the D3 Auth button into a link that does nothing.
      if (SERVER_PATHS.some((prefix) => href === prefix || href.startsWith(`${prefix}/`))) return;

      event.preventDefault();
      window.history.pushState({}, '', href);
      setPath(href);
      window.scrollTo(0, 0);
    };
    document.addEventListener('click', onClick);

    return () => {
      window.removeEventListener('popstate', onPop);
      document.removeEventListener('click', onClick);
    };
  }, []);

  return path;
}

export interface Route {
  readonly screen: 'portfolio' | 'project' | 'phases' | 'phase' | 'task' | 'not-found';
  readonly code?: string;
  readonly humanId?: string;
}

export function routeFor(path: string): Route {
  const parts = path.split('/').filter((p) => p.length > 0);

  if (parts.length === 0) return { screen: 'portfolio' };

  if (parts[0] === 'projects' && parts[1] !== undefined) {
    const code = parts[1];
    if (parts[2] === undefined) return { screen: 'project', code };
    if (parts[2] === 'phases' && parts[3] === undefined) return { screen: 'phases', code };
    if (parts[2] === 'phases' && parts[3] !== undefined) {
      return { screen: 'phase', code, humanId: parts[3] };
    }
  }

  if (parts[0] === 'tasks' && parts[1] !== undefined) {
    return { screen: 'task', humanId: parts[1] };
  }

  return { screen: 'not-found' };
}
