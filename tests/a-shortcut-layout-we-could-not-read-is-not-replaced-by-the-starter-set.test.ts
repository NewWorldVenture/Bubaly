// A shortcut layout we COULD NOT READ is not a layout the member never made.
//
// loadCaptureShortcuts destructured only `data` from the PostgREST read, and
// postgrest-js RESOLVES with { data: null, error } instead of throwing — so a
// statement timeout, a 5xx or an expired JWT arrived at the caller spelled exactly
// like "this member has never customized their shortcuts". The Capture grid then
// paints the starter six (calendar, tasks, grocery, home, health, trip), and
// `persist` (components/capture/capture-shortcuts.tsx) writes the WHOLE visible
// array: one tap on a tile's small red × wrote those six over the member's real
// layout, on every device they own. A member who had deliberately pinned
// notes/journal/habits — or deliberately pinned nothing — lost it silently,
// because by the time the SAVE ran its own read the blip had passed and the write
// succeeded. The already-landed guard in saveCaptureShortcutsAction does not help
// here: that one protects the OTHER notification_prefs keys when the save's own
// pre-read fails, not the shortcut layout when the earlier LOAD failed.
//
// So this drives the REAL server action against a fake PostgREST and the REAL
// hook, and asserts what is left in user_preferences afterwards — what the family
// actually sees the next time they open Capture.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  slots: [] as unknown[],
  cursor: 0,
  effects: [] as Array<() => void | (() => void)>,
  toast: vi.fn(),
  cache: null as string | null,
  requireUserContext: vi.fn(),
  createServer: vi.fn(),
}));

// Run the hook as a plain function: state and refs live in `slots` so the mount
// effect can be invoked for real and the same refs observed afterwards. No DOM
// package is installed; this intentionally does not emulate a browser.
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useState: (initial: unknown) => {
    const index = harness.cursor++;
    if (!(index in harness.slots)) {
      harness.slots[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
    }
    return [harness.slots[index], (next: unknown) => {
      harness.slots[index] = typeof next === 'function'
        ? (next as (prev: unknown) => unknown)(harness.slots[index]) : next;
    }];
  },
  useRef: (initial: unknown) => {
    const index = harness.cursor++;
    if (!(index in harness.slots)) harness.slots[index] = { current: initial };
    return harness.slots[index];
  },
  useEffect: (fn: () => void | (() => void)) => { harness.effects.push(fn); },
}));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ error: harness.toast }) }));
vi.mock('@/components/i18n/locale-provider', () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => ({ code: 'en-US' }),
}));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: harness.requireUserContext }));
vi.mock('@/lib/supabase/server', () => ({ createServer: harness.createServer }));

const { useCaptureShortcuts } = await import('@/components/capture/capture-shortcuts');
const { loadCaptureShortcuts } = await import('@/app/(app)/capture/shortcuts-actions');
const { DEFAULT_CAPTURE_SHORTCUTS } = await import('@/lib/capture/shortcuts');

// The member's real shortcuts, pinned on another device, plus the rest of the
// shared blob that lives in the same jsonb column.
const SAVED_LAYOUT = ['notes', 'journal', 'habits'];
const OTHER_PREFS = {
  appLock: { enabled: true, salt: 'salt-a', hash: 'hash-a' },
  googleCalendarToken: { refresh_token: 'token-a' },
  quietHours: { start: '21:00', end: '07:00' },
};

let prefs: Record<string, unknown> | null;
let readFails: boolean;
let writes: number;

// Chainable PostgREST stub. A refused read RESOLVES with an error, exactly as
// postgrest-js does — that is the whole reason the defect was invisible.
function from(_table: string) {
  const query: Record<string, unknown> = {};
  Object.assign(query, {
    select: () => query,
    eq: () => query,
    maybeSingle: async () => (readFails
      ? { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } }
      : { data: prefs === null ? null : { notification_prefs: { ...prefs } }, error: null }),
    upsert: async (row: { notification_prefs: Record<string, unknown> }) => {
      writes += 1;
      prefs = { ...row.notification_prefs };
      return { data: null, error: null };
    },
  });
  return query;
}

/** What is actually in user_preferences.notification_prefs right now. */
const stored = () => prefs;

const flush = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

