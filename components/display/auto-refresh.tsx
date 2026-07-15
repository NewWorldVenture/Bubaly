'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { isBundleStaleByAge } from '@/lib/display/recover';

/**
 * Keeps the kitchen display current on two clocks:
 *  • data — router.refresh() on the given interval (server data, same bundle);
 *  • bundle — a HARD reload once the tab's JS bundle is older than the kiosk
 *    max age, so an always-open tab picks up new deploys instead of drifting
 *    onto invalidated chunks (the classic "kiosk stuck on the error screen
 *    forever" failure). The reload happens on an interval boundary, so the
 *    screen just blinks once every ~12h.
 */
export function AutoRefresh({ seconds = 60 }: { seconds?: number }) {
  const router = useRouter();
  const loadedAt = useRef<number>(Date.now());

  useEffect(() => {
    const id = setInterval(() => {
      if (isBundleStaleByAge(loadedAt.current, Date.now())) {
        window.location.reload();
        return;
      }
      router.refresh();
    }, seconds * 1000);
    return () => clearInterval(id);
  }, [router, seconds]);
  return null;
}
