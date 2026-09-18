import { useCallback, useEffect, useState } from 'react';
import { ApiError } from './api';

/**
 * Load something, and hold the three states a screen actually has to render: loading, failed, and
 * loaded (S-04 onward).
 *
 * A screen that only renders the third is the one that shows an empty table while the data is still
 * in flight, and nothing at all when the request failed.
 */

export type Async<T> =
  | { status: 'loading' }
  | { status: 'error'; message: string; notFound: boolean }
  | { status: 'ready'; value: T };

export function useAsync<T>(load: () => Promise<T>, deps: readonly unknown[]): {
  state: Async<T>;
  reload: () => void;
} {
  const [state, setState] = useState<Async<T>>({ status: 'loading' });
  const [nonce, setNonce] = useState(0);

  // The caller states its own dependencies, which is the whole point of the hook taking them.
  const run = useCallback(load, deps);

  useEffect(() => {
    let live = true;
    setState({ status: 'loading' });

    run()
      .then((value) => {
        // A response that arrives after the screen moved on must not render over what replaced it.
        if (live) setState({ status: 'ready', value });
      })
      .catch((error: unknown) => {
        if (!live) return;
        setState({
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
          notFound: error instanceof ApiError && error.status === 404,
        });
      });

    return () => {
      live = false;
    };
  }, [run, nonce]);

  return { state, reload: () => { setNonce((n) => n + 1); } };
}
