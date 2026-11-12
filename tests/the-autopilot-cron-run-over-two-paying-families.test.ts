// The nightly Autopilot cron, driven through its real route, the real
// entitlement resolver, the real scan and the real notifications service,
// against the in-memory database. Nothing is stubbed but the session-less
// translator: the cron authorization is the real one, over a stubbed secret.
//
// Two paying households each have a passport renewal five days out — a
// high-confidence draft the scan auto-executes (a reminder) and announces (a
// notification). Beside them: a closed household and a Free one with the same
// renewal, and inside household A a guest (renewals are not a guest's,
// lib/autopilot/audience.ts) and a member who has left (is_active false).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({ db: null as unknown, clients: 0 }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => { h.clients++; return h.db; } }));

const { GET } = await import('@/app/api/cron/autopilot-scan/route');

const SECRET = 'test-cron-secret-not-real';
const NOW = new Date('2026-11-12T12:00:00.000Z');
const A = '00000000-0000-4000-8000-0000000000a1';
const B = '00000000-0000-4000-8000-0000000000b1';
const CLOSED = '00000000-0000-4000-8000-0000000000c1';
const FREE = '00000000-0000-4000-8000-0000000000d1';
const U = {
  aParent: '00000000-0000-4000-8000-00000000a0a1',
  aGuest: '00000000-0000-4000-8000-00000000a0a2',
  aLeft: '00000000-0000-4000-8000-00000000a0a3',
  bParent: '00000000-0000-4000-8000-00000000b0b1',
  cParent: '00000000-0000-4000-8000-00000000c0c1',
  dParent: '00000000-0000-4000-8000-00000000d0d1',
};

let db: InMemorySupabase;
const req = (authorization?: string) => new Request('https://bubaly.test/api/cron/autopilot-scan', {
  headers: authorization ? { authorization } : {},
}) as never;
const authorized = () => req(`Bearer ${SECRET}`);
const rowsOf = (table: string, familyId: string) => db.table(table).filter((r) => r.family_id === familyId);

function seed() {
  db.seed('families', [
    { id: A, name: 'Household A', timezone: 'Europe/Berlin', trial_ends_at: null, closed_at: null },
    { id: B, name: 'Household B', timezone: 'America/New_York', trial_ends_at: null, closed_at: null },
    { id: CLOSED, name: 'Closed household', timezone: 'UTC', trial_ends_at: null, closed_at: '2026-10-01T00:00:00.000Z' },
    { id: FREE, name: 'Free household', timezone: 'UTC', trial_ends_at: null, closed_at: null },
  ]);
  db.seed('subscriptions', [
    { family_id: A, plan: 'plus', status: 'active' },
    { family_id: B, plan: 'plus', status: 'active' },
    { family_id: CLOSED, plan: 'plus', status: 'active' },
  ]);
  db.seed('family_members', [
    { id: '00000000-0000-4000-8000-0000000a0001', family_id: A, user_id: U.aParent, role: 'parent', display_name: 'Parent A', is_active: true },
    { id: '00000000-0000-4000-8000-0000000a0002', family_id: A, user_id: U.aGuest, role: 'guest', display_name: 'Guest A', is_active: true },
    { id: '00000000-0000-4000-8000-0000000a0003', family_id: A, user_id: U.aLeft, role: 'adult', display_name: 'Former A', is_active: false },
    { id: '00000000-0000-4000-8000-0000000b0001', family_id: B, user_id: U.bParent, role: 'parent', display_name: 'Parent B', is_active: true },
    { id: '00000000-0000-4000-8000-0000000c0001', family_id: CLOSED, user_id: U.cParent, role: 'parent', display_name: 'Parent C', is_active: true },
    { id: '00000000-0000-4000-8000-0000000d0001', family_id: FREE, user_id: U.dParent, role: 'parent', display_name: 'Parent D', is_active: true },
  ]);
  db.seed('renewals', [
    { id: '00000000-0000-4000-8000-00000000aa01', family_id: A, title: 'Passport Alpha', expires_at: '2026-11-17', status: 'active' },
    { id: '00000000-0000-4000-8000-00000000bb01', family_id: B, title: 'Passport Bravo', expires_at: '2026-11-17', status: 'active' },
    { id: '00000000-0000-4000-8000-00000000cc01', family_id: CLOSED, title: 'Passport Charlie', expires_at: '2026-11-17', status: 'active' },
    { id: '00000000-0000-4000-8000-00000000dd01', family_id: FREE, title: 'Passport Delta', expires_at: '2026-11-17', status: 'active' },
  ]);
}

