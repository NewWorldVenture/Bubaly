'use client';

// components/display/display-self-check.tsx — "Test this display".
//
// Four checks, and the report says ONLY what was measured on the tablet the
// button was pressed on:
//
//   fullscreen — is `requestFullscreen` there and is fullscreen enabled at all
//                (an iframe or a policy can switch it off);
//   wake lock  — actually ASK for the lock and report the answer, including
//                "this browser has none" and "the browser declined";
//   online     — what `navigator.onLine` says, which is a claim about the
//                network interface, not proof that Bubaly is reachable — the
//                copy says exactly that;
//   recovery   — the kiosk's stale-bundle policy (lib/display/recover) is
//                loaded and answering, which is what keeps an always-open tab
//                from looping on an invalidated bundle after a deploy.
//
// There is deliberately no fifth line claiming "your display is ready": nothing
// here can prove that a screen stays on for 24 hours, and the wall-display
// script in docs/PHYSICAL_DEVICE_TEST_PLAN.md is where that gets proved by a
// person with a tablet.
//
// The runner is a plain function over an injected environment so the outcomes
// are unit-tested (tests/display-setup-page.test.ts) without a browser.

import { useCallback, useState } from 'react';
import { AlertTriangle, CheckCircle2, CircleDashed, Loader2, PlayCircle, XCircle } from 'lucide-react';
import { createWakeLock, type WakeLockDocumentLike, type WakeLockNavigatorLike } from '@/lib/display/wake-lock';
import { isBundleStaleByAge, isStaleBundleError, shouldHardReload } from '@/lib/display/recover';
import { useTranslations } from '@/components/i18n/locale-provider';

export const SELF_CHECK_IDS = ['fullscreen', 'wakeLock', 'online', 'recovery'] as const;
export type SelfCheckId = (typeof SELF_CHECK_IDS)[number];

/** `unknown` exists so a check that could not be run is never reported as a pass. */
export type SelfCheckOutcome = 'pass' | 'warn' | 'fail' | 'unknown';

export type SelfCheckResult = {
  id: SelfCheckId;
  outcome: SelfCheckOutcome;
  /** Catalogue key for the one line under the check's name. */
  detailKey: string;
};

export type SelfCheckEnv = {
  navigator?: (WakeLockNavigatorLike & { onLine?: boolean }) | null;
  document?: (WakeLockDocumentLike & {
    fullscreenEnabled?: boolean;
    documentElement?: { requestFullscreen?: unknown } | null;
  }) | null;
};

/** Is the Fullscreen API present AND permitted here? */
export async function checkFullscreen(env: SelfCheckEnv): Promise<SelfCheckResult> {
  const doc = env.document;
  if (!doc) return { id: 'fullscreen', outcome: 'unknown', detailKey: 'displaySetup.fullscreenUnknown' };
  const hasApi = typeof doc.documentElement?.requestFullscreen === 'function';
  if (!hasApi) return { id: 'fullscreen', outcome: 'fail', detailKey: 'displaySetup.fullscreenMissing' };
  if (doc.fullscreenEnabled === false) {
    return { id: 'fullscreen', outcome: 'warn', detailKey: 'displaySetup.fullscreenDisabled' };
  }
  return { id: 'fullscreen', outcome: 'pass', detailKey: 'displaySetup.fullscreenAvailable' };
}

/** Ask for the screen lock for real, then give it straight back. */
export async function checkWakeLock(env: SelfCheckEnv): Promise<SelfCheckResult> {
  const lock = createWakeLock({ navigator: env.navigator ?? null, document: env.document ?? null });
  const state = await lock.acquire();
  await lock.stop();
  if (state === 'active') return { id: 'wakeLock', outcome: 'pass', detailKey: 'displaySetup.wakeLockHeld' };
  if (state === 'blocked') return { id: 'wakeLock', outcome: 'warn', detailKey: 'displaySetup.wakeLockDeclined' };
  return { id: 'wakeLock', outcome: 'fail', detailKey: 'displaySetup.wakeLockMissing' };
}

/** What the browser says about the network — no more than that. */
export async function checkOnline(env: SelfCheckEnv): Promise<SelfCheckResult> {
  const online = env.navigator?.onLine;
  if (typeof online !== 'boolean') return { id: 'online', outcome: 'unknown', detailKey: 'displaySetup.onlineUnknown' };
  return online
    ? { id: 'online', outcome: 'pass', detailKey: 'displaySetup.onlineYes' }
    : { id: 'online', outcome: 'fail', detailKey: 'displaySetup.onlineNo' };
}

