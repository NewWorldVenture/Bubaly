'use client';

// The opt-in App Lock gate. When the user has enabled a 4-digit PIN, returning to
// the app shows an "Enter your PIN" screen before any content renders. It can NEVER
// trap anyone: a "Sign out" escape is always present (forgot PIN → sign out → email
// sign-in clears it). Unlock is session-scoped (sessionStorage), so it re-locks when
// the tab/session ends or the account changes. No redirects, no loop risk.
import { useEffect, useState, useCallback } from 'react';
import { Lock, Delete, LogOut } from 'lucide-react';
import { verifyPin, unlockKey } from '@/lib/security/app-lock';
import { cn } from '@/lib/utils/cn';

export function AppLockGate({
  enabled, salt, hash, userId, children,
}: {
  enabled: boolean;
  salt: string;
  hash: string;
  userId: string;
  children: React.ReactNode;
}) {
  const [mounted, setMounted] = useState(false);
  const [unlocked, setUnlocked] = useState(false);
  const [digits, setDigits] = useState('');
  const [error, setError] = useState(false);
  const [checking, setChecking] = useState(false);
  const [attempts, setAttempts] = useState(0);
  const [cooldownUntil, setCooldownUntil] = useState(0); // epoch ms
  const [nowMs, setNowMs] = useState(() => Date.now());

  const MAX_ATTEMPTS = 5;
  const COOLDOWN_MS = 30_000;
  const cooldownLeft = Math.max(0, Math.ceil((cooldownUntil - nowMs) / 1000));
  const inCooldown = cooldownLeft > 0;

  useEffect(() => {
    setMounted(true);
    if (!enabled) { setUnlocked(true); return; }
    try {
      if (sessionStorage.getItem(unlockKey(userId)) === '1') setUnlocked(true);
    } catch { /* ignore */ }
  }, [enabled, userId]);

  // Tick the cooldown countdown; clear the attempt count when it elapses.
  useEffect(() => {
    if (cooldownUntil === 0) return;
    const id = setInterval(() => {
      const t = Date.now();
      setNowMs(t);
      if (t >= cooldownUntil) { setCooldownUntil(0); setAttempts(0); setDigits(''); }
    }, 250);
    return () => clearInterval(id);
  }, [cooldownUntil]);

  const submit = useCallback(async (pin: string) => {
    setChecking(true);
    const ok = await verifyPin(pin, { salt, hash });
    setChecking(false);
    if (ok) {
      try { sessionStorage.setItem(unlockKey(userId), '1'); } catch { /* ignore */ }
      setUnlocked(true);
    } else {
      // Brute-force guard: after MAX_ATTEMPTS wrong tries, lock the keypad for a
      // cooldown. The "Sign out" escape stays available throughout.
      setAttempts((a) => {
        const next = a + 1;
        if (next >= MAX_ATTEMPTS) setCooldownUntil(Date.now() + COOLDOWN_MS);
        return next;
      });
      setError(true);
      setTimeout(() => { setError(false); setDigits(''); }, 600);
    }
  }, [salt, hash, userId]);

  const press = useCallback((d: string) => {
    if (checking || error || inCooldown) return;
    setDigits((prev) => {
      if (prev.length >= 4) return prev;
      const next = prev + d;
      if (next.length === 4) void submit(next);
      return next;
    });
  }, [checking, error, inCooldown, submit]);

  const back = useCallback(() => setDigits((p) => p.slice(0, -1)), []);

  // Hardware keyboard support on the lock screen.
  useEffect(() => {
    if (unlocked || !enabled || !mounted) return;
    const onKey = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') back();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [unlocked, enabled, mounted, press, back]);

  // Not locked → render the app normally.
  if (!enabled || unlocked) return <>{children}</>;

  // Locked: never render protected content behind the overlay (and avoid an SSR flash
  // before mount by showing the lock chrome immediately).
  return (
    <div className="fixed inset-0 z-[200] flex flex-col items-center justify-center bg-bg px-6">
      <div className="flex w-full max-w-xs flex-col items-center">
        <div className="grid h-14 w-14 place-items-center rounded-2xl bg-brand/15 text-brand">
          <Lock className="h-7 w-7" />
        </div>
        <h1 className="mt-5 text-lg font-bold">Enter your PIN</h1>
        <p className="mt-1 text-sm text-muted">Bubaly is locked for your privacy.</p>

        {/* PIN dots */}
        <div className={cn('mt-7 flex items-center gap-4', error && 'animate-shake')}>
          {[0, 1, 2, 3].map((i) => (
            <span key={i}
              className={cn('h-3.5 w-3.5 rounded-full border transition',
                error ? 'border-rose-500 bg-rose-500' :
                i < digits.length ? 'border-brand bg-brand' : 'border-border bg-transparent')} />
          ))}
        </div>
        {inCooldown ? (
          <p className="mt-3 text-xs font-medium text-amber-400">Too many attempts — try again in {cooldownLeft}s</p>
        ) : error ? (
          <p className="mt-3 text-xs font-medium text-rose-400">Wrong PIN — try again</p>
        ) : null}

        {/* Keypad */}
        <div className="mt-8 grid grid-cols-3 gap-3">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((n) => (
            <button key={n} onClick={() => press(n)} disabled={checking || inCooldown}
              className="h-16 w-16 rounded-full border border-border bg-surface/50 text-2xl font-semibold transition hover:bg-elevated active:scale-95 disabled:opacity-50">
              {n}
            </button>
          ))}
          <span />
          <button onClick={() => press('0')} disabled={checking || inCooldown}
            className="h-16 w-16 rounded-full border border-border bg-surface/50 text-2xl font-semibold transition hover:bg-elevated active:scale-95 disabled:opacity-50">
            0
          </button>
          <button onClick={back} disabled={checking || digits.length === 0} aria-label="Delete"
            className="grid h-16 w-16 place-items-center rounded-full text-muted transition hover:bg-elevated active:scale-95 disabled:opacity-30">
            <Delete className="h-6 w-6" />
          </button>
        </div>

        {/* The escape hatch — can never trap a forgotten PIN. */}
        <form action="/auth/signout" method="post" className="mt-9">
          <button type="submit" className="flex items-center gap-1.5 text-xs font-medium text-muted transition hover:text-fg">
            <LogOut className="h-3.5 w-3.5" /> Forgot PIN? Sign out
          </button>
        </form>
      </div>
    </div>
  );
}