/** Every table touched, through `from` or `rpc`, on the client the route is handed. */
function recording(target: InMemorySupabase) {
  const touched: string[] = [];
  const client = new Proxy(target as object, {
    get(obj, prop, receiver) {
      if (prop === 'from' || prop === 'rpc') {
        return (name: string, ...rest: unknown[]) => {
          touched.push(`${String(prop)}:${name}`);
          return (Reflect.get(obj, prop, receiver) as (...a: unknown[]) => unknown).call(obj, name, ...rest);
        };
      }
      return Reflect.get(obj, prop, receiver);
    },
  });
  return { client, touched };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  vi.stubEnv('CRON_SECRET', SECRET);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db = createInMemorySupabase({ uniques: { autopilot_suggestions: [['family_id', 'dedupe_key']], app_settings: [['key']] } });
  seed();
  h.db = db;
  h.clients = 0;
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('authorization', () => {
  it('API-C70A0D9938B0 JOB-195C977F1087: refuses a request with no Authorization header before any read', async () => {
    const { client, touched } = recording(db);
    h.db = client;
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(touched).toEqual([]);
    expect(h.clients).toBe(0);
    expect(db.table('autopilot_suggestions')).toEqual([]);
    expect(db.table('notifications')).toEqual([]);
  });

  it('API-C70A0D9938B0 JOB-195C977F1087: refuses a wrong secret before any read', async () => {
    const { client, touched } = recording(db);
    h.db = client;
    const res = await GET(req('Bearer wrong-cron-secret-not-real'));
    expect(res.status).toBe(401);
    expect(touched).toEqual([]);
    expect(h.clients).toBe(0);
    expect(db.table('reminders')).toEqual([]);
  });

  it('API-C70A0D9938B0 JOB-195C977F1087: refuses every request while CRON_SECRET is unset, the right-looking bearer included', async () => {
    vi.stubEnv('CRON_SECRET', '');
    const { client, touched } = recording(db);
    h.db = client;
    const res = await GET(req('Bearer '));
    expect(res.status).toBe(401);
    expect(touched).toEqual([]);
  });

  it('API-C70A0D9938B0 JOB-195C977F1087: runs with the right secret', async () => {
    const res = await GET(authorized());
    expect(res.status).toBe(200);
  });
});

describe('a populated run', () => {
  it('API-C70A0D9938B0 JOB-195C977F1087: scans the two paying open families, skips the Free one, leaves the closed one out, and answers what it did', async () => {
    const res = await GET(authorized());
    const body = await res.json();

    expect(res.status).toBe(200);
    // The closed family is not even read (families.closed_at filter); the Free one is read and skipped.
    expect(body).toMatchObject({
      ok: true, families: 3, entitled: 2, skipped: 1, scanned: 2, autoExecuted: 2, notified: 2, failures: 0, unreached: 0, unreachedFamilies: [],
    });

    const expected = [
      [A, 'Passport Alpha', '00000000-0000-4000-8000-00000000aa01'],
      [B, 'Passport Bravo', '00000000-0000-4000-8000-00000000bb01'],
    ] as const;
    for (const [family, title, renewalId] of expected) {
      const cards = rowsOf('autopilot_suggestions', family);
      expect(cards.map((c) => [c.dedupe_key, c.status, c.source_id])).toEqual([[`renewal:${renewalId}:2026-11-17`, 'auto_executed', renewalId]]);
      expect(cards[0].title).toContain(title);
      const reminders = rowsOf('reminders', family);
      expect(reminders.map((r) => [r.title, r.related_id])).toEqual([[`Renew ${title}`, renewalId]]);
    }
    for (const family of [CLOSED, FREE]) {
      expect(rowsOf('autopilot_suggestions', family)).toEqual([]);
      expect(rowsOf('reminders', family)).toEqual([]);
      expect(rowsOf('notifications', family)).toEqual([]);
    }
  });

  it('API-C70A0D9938B0 JOB-195C977F1087: notifies only active members with a login the renewal may reach — not a guest, not a member who left', async () => {
    await GET(authorized());
    expect(rowsOf('notifications', A).map((n) => n.user_id)).toEqual([U.aParent]);
    expect(rowsOf('notifications', B).map((n) => n.user_id)).toEqual([U.bParent]);
    expect(db.table('notifications').map((n) => n.user_id)).not.toContain(U.aGuest);
    expect(db.table('notifications').map((n) => n.user_id)).not.toContain(U.aLeft);
  });
});

describe('family isolation', () => {
  it('API-C70A0D9938B0 JOB-195C977F1087: nothing derived from household A reaches household B, or the other way round', async () => {
    await GET(authorized());
    const text = (family: string) => JSON.stringify([
      rowsOf('autopilot_suggestions', family), rowsOf('reminders', family), rowsOf('notifications', family),
    ]);
    expect(text(A)).toContain('Alpha');
    expect(text(A)).not.toContain('Bravo');
    expect(text(B)).toContain('Bravo');
    expect(text(B)).not.toContain('Alpha');
    // Each notification's card is its own family's card.
    for (const family of [A, B]) {
      const cardIds = rowsOf('autopilot_suggestions', family).map((c) => c.id);
      expect(rowsOf('notifications', family).map((n) => n.related_id)).toEqual(cardIds);
      expect(rowsOf('notifications', family).map((n) => n.user_id))
        .toEqual(db.table('family_members').filter((m) => m.family_id === family && m.role === 'parent').map((m) => m.user_id));
    }
  });
});

describe('idempotence and failure', () => {
  it('API-C70A0D9938B0 JOB-195C977F1087: a second run writes and sends nothing new', async () => {
    await GET(authorized());
    const after = ['autopilot_suggestions', 'reminders', 'notifications'].map((t) => db.table(t).length);

    const res = await GET(authorized());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, entitled: 2, autoExecuted: 0, notified: 0, failures: 0 });
    expect(['autopilot_suggestions', 'reminders', 'notifications'].map((t) => db.table(t).length)).toEqual(after);
    expect(after).toEqual([2, 2, 2]);
  });

  it('API-C70A0D9938B0 JOB-195C977F1087: one family\'s failed read is that family\'s failure, reported as 502, while the other family is still scanned', async () => {
    h.db = withFaults(db, (table, calls) => (table === 'renewals' && calls.some((c) => c.method === 'eq' && c.args[0] === 'family_id' && c.args[1] === A)
      ? { code: '57014', message: 'canceling statement due to statement timeout' } : null));

    const res = await GET(authorized());
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body).toMatchObject({ ok: false, failures: 1, skipped: 1, entitled: 1, scanned: 1, notified: 1 });
    expect(rowsOf('autopilot_suggestions', A)).toEqual([]);
    expect(rowsOf('reminders', A)).toEqual([]);
    expect(rowsOf('notifications', A)).toEqual([]);
    expect(rowsOf('autopilot_suggestions', B)).toHaveLength(1);
    expect(rowsOf('notifications', B)).toHaveLength(1);
  });

  it('API-C70A0D9938B0 JOB-195C977F1087: an unreadable family list fails the run with 500 and scans nobody', async () => {
    h.db = withFaults(db, (table) => (table === 'families' ? { code: '08006', message: 'connection lost' } : null));
    const res = await GET(authorized());
    expect(res.status).toBe(500);
    expect(db.table('autopilot_suggestions')).toEqual([]);
    expect(db.table('notifications')).toEqual([]);
  });
});
