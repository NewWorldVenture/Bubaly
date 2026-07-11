'use client';

// The demo countdown banner, pinned to the top of the app during a demo session.
// Ticks every second; at zero it auto-exits (deletes the demo + signs out). The
// visitor can also exit early. `endDemoAction` redirects to /pricing.
import { useEffect, useState, useTransition } from 'react';
import { Clock, LogOut } from 'lucide-react';
import { demoSecondsLeft, formatCountdown } from '@/lib/demo/config';
import { endDemoAction } from '@/app/(marketing)/demo/actions';

export function DemoTimer({ expiresAt }: { expiresAt: string }) {
  const [left, setLeft] = useState(() => demoSecondsLeft(expiresAt));
  const [pending, startTransition] = useTransition();
  const [exiting, setExiting] = useState(false);

  useEffect(() => {
    const t = setInterval(() => setLeft(demoSecondsLeft(expiresAt)), 1000);
    return () => clearInterval(t);
  }, [expiresAt]);

  const exit = () => {
    if (exiting) return;
    setExiting(true);
    startTransition(() => { void endDemoAction(); });
  };

  useEffect(() => {
    if (left <= 0) exit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [left]);

  const urgent = left <= 60;

  return (
    <div
      className={
        'safe-x flex items-center justify-center gap-2 px-4 py-1.5 text-center text-xs font-semibold text-white sm:text-sm ' +
        (urgent ? 'bg-danger' : 'bg-gradient-to-r from-brand to-violet-600')
      }
      role="status"
    >
      <Clock className="h-4 w-4 shrink-0" />
      <span>
        Demo mode — <span className="tabular-nums">{formatCountdown(left)}</span> left · Family+ · everything resets when you leave
      </span>
      <button
        type="button"
        onClick={exit}
        disabled={pending || exiting}
        className="ml-2 inline-flex items-center gap-1 rounded-full bg-white/20 px-2.5 py-0.5 text-[11px] font-semibold transition hover:bg-white/30 disabled:opacity-60"
      >
        <LogOut className="h-3 w-3" /> {exiting ? 'Exiting…' : 'Exit'}
      </button>
    </div>
  );
}
