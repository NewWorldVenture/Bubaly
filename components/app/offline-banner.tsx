'use client';

import { useEffect, useState } from 'react';
import { WifiOff, Wifi } from 'lucide-react';
import { cn } from '@/lib/utils/cn';

/**
 * Global connectivity banner (offline mode v1, gap #13). Shows while offline —
 * pages keep rendering their last-synced data via the offline read cache — and
 * flashes a brief "back online, syncing" confirmation on reconnect (the data
 * hooks refetch themselves on the same event).
 */
export function OfflineBanner() {
  const [offline, setOffline] = useState(false);
  const [justReconnected, setJustReconnected] = useState(false);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    setOffline(typeof navigator !== 'undefined' && !navigator.onLine);
    const onOffline = () => { setOffline(true); setJustReconnected(false); };
    const onOnline = () => {
      setOffline(false);
      setJustReconnected(true);
      clearTimeout(timer);
      timer = setTimeout(() => setJustReconnected(false), 3000);
    };
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
    };
  }, []);

  if (!offline && !justReconnected) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'flex items-center justify-center gap-2 px-4 py-1.5 text-xs font-semibold',
        offline ? 'bg-amber-500/15 text-amber-500' : 'bg-emerald-500/15 text-emerald-500',
      )}
    >
      {offline ? (
        <>
          <WifiOff className="h-3.5 w-3.5" />
          You&apos;re offline — showing your last-synced data. Changes will sync when you&apos;re back.
        </>
      ) : (
        <>
          <Wifi className="h-3.5 w-3.5" />
          Back online — syncing…
        </>
      )}
    </div>
  );
}
