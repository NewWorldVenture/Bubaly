'use client';

// Kitchen Display error boundary — the kiosk's last line of defense. A wall
// screen has no one at the keyboard, so unlike the generic app boundary this
// one SELF-HEALS: it auto-retries on a steady interval (and immediately when
// the network comes back) until the display renders again. Styled like the
// display itself (calm, dark, ambient) so a blip never looks like a breakage.
import { useEffect, useState } from 'react';
import { RotateCw } from 'lucide-react';

const RETRY_SECONDS = 15;

export default function DisplayError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [countdown, setCountdown] = useState(RETRY_SECONDS);

  useEffect(() => {
    console.error('[display] kiosk error — auto-recovering:', error);
  }, [error]);

  // Auto-retry: tick down, then reset. Also retry the moment we come back online.
  useEffect(() => {
    const tick = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) { reset(); return RETRY_SECONDS; }
        return c - 1;
      });
    }, 1000);
    const onOnline = () => reset();
    window.addEventListener('online', onOnline);
    return () => { clearInterval(tick); window.removeEventListener('online', onOnline); };
  }, [reset]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-[#0b1020] p-8 text-center text-white">
      {/* Ambient wash, same family as the display's gradient theme */}
      <div aria-hidden className="pointer-events-none absolute inset-0 opacity-30">
        <div className="absolute -left-24 top-10 h-72 w-72 rounded-full bg-violet-600/50 blur-3xl" />
        <div className="absolute -right-16 bottom-0 h-80 w-80 rounded-full bg-blue-600/40 blur-3xl" />
      </div>

      <div className="relative">
        <p className="text-xs font-semibold uppercase tracking-[0.25em] text-white/40">Bubaly Kitchen</p>
        <h1 className="mt-3 text-3xl font-black sm:text-4xl">One moment…</h1>
        <p className="mx-auto mt-3 max-w-sm text-sm text-white/55">
          The display hit a brief connection hiccup. It will reconnect by itself —
          nothing to do, your data is safe.
        </p>
        <p className="mt-6 text-sm text-white/45">
          Reconnecting in <span className="tabular-nums font-bold text-white/80">{countdown}s</span>
        </p>
        <button
          onClick={() => reset()}
          className="mt-4 inline-flex items-center gap-2 rounded-full bg-white/10 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-white/20"
        >
          <RotateCw className="h-4 w-4" /> Reconnect now
        </button>
      </div>
    </div>
  );
}
