'use client';

import { useSyncExternalStore } from 'react';

const subscribe = () => () => {};

/**
 * False on the server and during hydration, true from the first client render
 * after it.
 *
 * `if (typeof document === 'undefined') return null` is NOT this: it is false
 * on the server and TRUE during hydration, so a component that renders
 * something only in the browser (a portal, say) renders it in the very pass
 * React is matching against the server HTML. A dialog that opened with the
 * page (/dashboard/vacations/new) failed hydration that way, React #418, and
 * the whole route re-rendered on the client. `useSyncExternalStore` answers the
 * server snapshot during hydration and the client one after it, which is the
 * difference.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(subscribe, () => true, () => false);
}
