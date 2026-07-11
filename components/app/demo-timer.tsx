'use client';

// Demo Timer — a polished session countdown shown in the top bar for the demo
// families only (isDemoFamily). Real accounts render nothing. Counts down from
// DEMO_SESSION_SECONDS, persists the start in sessionStorage so it survives
// navigation, warns in the final 30s, and offers a non-destructive Restart when
// time's up. Pure timing math lives in lib/constants/demo.ts.
import { useEffect, useRef, useState } from 'react';
import { Sparkles, RotateCcw } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { isDemoFamily, formatMMSS, remainingSeconds, DEMO_SESSION_SECONDS } from '@/lib/constants/demo';
import { cn } from '@/lib/utils/cn';

const START_KEY = 'bubaly.demo.session.start';

export function DemoTimer() {
  const { familyId } = useApp();
  const [mounted, setMounted] = useState(false);
  const [left, setLeft] = useState(DEMO_SESSION_SECONDS);
  const startRef = useRef<number | null>(null);

  const demo = isDemoFamily(familyId);

  useEffect(() => {
    if (!demo) return;
    setMounted(true);
    // Resume an in-progress demo session, or start a new one.
    let start = Number(sessionStorage.getItem(START_KEY));
    if (!start || Number.isNaN(start)) {
      start = Date.now();
      sessionStorage.setItem(START_KEY, String(start));
    }
    startRef.current = start;
    setLeft(remainingSeconds(start, Date.now()));

    const id = setInterval(() => {
      if (startRef.current != null) setLeft(remainingSeconds(startRef.current, Date.now()));
    }, 1000);
    return () => clearInterval(id);
  }, [demo]);

  if (!demo || !mounted) return null;

  const { mm, ss } = formatMMSS(left);
  const expired = left <= 0;
  const urgent = !expired && left <= 30;

  function restart() {
    const start = Date.now();
    sessionStorage.setItem(START_KEY, String(start));
    startRef.current = start;
    setLeft(DEMO_SESSION_SECONDS);
  }

  return (
    <div
      role="timer"
      aria-label={expired ? 'Demo session ended' : `Demo session: ${mm} minutes ${ss} seconds remaining`}
      className={cn(
        'inline-flex select-none items-center gap-2 rounded-xl border px-2 py-1 shadow-sm transition-colors',
        expired
          ? 'border-rose-400/40 bg-rose-500/10'
          : urgent
            ? 'border-amber-400/50 bg-amber-500/10'
            : 'border-violet-400/30 bg-violet-500/10',
      )}
    >
      <span className={cn(
        'grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-gradient-to-br text-white',
        expired ? 'from-rose-500 to-rose-600' : urgent ? 'from-amber-500 to-orange-500' : 'from-violet-500 to-fuchsia-500',
        urgent && 'motion-safe:animate-pulse',
      )}>
        <Sparkles className="h-3.5 w-3.5" />
      </span>

      <span className="hidden text-[11px] font-semibold leading-tight text-fg sm:block">Demo<br />Timer</span>

      {expired ? (
        <button
          type="button" onClick={restart}
          className="inline-flex items-center gap-1 rounded-md bg-black/60 px-2 py-1 text-[11px] font-semibold text-white transition hover:bg-black/75"
        >
          <RotateCcw className="h-3.5 w-3.5" /> Restart
        </button>
      ) : (
        <span className="flex items-center gap-1.5 rounded-md bg-black/55 px-2 py-0.5">
          <span className="text-center">
            <span className="block font-mono text-base font-bold leading-none tabular-nums text-white">{mm}</span>
            <span className="block text-[8px] uppercase tracking-[0.15em] text-white/50">min</span>
          </span>
          <span className={cn('pb-2 text-sm font-bold text-white/40', urgent && 'text-amber-300')}>:</span>
          <span className="text-center">
            <span className="block font-mono text-base font-bold leading-none tabular-nums text-white">{ss}</span>
            <span className="block text-[8px] uppercase tracking-[0.15em] text-white/50">sec</span>
          </span>
        </span>
      )}
    </div>
  );
}