// Named `use…` because they ARE hook call sites (react-hooks/rules-of-hooks).
function useShortcutsMounted(initialKeys?: string[] | null) {
  harness.slots = [];
  harness.cursor = 0;
  harness.effects = [];
  return useCaptureShortcuts(initialKeys);
}
async function runMountEffect() {
  const effect = harness.effects[0];
  expect(effect, 'the hook registers a mount effect').toBeTypeOf('function');
  effect();
  await flush();
}
/** Re-render: `keys` from the first call is a snapshot, so read the slot again. */
function useShortcutsRerendered(initialKeys?: string[] | null) {
  const registered = harness.effects.length;
  harness.cursor = 0;
  const view = useCaptureShortcuts(initialKeys);
  harness.effects.length = registered;  // a re-render does not re-run a mount effect
  return view;
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  harness.toast.mockReset();
  harness.cache = null;
  prefs = { ...OTHER_PREFS, captureShortcuts: [...SAVED_LAYOUT] };
  readFails = false;
  writes = 0;
  harness.requireUserContext.mockReset().mockResolvedValue({ user: { id: 'user-1', email: 'parent@example.com' } });
  harness.createServer.mockReset().mockResolvedValue({ from });
  vi.stubGlobal('localStorage', {
    getItem: () => harness.cache,
    setItem: (_key: string, value: string) => { harness.cache = value; },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a Capture shortcut layout that could not be read', () => {
  it('is reported as a failed read, not as a member who never customized', async () => {
    readFails = true;

    const read = await loadCaptureShortcuts();

    expect(read.ok, 'a read that failed is not a read that found nothing').toBe(false);
    // The two answers that DO mean "use the starter set" stay distinguishable.
    prefs = null;
    readFails = false;
    expect(await loadCaptureShortcuts()).toEqual({ ok: true, keys: null });
    prefs = { ...OTHER_PREFS, captureShortcuts: [...SAVED_LAYOUT] };
    expect(await loadCaptureShortcuts()).toEqual({ ok: true, keys: SAVED_LAYOUT });
  });

  it('survives the member editing the starter set that was shown in its place', async () => {
    readFails = true;      // Supabase is blipping
    harness.cache = null;  // a fresh phone: this device has never cached anything

    // Exactly what app/(app)/capture/page.tsx does on the server, then hands down.
    const ssr = await loadCaptureShortcuts();
    const initialKeys = ssr.ok ? ssr.keys : null;

    const view = useShortcutsMounted(initialKeys);
    expect(view.keys, 'the grid paints the starter six — a guess, not their layout')
      .toEqual(DEFAULT_CAPTURE_SHORTCUTS);
    await runMountEffect();  // the background retry fails too

    readFails = false;       // the blip passes, seconds later

    // The member taps the small red × on the "Calendar" starter tile.
    view.persist(DEFAULT_CAPTURE_SHORTCUTS.filter((key) => key !== 'calendar'));
    await flush();

    // What the family sees next time they open Capture: their own shortcuts.
    expect(stored()?.captureShortcuts, 'their pinned shortcuts are still theirs').toEqual(SAVED_LAYOUT);
    expect(writes, 'a layout we never managed to read must not be written back').toBe(0);
    expect(harness.cache, 'nor cached on this device as though it were theirs').toBe(null);
    expect(stored(), 'and nothing else in the shared blob moved').toMatchObject(OTHER_PREFS);
    // The refusal is visible — it is not a silent no-op.
    expect(harness.toast).toHaveBeenCalledWith('captureShortcuts.layoutUnavailable');
  });

  it('does not hand six shortcuts back to a member who deliberately pinned none', async () => {
    prefs = { ...OTHER_PREFS, captureShortcuts: [] };
    readFails = true;

    const ssr = await loadCaptureShortcuts();
    const view = useShortcutsMounted(ssr.ok ? ssr.keys : null);
    await runMountEffect();
    readFails = false;

    view.persist([...DEFAULT_CAPTURE_SHORTCUTS, 'notes']);  // they add one to the guessed grid
    await flush();

    expect(stored()?.captureShortcuts, 'choosing no shortcuts is a choice').toEqual([]);
    expect(writes).toBe(0);
  });

  // Controls: the gate is "we do not know your layout", NOT "saving is off".
  it('still saves the first customization of a member who genuinely has nothing saved', async () => {
    prefs = null;  // no preferences row at all

    const ssr = await loadCaptureShortcuts();
    expect(ssr).toEqual({ ok: true, keys: null });
    const view = useShortcutsMounted(ssr.ok ? ssr.keys : null);
    await runMountEffect();

    view.persist(['notes', 'journal']);
    await flush();

    expect(stored()?.captureShortcuts).toEqual(['notes', 'journal']);
    expect(harness.toast).not.toHaveBeenCalled();
  });

  it('still lets a device that already knows the layout edit it through a blip', async () => {
    readFails = true;                                  // the load fails…
    harness.cache = JSON.stringify(SAVED_LAYOUT);      // …but this device has their layout

    const view = useShortcutsMounted(null);
    await runMountEffect();
    expect(useShortcutsRerendered(null).keys, 'the cached copy is painted').toEqual(SAVED_LAYOUT);
    readFails = false;

    view.persist(['notes', 'journal']);
    await flush();

    expect(stored()?.captureShortcuts).toEqual(['notes', 'journal']);
    expect(stored()).toMatchObject(OTHER_PREFS);
    expect(harness.toast).not.toHaveBeenCalled();
  });
});
