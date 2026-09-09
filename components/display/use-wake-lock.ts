'use client';

// components/display/use-wake-lock.ts — the React seam over lib/display/wake-lock.
//
// The controller itself is pure TypeScript so it can be unit-tested without a
// DOM; this is the three lines of React around it. It runs only in an effect,
// so a server render never touches `navigator` and the first paint is identical
// with and without the API.

import { useEffect, useState } from 'react';
import { createWakeLock, type WakeLockState } from '@/lib/display/wake-lock';

/**
 * Keep the screen awake while this component is mounted.
 *
 * Returns the live state so a surface can SAY what it measured — the first-run
 * card shows "keeping this screen awake" only when a sentinel is actually held,
 * and "this browser has no screen lock" when there is nothing to hold.
 */
export function useWakeLock(enabled = true): WakeLockState {
  const [state, setState] = useState<WakeLockState>('idle');

  useEffect(() => {
    if (!enabled) return;
    const lock = createWakeLock({ onChange: setState });
    setState(lock.state());
    void lock.acquire();
    return () => { void lock.stop(); };
  }, [enabled]);

  return state;
}
