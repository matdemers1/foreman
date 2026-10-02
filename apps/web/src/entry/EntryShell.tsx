import './entry.css';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ForemanMark } from '../brand/ForemanMark';

/**
 * FRM-T-13.2: every screen somebody sees before they are signed in — Sign in, accepting an
 * invitation, and the console's own loading and not-answering states.
 *
 * Split, after Bindery's and Postroom's front doors, so the family reads as one: the left half says
 * what Foreman is and names three claims a person can check in it; the right half is the form.
 * Below 1024px the story is dropped rather than squeezed, and the mark and name sit above the form.
 * Foreman is a desktop console by plan, but the fallback is still the whole sign-in on a phone.
 *
 * The aside is a landmark with its own label and an h2, so each screen keeps exactly one h1 — the
 * form's — and the form is the page's <main>.
 *
 * No build label in the footer: `/health` names the schema revision, not the commit, and adding an
 * endpoint only to decorate this panel is not worth a route.
 */
export function EntryShell({
  children,
  wide = false,
}: {
  children: ReactNode;
  /** For the longer forms (choosing a password): about 28rem rather than 24. */
  wide?: boolean;
}) {
  return (
    <div className="fm-entry">
      <StoryPanel />
      <main className="fm-entry__main">
        <div className={wide ? 'fm-entry__column fm-entry__column--wide' : 'fm-entry__column'}>
          <div className="fm-entry__brand fm-entry__brand--compact">
            <ForemanMark size={28} decorative /> Foreman
          </div>
          {children}
        </div>
      </main>
    </div>
  );
}

export const ENTRY_HEADLINE = 'The plan of record —';
export const ENTRY_HEADLINE_ACCENT = 'checked against the code.';
export const ENTRY_PROMISE =
  'Requirements, phases, tasks and decisions for each project, beside the commits that claim them. When the plan and the code drift apart, Foreman names where.';
export const ENTRY_CLAIMS: readonly { title: string; detail: string }[] = [
  // FRM-REQ-013, enforced by no-llm.test.ts: no AI SDK in any package.json, no model host called.
  { title: 'No model runs on the server.', detail: 'Claude is a user over MCP, like you.' },
  // FRM-REQ-108, ADR-005, never-regress test #1: a proposal from a commit message or a file
  // overlap is stored unconfirmed, and no coverage, status, brief or drift read counts it.
  { title: 'A guessed link is never truth.', detail: 'A commit counts once it is declared or confirmed.' },
  // FRM-REQ-138 … 140, domain/undo.ts: a delete sets deleted_at, and the audit event restores it.
  { title: 'No record is deleted outright.', detail: 'A delete is soft, and Undo puts it back.' },
];

/**
 * The arrival plays once per page load. The loading state, Sign in and the invitation each mount
 * their own shell; once the first has started it, the rest arrive already settled rather than
 * replaying it on every step.
 */
let arrived = false;

function StoryPanel() {
  const [settled] = useState(() => arrived);
  useEffect(() => {
    arrived = true;
  }, []);

  return (
    <aside
      aria-label="About Foreman"
      className="fm-entry__story"
      {...(settled ? { 'data-settled': '' } : {})}
    >
      <div className="fm-entry__brand">
        <ForemanMark size={28} decorative /> Foreman
      </div>

      <div className="fm-entry__pitch">
        <h2 className="fm-entry__headline">
          {ENTRY_HEADLINE} <span className="fm-entry__headline-accent">{ENTRY_HEADLINE_ACCENT}</span>
        </h2>
        <p className="fm-entry__promise">{ENTRY_PROMISE}</p>
        <ul className="fm-entry__claims">
          {ENTRY_CLAIMS.map((c) => (
            <Claim key={c.title} title={c.title}>
              {c.detail}
            </Claim>
          ))}
        </ul>
      </div>

      <footer className="fm-entry__foot">
        <span>self-hosted</span>
      </footer>
    </aside>
  );
}

function Claim({ title, children }: { title: string; children: ReactNode }) {
  return (
    <li className="fm-entry__claim">
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
        focusable="false"
        className="fm-entry__tick"
      >
        <path
          d="M3.5 8.5l3 3 6-7"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span>
        <span className="fm-entry__claim-title">{title}</span> {children}
      </span>
    </li>
  );
}

/**
 * The heading every entry form opens with: the screen's one h1 and a muted line under it.
 * `focusOnMount` moves focus to the heading, as AuthLayout did, for a screen with no field to land
 * in (the not-answering state).
 */
export function EntryHeading({
  title,
  children,
  focusOnMount = false,
}: {
  title: string;
  children?: ReactNode;
  focusOnMount?: boolean;
}) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focusOnMount) ref.current?.focus();
  }, [focusOnMount]);
  return (
    <header className="fm-entry__heading">
      <h1 ref={ref} tabIndex={-1} className="fm-entry__title">
        {title}
      </h1>
      {children === undefined ? null : <p className="fm-entry__lede">{children}</p>}
    </header>
  );
}

/**
 * Under a form, past a hairline: small muted lines saying where to go when this screen is not the
 * answer, or (`row`) the text buttons that change step.
 */
export function EntryNotes({ children, row = false }: { children: ReactNode; row?: boolean }) {
  return <div className={row ? 'fm-entry__notes fm-entry__notes--row' : 'fm-entry__notes'}>{children}</div>;
}
