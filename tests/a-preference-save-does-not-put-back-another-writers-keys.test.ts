// SRV-001 l7 — a preference save does not put back another writer's keys.
//
// user_preferences.notification_prefs is one JSON blob shared by App Lock, the
// capture shortcuts, the Google Calendar token, moment-prep state and more.
// Every writer did read → merge → write of the WHOLE blob with nothing tying
// the write to the read, so two writers overlapping put back what the first
// had read. Turning App Lock on while a shortcut save landed from another tab
// said "App Lock is on" and stored the old config; the Google sync, holding
// its read across a Google call of up to 15 s, erased any change made in that
// window.
//
// mergeNotificationPrefs writes with a compare-and-set on updated_at and
// re-merges on a miss. These cases put a second writer BETWEEN the read and
// the write — the interleaving the old code lost — and require both writers'
// keys to survive.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({ user: { id: 'user-1' }, active: { familyId: 'family-1', role: 'parent', member: { id: 'm1' } } }),
}));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

const { mergeNotificationPrefs } = await import('@/lib/preferences/notification-prefs');
const { saveAppLockConfig } = await import('@/app/(app)/settings/app-lock-actions');
const { saveCaptureShortcutsAction } = await import('@/app/(app)/capture/shortcuts-actions');

let db: InMemorySupabase;
const prefs = () => (db.table('user_preferences')[0] as { notification_prefs: Record<string, unknown> } | undefined)?.notification_prefs;
const LOCK = { enabled: true, salt: 'c2FsdHNhbHRzYWx0c2FsdA==', hash: 'aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g=' };

/** The row as another tab or the Google sync would leave it: a new key, and — as the
 *  table's trigger does on every update — a new updated_at. */
function anotherWriterSets(key: string, value: unknown, at: string) {
  const row = db.table('user_preferences')[0] as { notification_prefs: Record<string, unknown>; updated_at: string };
  row.notification_prefs = { ...row.notification_prefs, [key]: value };
  row.updated_at = at;
}

/** Let the Nth read of user_preferences through, then run `between` before the caller writes. */
function interleaveAfterRead(n: number, between: () => void, afterEvery?: () => void) {
  const from = db.from.bind(db);
  let reads = 0;
  vi.spyOn(db, 'from').mockImplementation(((table: string) => {
    const q = from(table);
    if (table !== 'user_preferences') return q;
    const select = q.select.bind(q);
    return Object.assign(q, {
      select: (...args: Parameters<typeof select>) => {
        const chain = select(...args);
        const maybeSingle = chain.maybeSingle.bind(chain);
        return Object.assign(chain, {
          maybeSingle: async () => {
            const result = await maybeSingle();
            reads += 1;
            if (reads === n) between();
            afterEvery?.();
            return result;
          },
        });
      },
    });
  }) as typeof db.from);
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase();
  db.seed('user_preferences', [{
    user_id: 'user-1', updated_at: '2026-09-27T10:00:00.000Z',
    notification_prefs: { googleCalendarToken: 'enc:v1:old', quietHours: { start: '21:00' } },
  }]);
  h.db = db;
});

describe('mergeNotificationPrefs', () => {
  it('re-merges onto the newer row when another writer lands between the read and the write', async () => {
    interleaveAfterRead(1, () => anotherWriterSets('captureShortcuts', ['tasks'], '2026-09-27T10:00:01.000Z'));
    const res = await mergeNotificationPrefs(db as never, 'user-1', (p) => ({ ...p, appLock: LOCK }));
    expect(res.ok).toBe(true);
    expect(prefs()).toEqual({
      googleCalendarToken: 'enc:v1:old', quietHours: { start: '21:00' },
      captureShortcuts: ['tasks'], appLock: LOCK,
    });
  });

  it('writes nothing when the read fails — never merges into {}', async () => {
    const from = db.from.bind(db);
    vi.spyOn(db, 'from').mockImplementation(((table: string) => {
      const q = from(table);
      if (table !== 'user_preferences') return q;
      return Object.assign(q, { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { code: '57014' } }) }) }) });
    }) as typeof db.from);
    const res = await mergeNotificationPrefs(db as never, 'user-1', (p) => ({ ...p, appLock: LOCK }));
    expect(res).toEqual({ ok: false, reason: 'read_failed', error: { code: '57014' } });
    vi.restoreAllMocks();
    expect(prefs()).toEqual({ googleCalendarToken: 'enc:v1:old', quietHours: { start: '21:00' } });
  });

  it('creates the row for a member who has none', async () => {
    db.replace('user_preferences', []);
    const res = await mergeNotificationPrefs(db as never, 'user-1', (p) => ({ ...p, captureShortcuts: ['notes'] }));
    expect(res.ok).toBe(true);
    expect(prefs()).toEqual({ captureShortcuts: ['notes'] });
  });

  it('gives up without writing when it loses every attempt', async () => {
    // Another writer lands after EVERY read, so each compare-and-set misses.
    let tick = 0;
    interleaveAfterRead(Infinity, () => undefined, () =>
      anotherWriterSets('other', ++tick, `2026-09-27T10:01:${String(tick).padStart(2, '0')}.000Z`));
    const res = await mergeNotificationPrefs(db as never, 'user-1', (p) => ({ ...p, appLock: LOCK }), 3);
    expect(res).toEqual({ ok: false, reason: 'contended' });
    expect(tick).toBeGreaterThanOrEqual(3); // at least one lost race per attempt
    expect(prefs()?.appLock).toBeUndefined();
  });
});

describe('the writers use it', () => {
  it('App Lock turned on while a shortcut save lands keeps both', async () => {
    interleaveAfterRead(1, () => anotherWriterSets('captureShortcuts', ['grocery', 'tasks'], '2026-09-27T10:00:02.000Z'));
    expect(await saveAppLockConfig(LOCK)).toEqual({ ok: true });
    expect(prefs()).toMatchObject({ appLock: LOCK, captureShortcuts: ['grocery', 'tasks'], googleCalendarToken: 'enc:v1:old' });
  });

  it('a shortcut save while App Lock is turned on keeps the lock', async () => {
    interleaveAfterRead(1, () => anotherWriterSets('appLock', LOCK, '2026-09-27T10:00:03.000Z'));
    expect(await saveCaptureShortcutsAction({ keys: ['notes'] })).toEqual({ ok: true });
    expect(prefs()).toMatchObject({ appLock: LOCK, captureShortcuts: ['notes'] });
  });
});
