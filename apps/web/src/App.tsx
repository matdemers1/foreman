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
import { Login } from './screens/Login';
import { Home } from './screens/Home';

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

  const load = useCallback(() => {
    void fetchSession()
      .then((session) => {
        setState(
          session === null
            ? // 401 carries no `oidcAvailable`, so the button is offered once signed-in state is
              // known. Until then the password path — the one that always works — is the only one.
              { status: 'anonymous', oidcAvailable: false }
            : { status: 'signed-in', session },
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
            <SideNavItem href="/" icon={<HomeIcon />} label="Portfolio" current />
            <SideNavItem href="/projects" icon={<FolderKanban />} label="Projects" />
            <SideNavItem href="/findings" icon={<ListChecks />} label="Findings" />
            <SideNavItem href="/search" icon={<Search />} label="Search" />
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
        <Home displayName={user.displayName} />
      </AppShell>
    </ThemeProvider>
  );
}
