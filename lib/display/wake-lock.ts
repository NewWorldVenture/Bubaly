// lib/display/wake-lock.ts — Screen Wake Lock for the always-on kitchen tablet.
//
// A wall display that dims after 30 seconds is not a wall display. The Screen
// Wake Lock API keeps the panel awake while the tab is visible, and that is the
// whole feature — but it is also one of the most uneven APIs in the browser:
//
//   • it does not exist at all on older iOS Safari, and `navigator` has no
//     `wakeLock` there — reading `.request` off it must not throw;
//   • `request('screen')` REJECTS rather than resolving when the document is
//     hidden, when the page is not fully active, or when the user agent simply
//     refuses (low battery, a policy). A rejected promise here is normal
//     operation, not an error the kiosk should ever see;
//   • the lock is released BY THE BROWSER whenever the tab is hidden, so it has
//     to be re-acquired on `visibilitychange` or it silently stops working the
//     first time somebody switches tabs.
//
// So this module is written to one rule: it never throws and never rejects.
// Every entry point resolves to a state the caller can render honestly, and
// 'unsupported' is a first-class answer rather than a failure — the setup page
// reports what it measured, and "this tablet has no wake lock" is a measurement.
//
// Pure TypeScript with injectable `navigator`/`document`, so the behaviour is
// unit-tested (tests/display-wake-lock.test.ts) without a DOM.

/**
 * What the screen lock is actually doing right now.
 *  - `unsupported` — the browser has no Wake Lock API (nothing was attempted);
 *  - `idle`        — supported, no lock held (never asked, released, or hidden tab);
 *  - `active`      — a sentinel is held and the screen is being kept awake;
 *  - `blocked`     — we asked and the browser said no (hidden document, policy, battery).
 */
export type WakeLockState = 'unsupported' | 'idle' | 'active' | 'blocked';

/** The slice of `WakeLockSentinel` this module uses. */
export type WakeLockSentinelLike = {
  released?: boolean;
  release?: () => Promise<void> | void;
  addEventListener?: (type: 'release', listener: () => void) => void;
  removeEventListener?: (type: 'release', listener: () => void) => void;
};

export type WakeLockNavigatorLike = {
  wakeLock?: { request?: (type: 'screen') => Promise<WakeLockSentinelLike> } | null;
};

export type WakeLockDocumentLike = {
  visibilityState?: string;
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
};

export type WakeLockEnv = {
  /** Defaults to the real `navigator` when there is one. */
  navigator?: WakeLockNavigatorLike | null;
  /** Defaults to the real `document` when there is one. */
  document?: WakeLockDocumentLike | null;
  /** Called on every state transition (React state, the setup card's badge). */
  onChange?: (state: WakeLockState) => void;
};

/** True when this browser exposes `navigator.wakeLock.request`. Never throws. */
export function isWakeLockSupported(nav: unknown): boolean {
  try {
    const lock = (nav as WakeLockNavigatorLike | null | undefined)?.wakeLock;
    return typeof lock?.request === 'function';
  } catch {
    return false;
  }
}

export type WakeLockController = {
  /** Whether the API exists at all — decided once, at creation. */
  readonly supported: boolean;
  /** The current state (also pushed through `onChange`). */
  state: () => WakeLockState;
  /** Ask for the lock. Resolves to the resulting state; never rejects. */
  acquire: () => Promise<WakeLockState>;
  /** Give the lock back. Never rejects. */
  release: () => Promise<void>;
  /** Release and detach the visibility listener (component unmount). */
  stop: () => Promise<void>;
};

function defaultNavigator(): WakeLockNavigatorLike | null {
  return typeof navigator === 'undefined' ? null : (navigator as unknown as WakeLockNavigatorLike);
}

function defaultDocument(): WakeLockDocumentLike | null {
  return typeof document === 'undefined' ? null : (document as unknown as WakeLockDocumentLike);
}

/**
 * A wake lock that re-acquires itself.
 *
 * `acquire()` marks the lock as WANTED: after that, every time the document
 * becomes visible again the controller asks for it once more, because the
 * browser drops the sentinel on hide. `release()` and `stop()` clear that
 * intent, so a caller that deliberately let the screen sleep does not have it
 * silently switched back on by the next tab switch.
 */
export function createWakeLock(env: WakeLockEnv = {}): WakeLockController {
  const nav = env.navigator !== undefined ? env.navigator : defaultNavigator();
  const doc = env.document !== undefined ? env.document : defaultDocument();
  const supported = isWakeLockSupported(nav);

  let state: WakeLockState = supported ? 'idle' : 'unsupported';
  let sentinel: WakeLockSentinelLike | null = null;
  let wanted = false;
  let inFlight: Promise<WakeLockState> | null = null;

  const set = (next: WakeLockState) => {
    if (next === state) return;
    state = next;
    try { env.onChange?.(next); } catch { /* a listener must not break the kiosk */ }
  };

  const onSentinelRelease = () => {
    sentinel = null;
    if (state === 'active') set('idle');
  };

  async function request(): Promise<WakeLockState> {
    if (!supported) return 'unsupported';
    if (sentinel && sentinel.released !== true) { set('active'); return 'active'; }
    try {
      const next = await nav?.wakeLock?.request?.('screen');
      if (!next) { set('blocked'); return 'blocked'; }
      sentinel = next;
      try { next.addEventListener?.('release', onSentinelRelease); } catch { /* optional */ }
      set('active');
      return 'active';
    } catch {
      // A rejection is the documented answer for "hidden document" and "the
      // browser declined": it is a state, never an exception the caller sees.
      sentinel = null;
      set('blocked');
      return 'blocked';
    }
  }

  async function acquire(): Promise<WakeLockState> {
    wanted = true;
    if (!supported) return 'unsupported';
    if (inFlight) return inFlight;
    inFlight = request().finally(() => { inFlight = null; });
    return inFlight;
  }

  async function letGo(): Promise<void> {
    const held = sentinel;
    sentinel = null;
    if (held) {
      try { held.removeEventListener?.('release', onSentinelRelease); } catch { /* optional */ }
      try { await held.release?.(); } catch { /* releasing a dead sentinel is fine */ }
    }
    if (supported) set('idle');
  }

  async function release(): Promise<void> {
    wanted = false;
    await letGo();
  }

  const onVisibility = () => {
    // The browser releases the lock whenever the tab hides; ask again as soon
    // as it is visible, but only if the caller still wants it.
    if (!wanted || !supported) return;
    if (doc?.visibilityState === 'visible') void acquire();
    else { sentinel = null; set('idle'); }
  };

  try { doc?.addEventListener?.('visibilitychange', onVisibility); } catch { /* no document */ }

  async function stop(): Promise<void> {
    wanted = false;
    try { doc?.removeEventListener?.('visibilitychange', onVisibility); } catch { /* no document */ }
    await letGo();
  }

  return { supported, state: () => state, acquire, release, stop };
}
