'use client';

// Kitchen Display error boundary — the kiosk's last line of defense, now with a
// real escape hatch. A soft `reset()` only re-renders the SAME client bundle,
// so it can never heal a stale-bundle failure (an always-open kiosk tab whose
// chunks were invalidated by a deploy — "Loading chunk failed" and friends).
// Escalation policy (lib/display/recover.ts, pure + tested):
//   • stale-bundle error → HARD reload immediately (pulls the new bundle);
//   • anything else → two soft resets (covers true transients), then hard reload.
// The screen also prints the error digest/message + the running build id in
// small type, so a photo of a stuck kiosk is a diagnosis, not a mystery.
import { useCallback, useEffect, useRef, useState } from 'react';
import { RotateCw } from 'lucide-react';
import { isStaleBundleError, shouldHardReload } from '@/lib/display/recover';
import { useTranslations } from '@/components/i18n/locale-provider';

const RETRY_SECONDS = 15;
const FAILS_KEY = 'display.boundary.fails';

const BUILD_ID =
  process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA?.slice(0, 7)
  ?? process.env.NEXT_PUBLIC_BUILD_ID
  ?? 'dev';

function readFails(): number {
  try { return parseInt(sessionStorage.getItem(FAILS_KEY) ?? '0', 10) || 0; } catch { return 0; }
}
function writeFails(n: number): void {
  try { sessionStorage.setItem(FAILS_KEY, String(n)); } catch { /* storage blocked */ }
}

export default function DisplayError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations();
  const [countdown, setCountdown] = useState(RETRY_SECONDS);
  // Count consecutive boundary hits across soft resets (sessionStorage survives
  // them; a hard reload clears the session count naturally on success paths).
  const failsRef = useRef<number>(0);

  const recover = useCallback(() => {
    if (shouldHardReload(failsRef.current, error?.message)) {
      writeFails(0); // the reload gets a clean slate
      window.location.reload();
      return;
    }
    writeFails(failsRef.current + 1);
    reset();
  }, [error, reset]);

  useEffect(() => {
    failsRef.current = readFails();
    console.error(
      `[display] kiosk error (build ${BUILD_ID}, fail #${failsRef.current + 1}${isStaleBundleError(error?.message) ? ', stale bundle' : ''}) — auto-recovering:`,
      error,
    );
  }, [error]);

  // Auto-recover: tick down, then escalate per the policy. Also recover the
  // moment the network comes back.
  useEffect(() => {
    const tick = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) { recover(); return RETRY_SECONDS; }
        return c - 1;
      });
    }, 1000);
    const onOnline = () => recover();
    window.addEventListener('online', onOnline);
    return () => { clearInterval(tick); window.removeEventListener('online', onOnline); };
  }, [recover]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-[#0b1020] p-8 text-center text-white">
      {/* Ambient wash, same family as the display's gradient theme */}
      <div aria-hidden className="pointer-events-none absolute inset-0 opacity-30">
        <div className="absolute -left-24 top-10 h-72 w-72 rounded-full bg-violet-600/50 blur-3xl" />
        <div className="absolute -right-16 bottom-0 h-80 w-80 rounded-full bg-blue-600/40 blur-3xl" />
      </div>

      <div className="relative">
        <p className="text-xs font-semibold uppercase tracking-[0.25em] text-white/40">{t('display.bubalyKitchen')}</p>
        <h1 className="mt-3 text-3xl font-black sm:text-4xl">{t('display.oneMoment')}</h1>
        <p className="mx-auto mt-3 max-w-sm text-sm text-white/55">
          {t('display.theDisplayHitABriefHiccup')}
        </p>
        <p className="mt-6 text-sm text-white/45">
          {t('display.refreshingIn')} <span className="tabular-nums font-bold text-white/80">{countdown}s</span>
        </p>
        <button
          onClick={() => { writeFails(0); window.location.reload(); }}
          className="mt-4 inline-flex items-center gap-2 rounded-full bg-white/10 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-white/20"
        >
          <RotateCw className="h-4 w-4" /> {t('display.refreshNow')}
        </button>
        {/* Diagnostic line — small, but turns a photo of this screen into a bug report. */}
        <p className="mx-auto mt-8 max-w-md break-all font-mono text-[10px] leading-relaxed text-white/25">
          {(error?.digest ? `digest ${error.digest}` : (error?.message ?? 'unknown error').slice(0, 160))} {t('display.build')} {BUILD_ID}
        </p>
      </div>
    </div>
  );
}
