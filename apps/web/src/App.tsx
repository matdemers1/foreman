import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  AccountMenu,
  AppShell,
  AppShellBrand,
  EmptyState,
  MenuItem,
  MenuSeparator,
  SideNav,
  SideNavGroup,
  SideNavItem,
  Spinner,
  ThemeProvider,
  ThemeSwitch,
} from '@d3cloud/ui';
import {
  Activity as ActivityIcon,
  BookText,
  CalendarRange,
  FileStack,
  FolderKanban,
  GitBranch,
  Home as HomeIcon,
  ListChecks,
  ListTodo,
  Radar,
  ScrollText,
  KeyRound,
  Search,
  ShieldAlert,
  SquareStack,
  Table2,
} from 'lucide-react';
import { fetchSession, logout, type SessionState } from './lib/api';
import { briefFor, projectCodeFor, SECTIONS } from './lib/project';
import { useAsync } from './lib/useAsync';
import { routeFor, useLocation } from './lib/router';
import { Login } from './screens/Login';
import { PhaseDetail } from './screens/PhaseDetail';
import { Phases } from './screens/Phases';
import { Dashboard } from './screens/Dashboard';
import { Projects } from './screens/Projects';
import { Tokens } from './screens/Tokens';
import { ProjectOverview } from './screens/ProjectOverview';
import { Activity } from './screens/Activity';
import { Adrs } from './screens/Adrs';
import { AuditIndex } from './screens/AuditIndex';
import { DocumentEditor } from './screens/DocumentEditor';
import { Documents } from './screens/Documents';
import { DriftView } from './screens/DriftView';
import { FindingDetail } from './screens/FindingDetail';
import { Findings } from './screens/Findings';
import { Glossary } from './screens/Glossary';
import { Health } from './screens/Health';
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
            {/* Five destinations, and they do not grow. The project list used to live here and
                would have been unusable at twenty projects — it is a screen of its own now. */}
            <SideNavItem href="/" icon={<HomeIcon />} label="Dashboard" current={path === '/'} />
            <SideNavItem
              href="/projects"
              icon={<FolderKanban />}
              label="Projects"
              current={path === '/projects'}
            />
            <SideNavItem
              href="/findings"
              icon={<ListChecks />}
              label="Findings"
              current={path.startsWith('/findings')}
            />
            <SideNavItem
              href="/search"
              icon={<Search />}
              label="Search"
              current={path === '/search'}
            />
            <SideNavItem
              href="/system"
              icon={<ActivityIcon />}
              label="Health"
              current={path === '/system'}
            />
            <SideNavItem
              href="/tokens"
              icon={<KeyRound />}
              label="API tokens"
              current={path === '/tokens'}
            />
            <ProjectSections path={path} />
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

/**
 * The sections of the project you are currently in — and nothing when you are not in one.
 *
 * This replaced a list of every project, which had two problems: it grew without bound (nine
 * projects today, and the sidebar is the one surface that cannot scroll away), and it offered the
 * one destination you already had while offering nothing from inside a project. Two clicks into
 * `/projects/BND/adrs` the sidebar showed you ten other projects and no way to Bindery's phases.
 *
 * Grouped the way the tool thinks: what was planned, what was decided, and what is actually there.
 */
const SECTION_ICONS: Record<string, ReactNode> = {
  phases: <CalendarRange />,
  requirements: <ListTodo />,
  'scope-of-work': <SquareStack />,
  register: <Table2 />,
  documents: <FileStack />,
  adrs: <ScrollText />,
  risks: <ShieldAlert />,
  glossary: <BookText />,
  activity: <GitBranch />,
  audits: <ListChecks />,
  drift: <Radar />,
};

function ProjectSections({ path }: { path: string }) {
  const code = projectCodeFor(path);
  const { state } = useAsync(
    () => (code === null ? Promise.resolve(null) : briefFor(code)),
    [code],
  );

  if (code === null) return null;

  // The code until the name arrives. A group title that appears a beat late shifts every item
  // under it, which is worse than a title that is briefly terse.
  const name = state.status === 'ready' && state.value !== null ? state.value.project.name : code;
  const groups = ['Plan', 'Knowledge', 'Reality'] as const;

  return (
    <>
      <SideNavGroup title={name}>
        <SideNavItem
          href={`/projects/${code}`}
          icon={<HomeIcon />}
          label="Overview"
          current={path === `/projects/${code}`}
        />
      </SideNavGroup>
      {groups.map((group) => (
        <SideNavGroup key={group} title={group}>
          {SECTIONS.filter((section) => section.group === group).map((section) => (
            <SideNavItem
              key={section.slug}
              href={`/projects/${code}/${section.slug}`}
              icon={SECTION_ICONS[section.slug]}
              label={section.label}
              current={path.startsWith(`/projects/${code}/${section.slug}`)}
            />
          ))}
        </SideNavGroup>
      ))}
    </>
  );
}

/** One screen, chosen by the path. The query configures it. */
function Screen({ path, search }: { path: string; search: string }) {
  const route = routeFor(path);

  switch (route.screen) {
    case 'dashboard':
      return <Dashboard />;
    case 'projects':
      return <Projects />;
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
    case 'audits':
      return <AuditIndex code={route.code ?? ''} />;
    case 'activity':
      return <Activity code={route.code ?? ''} />;
    case 'findings':
      return <Findings key={search} search={search} />;
    case 'finding':
      return <FindingDetail humanId={route.humanId ?? ''} />;
    case 'drift':
      return <DriftView code={route.code ?? ''} />;
    case 'health':
      return <Health />;
    case 'tokens':
      return <Tokens />;
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
