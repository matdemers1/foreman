import { useCallback, useEffect, useState } from 'react';
import {
  AccountMenu,
  AppShell,
  AppShellBrand,
  EmptyState,
  MenuItem,
  MenuSeparator,
  SideNav,
  SideNavItem,
  Spinner,
  ThemeProvider,
  ThemeSwitch,
} from '@d3cloud/ui';
import { FolderKanban, Home as HomeIcon, ListChecks, Search } from 'lucide-react';
import { fetchSession, logout, type SessionState } from './lib/api';
import { routeFor, useLocation } from './lib/router';
import { Login } from './screens/Login';
import { PhaseDetail } from './screens/PhaseDetail';
import { Phases } from './screens/Phases';
import { Portfolio } from './screens/Portfolio';
import { ProjectOverview } from './screens/ProjectOverview';
import { Adrs } from './screens/Adrs';
import { DocumentEditor } from './screens/DocumentEditor';
import { Documents } from './screens/Documents';
import { Glossary } from './screens/Glossary';
import { RequirementDetail } from './screens/RequirementDetail';
import { RiskRegister } from './screens/RiskRegister';
import { Search as SearchScreen } from './screens/Search';
import { Requirements } from './screens/Requirements';
import { RegisterView } from './screens/RegisterView';
import { ScopeOfWorkView } from './screens/ScopeOfWorkView';
import { TaskDetail } from './screens/TaskDetail';

/**
 * The console shell.
 *
 * One question decides what renders: is there a session? The answer comes from the server, not from
 * anything held in the browser — there is no token in `localStorage` to go stale or be stolen.
 */

type State =
  | { status: 'loading' }
  | { status: 'anonymous'; oidcAvailable: boolean }
  | { status: 'signed-in'; session: SessionState }
  | { status: 'unreachable' };

export function App() {
  const [state, setState] = useState<State>({ status: 'loading' });
  const { path, search } = useLocation();

  const load = useCallback(() => {
    void fetchSession()
      .then((session) => {
        setState(
          session.authenticated
            ? { status: 'signed-in', session }
            : { status: 'anonymous', oidcAvailable: session.oidcAvailable },
        );
      })
      .catch(() => {
        setState({ status: 'unreachable' });
      });
  }, []);

  useEffect(load, [load]);

  if (state.status === 'loading') {
    return (
      <ThemeProvider>
        <Spinner label="Loading Foreman" />
      </ThemeProvider>
    );
  }

  if (state.status === 'unreachable') {
    return (
      <ThemeProvider>
        {/* Said plainly: the person reading this is the person who can fix it. */}
        <EmptyState kind="error" heading="Foreman is not answering">
          The API did not respond. Check the server and reload.
        </EmptyState>
      </ThemeProvider>
    );
  }

  if (state.status === 'anonymous') {
    return (
      <ThemeProvider>
        <Login oidcAvailable={state.oidcAvailable} onSignedIn={load} />
      </ThemeProvider>
    );
  }

  const { user } = state.session;

  return (
    <ThemeProvider>
      <AppShell
        storageKey="foreman.nav"
        brand={<AppShellBrand name="Foreman" href="/" />}
        nav={
          <SideNav>
            {/* Phase 0 wires the shell; each destination arrives with the screen behind it. */}
            <SideNavItem href="/" icon={<HomeIcon />} label="Portfolio" current={path === '/'} />
            <SideNavItem
              href="/projects"
              icon={<FolderKanban />}
              label="Projects"
              current={path.startsWith('/projects')}
            />
            <SideNavItem href="/findings" icon={<ListChecks />} label="Findings" />
            <SideNavItem
              href="/search"
              icon={<Search />}
              label="Search"
              current={path === '/search'}
            />
          </SideNav>
        }
        footer={
          <AccountMenu name={user.displayName} detail={user.email}>
            <ThemeSwitch />
            <MenuSeparator />
            <MenuItem
              tone="danger"
              onSelect={() => {
                void logout().finally(load);
              }}
            >
              Sign out
            </MenuItem>
          </AccountMenu>
        }
      >
        <Screen path={path} search={search} />
      </AppShell>
    </ThemeProvider>
  );
}

/** One screen, chosen by the path. The query configures it. */
function Screen({ path, search }: { path: string; search: string }) {
  const route = routeFor(path);

  switch (route.screen) {
    case 'portfolio':
      return <Portfolio />;
    case 'project':
      return <ProjectOverview code={route.code ?? ''} />;
    case 'phases':
      return <Phases code={route.code ?? ''} />;
    case 'phase':
      return <PhaseDetail code={route.code ?? ''} phaseHumanId={route.humanId ?? ''} />;
    case 'requirements':
      // Keyed by the query, so following `?uncovered=true` from a screen already showing this
      // table re-reads the filters instead of quietly ignoring them.
      return <Requirements key={search} code={route.code ?? ''} search={search} />;
    case 'requirement':
      return <RequirementDetail humanId={route.humanId ?? ''} />;
    case 'scope-of-work':
      return <ScopeOfWorkView code={route.code ?? ''} />;
    case 'register':
      return <RegisterView code={route.code ?? ''} />;
    case 'documents':
      return <Documents code={route.code ?? ''} />;
    case 'document':
      return <DocumentEditor code={route.code ?? ''} id={route.humanId ?? ''} />;
    case 'adrs':
      return <Adrs code={route.code ?? ''} />;
    case 'risks':
      return <RiskRegister code={route.code ?? ''} />;
    case 'glossary':
      return <Glossary code={route.code ?? ''} />;
    case 'search':
      return <SearchScreen key={search} search={search} />;
    case 'task':
      return <TaskDetail humanId={route.humanId ?? ''} />;
    case 'not-found':
      return (
        <EmptyState kind="no-results" heading="That page does not exist">
          Nothing is served at {path}.
        </EmptyState>
      );
  }
}
