'use client';

// The opt-in App Lock screen. The (app) layout renders it INSTEAD of the app
// when the user has a PIN on and this browser has not unlocked it — the
// decision is made on the server, so no app content reaches a locked browser,
// and neither does the PIN's salt or hash. The PIN is checked by
// `unlockAppAction` on the server, which also keeps the attempt count (durably:
// a reload does not reset it). A right PIN sets a session-scoped unlock cookie
// and opens a fresh document so retired router children cannot return.
//
// It can NEVER trap anyone: a "Sign out" escape is always present. No
// redirects, no loop risk.
import { useEffect, useLayoutEffect, useState, useCallback, useRef } from 'react';
import { Lock, Delete, LogOut } from 'lucide-react';
import { unlockAppAction, type UnlockResult } from '@/app/(app)/settings/app-lock-actions';
import { cn } from '@/lib/utils/cn';
import { useLockBodyScroll } from '@/lib/hooks/use-lock-body-scroll';
import { useTranslations } from '@/components/i18n/locale-provider';
import { SignOutForm } from '@/components/auth/sign-out-form';
import { useDialogBehavior } from '@/lib/a11y/use-dialog-behavior';

export function AppLockGate({ blocked = false, unavailable = false, onRetry, onUnlocked }: {
  blocked?: boolean; unavailable?: boolean; onRetry?: () => void; onUnlocked?: () => void;
} = {}) {
  const tr = useTranslations();
  const [digits, setDigits] = useState('');
  // 'wrong' shakes and clears itself; 'unavailable' (the check could not run)
  // stays until the next key, so it can be read.
  const [error, setError] = useState<'wrong' | 'unavailable' | null>(null);
  const [checking, setChecking] = useState(false);
  const [cooldownUntil, setCooldownUntil] = useState(0); // epoch ms, from the server's retryAfter
  const [nowMs, setNowMs] = useState(() => Date.now());
  const mounted = useRef(false);
  const submitting = useRef(false);
  const input = useRef('');
  const wrongTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (wrongTimer.current) clearTimeout(wrongTimer.current);
    };
  }, []);

  const cooldownLeft = Math.max(0, Math.ceil((cooldownUntil - nowMs) / 1000));
  const inCooldown = cooldownLeft > 0;
  const busy = checking || blocked;

  // Tick the cooldown countdown. The server holds the count; this only shows it.
  useEffect(() => {
    if (cooldownUntil === 0) return;
    const id = setInterval(() => {
      const t = Date.now();
      setNowMs(t);
      if (t >= cooldownUntil) { setCooldownUntil(0); input.current = ''; setDigits(''); }
    }, 250);
    return () => clearInterval(id);
  }, [cooldownUntil]);

  const submit = useCallback(async (pin: string) => {
    if (!mounted.current || submitting.current || blocked) return;
    submitting.current = true;
    setChecking(true);
    let res: UnlockResult;
    try {
      res = await unlockAppAction(pin);
    } catch (e: unknown) {
      // A server action REJECTS when the request never completes (offline, a
      // deploy mid-flight). Say so rather than call it a wrong PIN.
      console.error('[app-lock] unlock did not complete', e);
      res = { ok: false, reason: 'unavailable' };
    }
    if (!mounted.current) return;
    if (res.ok) {
      // A fresh document discards the router's cached private subtrees. Never
      // reveal children retained by an older layout after an unlock.
      input.current = '';
      setDigits('');
      if (onUnlocked) onUnlocked();
      else window.location.reload();
      return;
    }
    submitting.current = false;
    setChecking(false);
    input.current = '';
    setDigits('');
    if (res.reason === 'rate_limited') {
      setNowMs(Date.now());
      setCooldownUntil(Date.now() + res.retryAfter * 1000);
      return;
    }
    if (res.reason === 'unavailable') { setError('unavailable'); return; }
    setError('wrong');
    wrongTimer.current = setTimeout(() => { if (mounted.current) setError(null); }, 600);
  }, [blocked, onUnlocked]);

  const press = useCallback((d: string) => {
    if (!mounted.current || submitting.current || busy || error === 'wrong' || inCooldown || input.current.length >= 4) return;
    if (error) setError(null);
    const next = input.current + d;
    input.current = next;
    setDigits(next);
    // Submitted here, not inside a state updater: React may run an updater
    // twice, and every submit now spends one of the server's attempts.
    if (next.length === 4) void submit(next);
  }, [busy, error, inCooldown, submit]);

  const back = useCallback(() => {
    if (!mounted.current || submitting.current || busy || inCooldown) return;
    input.current = input.current.slice(0, -1);
    setDigits(input.current);
  }, [busy, inCooldown]);

  // Hardware keyboard support on the lock screen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (/^\d$/.test(e.key)) { e.preventDefault(); press(e.key); }
      else if (e.key === 'Backspace') { e.preventDefault(); back(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [press, back]);

  // While the lock screen is up, lock the page behind it so mobile
  // touch-scroll cannot move it. The screen is only ever rendered locked.
  useLockBodyScroll(true);

  // No `onClose`: a lock screen is not dismissible, and the trap holds without
  // an exit. Always active, because this component is only mounted while the
  // layout has decided the browser is locked.
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogBehavior(dialogRef, true, { lockScroll: false });

  return (
    <div
      ref={dialogRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-labelledby="app-lock-title"
      className="fixed inset-0 z-[200] flex flex-col items-center justify-center bg-bg px-6"
    >
      <div className="flex w-full max-w-xs flex-col items-center">
        <div className="grid h-14 w-14 place-items-center rounded-2xl bg-brand/15 text-brand-text">
          <Lock className="h-7 w-7" />
        </div>
        <h1 id="app-lock-title" className="mt-5 text-lg font-bold">{tr('appLockGate.enterYourPin')}</h1>
        <p className="mt-1 text-sm text-muted">{tr('appLockGate.bubalyIsLockedForYourPrivacy')}</p>

        {/* PIN dots */}
        <div className={cn('mt-7 flex items-center gap-4', error === 'wrong' && 'animate-shake')}>
          {[0, 1, 2, 3].map((i) => (
            <span key={i}
              className={cn('h-3.5 w-3.5 rounded-full border transition',
                error === 'wrong' ? 'border-rose-500 bg-rose-500' :
                i < digits.length ? 'border-brand bg-brand' : 'border-border bg-transparent')} />
          ))}
        </div>
        {blocked ? (
          <p role={unavailable ? 'alert' : 'status'} className="mt-3 max-w-[16rem] text-center text-xs font-medium text-muted">{tr('appLock.stayingLockedUntilWeCanCheck')}</p>
        ) : inCooldown ? (
          <p className="mt-3 text-xs font-medium text-amber-400">{tr('appLockGate.tooManyAttemptsTryAgainIn')} {cooldownLeft}s</p>
        ) : error === 'wrong' ? (
          <p className="mt-3 text-xs font-medium text-rose-400">{tr('appLockGate.wrongPinTryAgain')}</p>
        ) : error === 'unavailable' ? (
          <p role="alert" className="mt-3 max-w-[16rem] text-center text-xs font-medium text-rose-400">{tr('appLock.stayingLockedUntilWeCanCheck')}</p>
        ) : null}

        {/* Keypad */}
        <div className="mt-8 grid grid-cols-3 gap-3">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((n) => (
            <button key={n} onClick={() => press(n)} disabled={busy || inCooldown}
              className="h-16 w-16 rounded-full border border-border bg-surface/50 text-2xl font-semibold transition hover:bg-elevated active:scale-95 disabled:opacity-50">
              {n}
            </button>
          ))}
          <span />
          <button onClick={() => press('0')} disabled={busy || inCooldown}
            className="h-16 w-16 rounded-full border border-border bg-surface/50 text-2xl font-semibold transition hover:bg-elevated active:scale-95 disabled:opacity-50">
            0
          </button>
          <button onClick={back} disabled={busy || digits.length === 0} aria-label={tr('appLockGate.delete')}
            className="grid h-16 w-16 place-items-center rounded-full text-muted transition hover:bg-elevated active:scale-95 disabled:opacity-30">
            <Delete className="h-6 w-6" />
          </button>
        </div>

        {blocked && onRetry && <button type="button" onClick={onRetry} className="mt-5 text-sm font-medium text-brand-text underline">{tr('appLockSettings.lockNow')}</button>}

        {/* The escape hatch — can never trap a forgotten PIN. */}
        <SignOutForm className="mt-9">
          {({ signingOut }) => <button type="submit" disabled={signingOut} className="flex items-center gap-1.5 text-xs font-medium text-muted transition hover:text-fg">
            <LogOut className="h-3.5 w-3.5" /> {tr('appLockGate.forgotPinSignOut')}
          </button>}
        </SignOutForm>
      </div>
    </div>
  );
}
