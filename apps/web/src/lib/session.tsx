import { createContext, useContext, type ReactNode } from 'react';
import type { Mode, SessionState } from './api';

/**
 * Who is signed in, and which product this is (FRM-ADR-016).
 *
 * The shell already fetches the session to decide whether to render the console at all, so this
 * hands the same answer down rather than asking again from every screen that needs it. Two
 * questions are asked of it constantly:
 *
 * - **What is this deployment?** `solo` hides the board entirely; `board` hides converting a
 *   submission into a Foreman project, which is a personal instance's ending, not a fund's.
 * - **What may this person do?** A submitter sees the board and edits their own; a reviewer
 *   scores and decides.
 *
 * Asked once, at the top, rather than inferred from what the API happens to refuse. A console
 * that discovers its permissions by being told no shows people buttons that do not work.
 */

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({
  session,
  children,
}: {
  session: SessionState;
  children: ReactNode;
}) {
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const session = useContext(SessionContext);
  // Thrown rather than defaulted: every screen renders inside the shell, so a missing provider is
  // a wiring mistake at build time and never a state a person can reach.
  if (session === null) throw new Error('useSession outside the shell');
  return session;
}

export function useMode(): Mode {
  return useSession().mode;
}

/** Whether this person may score, comment internally, and decide. Always true on a solo instance. */
export function useReviews(): boolean {
  const session = useSession();
  return session.mode === 'solo' || session.user.role === 'admin' || session.user.role === 'reviewer';
}

export function useIsAdmin(): boolean {
  const session = useSession();
  return session.mode === 'solo' || session.user.role === 'admin';
}

/**
 * Money, from minor units.
 *
 * Amounts are stored in cents and formatted here, once. A number that is sometimes dollars and
 * sometimes cents is the bug this exists to prevent, and it is the sort that reaches a person as
 * a funding email saying a hundred times too much.
 */
export function useMoney(): (cents: number | null) => string {
  const { currency } = useSession();
  return (cents) =>
    cents === null
      ? '—'
      : new Intl.NumberFormat(undefined, {
          style: 'currency',
          currency,
          maximumFractionDigits: 0,
        }).format(cents / 100);
}
