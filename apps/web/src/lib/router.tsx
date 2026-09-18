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

/** Where we are: the path that chooses the screen, and the query that configures it. */
export interface Location {
  readonly path: string;
  /** The raw query string, `?uncovered=true` or empty. A filtered link is a shareable link. */
  readonly search: string;
}

export function useLocation(): Location {
  const [href, setHref] = useState(() => window.location.pathname + window.location.search);

  useEffect(() => {
    const onPop = () => { setHref(window.location.pathname + window.location.search); };
    window.addEventListener('popstate', onPop);
    // Anchors are intercepted here rather than replaced with a Link component, so `@d3cloud/ui`'s
    // own Link keeps working and nothing has to know it is inside a router.
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      const anchor = (event.target as HTMLElement | null)?.closest('a');
      if (anchor === null || anchor === undefined) return;

      // Named `to`, not `href`: the state above is also called that, and a shadow here would be
      // a line that reads correctly and means something else.
      const to = anchor.getAttribute('href');
      if (to === null || !to.startsWith('/')) return;
      if (anchor.target === '_blank' || anchor.hasAttribute('download')) return;
      // The server owns these, and they are real navigations — `/auth/oidc/start` redirects to the
      // identity provider. Intercepting one turns the D3 Auth button into a link that does nothing.
      if (SERVER_PATHS.some((prefix) => to === prefix || to.startsWith(`${prefix}/`))) return;

      event.preventDefault();
      window.history.pushState({}, '', to);
      setHref(to);
      window.scrollTo(0, 0);
    };
    document.addEventListener('click', onClick);

    return () => {
      window.removeEventListener('popstate', onPop);
      document.removeEventListener('click', onClick);
    };
  }, []);

  const index = href.indexOf('?');
  return index === -1
    ? { path: href, search: '' }
    : { path: href.slice(0, index), search: href.slice(index) };
}

/** The path alone, for the screens that do not care about the query. */
export function usePath(): string {
  return useLocation().path;
}

export interface Route {
  readonly screen:
    | 'portfolio'
    | 'project'
    | 'phases'
    | 'phase'
    | 'requirements'
    | 'requirement'
    | 'scope-of-work'
    | 'register'
    | 'documents'
    | 'document'
    | 'adrs'
    | 'risks'
    | 'glossary'
    | 'audits'
    | 'activity'
    | 'search'
    | 'task'
    | 'not-found';
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
    if (parts[2] === 'requirements' && parts[3] === undefined) {
      return { screen: 'requirements', code };
    }
    // The two generated registers (ADR-006). Paths, not document IDs: there is no document.
    if (parts[2] === 'scope-of-work' && parts[3] === undefined) {
      return { screen: 'scope-of-work', code };
    }
    if (parts[2] === 'register' && parts[3] === undefined) return { screen: 'register', code };
    if (parts[2] === 'risks' && parts[3] === undefined) return { screen: 'risks', code };
    if (parts[2] === 'glossary' && parts[3] === undefined) return { screen: 'glossary', code };
    if (parts[2] === 'adrs' && parts[3] === undefined) return { screen: 'adrs', code };
    if (parts[2] === 'audits' && parts[3] === undefined) return { screen: 'audits', code };
    if (parts[2] === 'activity' && parts[3] === undefined) return { screen: 'activity', code };
    if (parts[2] === 'documents') {
      return parts[3] === undefined
        ? { screen: 'documents', code }
        : { screen: 'document', code, humanId: parts[3] };
    }
  }

  if (parts[0] === 'search' && parts[1] === undefined) return { screen: 'search' };

  if (parts[0] === 'tasks' && parts[1] !== undefined) {
    return { screen: 'task', humanId: parts[1] };
  }

  // A requirement is reached by ID alone: the ID already carries its project (ADR-008).
  if (parts[0] === 'requirements' && parts[1] !== undefined) {
    return { screen: 'requirement', humanId: parts[1] };
  }

  return { screen: 'not-found' };
}