/** The stale-bundle escalation policy is loaded and answers as designed. */
export async function checkRecovery(): Promise<SelfCheckResult> {
  const now = Date.now();
  const answers = isStaleBundleError('ChunkLoadError: Loading chunk 42 failed')
    && !isStaleBundleError('TypeError: x is not a function')
    && shouldHardReload(2, null)
    && !isBundleStaleByAge(now, now);
  return answers
    ? { id: 'recovery', outcome: 'pass', detailKey: 'displaySetup.recoveryReady' }
    : { id: 'recovery', outcome: 'fail', detailKey: 'displaySetup.recoveryBroken' };
}

/** Run every check in order. Never throws: a thrown check is reported unknown. */
export async function runDisplaySelfCheck(
  env: SelfCheckEnv,
  onResult?: (result: SelfCheckResult) => void,
): Promise<SelfCheckResult[]> {
  const runners: [SelfCheckId, () => Promise<SelfCheckResult>][] = [
    ['fullscreen', () => checkFullscreen(env)],
    ['wakeLock', () => checkWakeLock(env)],
    ['online', () => checkOnline(env)],
    ['recovery', () => checkRecovery()],
  ];
  const out: SelfCheckResult[] = [];
  for (const [id, run] of runners) {
    let result: SelfCheckResult;
    try {
      result = await run();
    } catch (error) {
      console.error(`[display-setup] self-check "${id}" failed to run`, error);
      result = { id, outcome: 'unknown', detailKey: 'displaySetup.checkDidNotRun' };
    }
    out.push(result);
    onResult?.(result);
  }
  return out;
}

const CHECK_NAME: Record<SelfCheckId, string> = {
  fullscreen: 'displaySetup.checkFullscreen',
  wakeLock: 'displaySetup.checkWakeLock',
  online: 'displaySetup.checkOnline',
  recovery: 'displaySetup.checkRecovery',
};

function OutcomeIcon({ outcome }: { outcome: SelfCheckOutcome | 'idle' | 'running' }) {
  if (outcome === 'running') return <Loader2 className="h-4 w-4 animate-spin text-brand-text" aria-hidden />;
  if (outcome === 'pass') return <CheckCircle2 className="h-4 w-4 text-emerald-500" aria-hidden />;
  if (outcome === 'warn') return <AlertTriangle className="h-4 w-4 text-amber-500" aria-hidden />;
  if (outcome === 'fail') return <XCircle className="h-4 w-4 text-danger" aria-hidden />;
  return <CircleDashed className="h-4 w-4 text-muted" aria-hidden />;
}

/**
 * The button and the live result list.
 *
 * Before the button is pressed every row reads "not tested yet" — the page must
 * never look like it has verified something it has not been asked to verify.
 */
export function DisplaySelfCheck() {
  const t = useTranslations();
  const [results, setResults] = useState<Partial<Record<SelfCheckId, SelfCheckResult>>>({});
  const [running, setRunning] = useState<SelfCheckId | null>(null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(async () => {
    setBusy(true);
    setResults({});
    setRunning(SELF_CHECK_IDS[0]);
    // Live: each row flips from "not tested yet" to its own answer as the check
    // it names finishes, rather than all four appearing together at the end.
    await runDisplaySelfCheck(
      {
        navigator: typeof navigator === 'undefined' ? null : (navigator as unknown as SelfCheckEnv['navigator']),
        document: typeof document === 'undefined' ? null : (document as unknown as SelfCheckEnv['document']),
      },
      (result) => {
        setResults((prev) => ({ ...prev, [result.id]: result }));
        setRunning(SELF_CHECK_IDS[SELF_CHECK_IDS.indexOf(result.id) + 1] ?? null);
      },
    );
    setRunning(null);
    setBusy(false);
  }, []);

  return (
    <div className="rounded-2xl border border-border bg-surface/50 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{t('displaySetup.testThisDisplay')}</h2>
          <p className="mt-1 text-sm text-muted">{t('displaySetup.testIntro')}</p>
        </div>
        <button
          type="button"
          onClick={() => void run()}
          disabled={busy}
          className="inline-flex min-h-11 items-center gap-2 rounded-full bg-brand px-4 py-2 text-sm font-semibold text-brand-fg transition hover:opacity-90 focus-ring disabled:opacity-60"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <PlayCircle className="h-4 w-4" aria-hidden />}
          {t('displaySetup.runTheChecks')}
        </button>
      </div>

      <ul className="mt-4 space-y-2.5" role="status" aria-live="polite">
        {SELF_CHECK_IDS.map((id) => {
          const result = results[id];
          const state = result ? result.outcome : running === id ? 'running' : 'idle';
          return (
            <li key={id} className="flex items-start gap-2.5 text-sm">
              <span className="mt-0.5"><OutcomeIcon outcome={state} /></span>
              <span className="min-w-0">
                <span className="font-medium">{t(CHECK_NAME[id])}</span>
                <span className="block text-muted">
                  {result ? t(result.detailKey) : t('displaySetup.notTestedYet')}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
