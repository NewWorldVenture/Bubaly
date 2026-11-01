// The weekly digest goes to one parent or adult per family, and it has to be
// one who can actually receive it.
//
// The cron picked that person with `.in('role', ['parent', 'adult']).limit(1)`
// and no order, then skipped the family when the row it got had no login
// (`user_id` null — a parent or adult added as a managed profile, which the
// family page and onboarding both allow). The parent WITH a login was never
// considered, and the family was counted as an ordinary skip, not a failure.
// Without an order, the row Postgres returns first is whatever the table or
// index yields: an update to a member row (a profile save rewrites
// `display_name`) can move it, so a family that got the digest one Monday could
// silently stop getting it the next, or get it at a different parent.
//
// The recipient is now the earliest-joined active parent or adult (created_at,
// then id) who has a login and an email on file. That person's own email
// opt-out still withholds the digest without falling back to another parent
// (tests/weekly-digest-email-preference.test.ts holds that decision).
//
// The fake below is the real supabase-js client over a synthetic fetch that
// applies the filters, the order and the limit the route sends, and otherwise
// answers in a "storage order" that is deliberately not the join order.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';

type Member = { id: string; family_id: string; user_id: string | null; display_name: string; role: string; is_active: boolean; created_at: string };
const FAMILY = '10000000-0000-4000-8000-000000000001';
const MOM = '00000000-0000-4000-8000-000000000001';
const DAD = '00000000-0000-4000-8000-000000000002';

const h = vi.hoisted(() => ({
  db: null as unknown,
  members: [] as Member[],
  emails: new Map<string, string>(),
  optedOut: new Set<string>(),
  sends: [] as string[],
  preferenceReads: [] as string[],
}));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db }));
vi.mock('@/lib/server/cron-auth', () => ({ hasCronAuthorization: () => true }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/network/compare-line-server', () => ({ loadCompareLine: async () => null }));
vi.mock('@/lib/network/compare-line', () => ({ renderCompareLine: () => null }));
vi.mock('@/lib/emails/weekly-digest', () => ({ WeeklyDigestEmail: () => null }));
vi.mock('@/lib/server/list-all-auth-users', () => ({ listAllAuthUsers: async () => ({
  users: [...h.emails].map(([id, email]) => ({ id, email })), error: null,
}) }));
vi.mock('@/lib/email', () => ({ sendReactEmail: async ({ to }: { to: string }) => { h.sends.push(to); return { ok: true }; } }));
import { GET } from '@/app/api/cron/weekly-digest/route';

function member(id: number, fields: Partial<Member>): Member {
  return {
    id: `20000000-0000-4000-8000-${String(id).padStart(12, '0')}`, family_id: FAMILY, user_id: null,
    display_name: `Member ${id}`, role: 'parent', is_active: true, created_at: '2026-01-01T00:00:00.000Z', ...fields,
  };
}

/** PostgREST's `eq.` / `in.(…)` / `is.null` / `not.is.null` on one column. */
function keep(row: Record<string, unknown>, key: string, value: string): boolean {
  const cell = row[key];
  if (value === 'is.null') return cell == null;
  if (value === 'not.is.null') return cell != null;
  if (value.startsWith('eq.')) return String(cell) === value.slice(3);
  if (value.startsWith('in.(')) return value.slice(4, -1).split(',').includes(String(cell));
  throw new Error(`Unsupported synthetic filter ${key}=${value}`);
}

beforeEach(() => {
  h.members = []; h.emails = new Map(); h.optedOut = new Set(); h.sends = []; h.preferenceReads = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
  h.db = createClient('https://synthetic.invalid', 'synthetic-non-provider-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      const method = init?.method ?? 'GET';
      if (url.origin !== 'https://synthetic.invalid' || !['GET', 'HEAD'].includes(method)) throw new Error('Unexpected synthetic transport');
      const table = url.pathname.split('/').at(-1);
      const single = new Headers(init?.headers).get('accept')?.includes('object+json') ?? false;
      let rows: Record<string, unknown>[];
      if (table === 'families') rows = [{ id: FAMILY, name: 'Synthetic family', timezone: 'UTC' }];
      else if (table === 'family_members') rows = h.members.map((m) => ({ ...m }));
      else if (table === 'user_preferences') {
        const own = url.searchParams.get('user_id')?.slice(3) ?? '';
        h.preferenceReads.push(own);
        rows = h.optedOut.has(own) ? [{ user_id: own, email_enabled: false }] : [];
      } else if (['calendar_events', 'chore_assignments', 'meal_plans'].includes(table ?? '')) rows = [];
      else throw new Error(`Unexpected table ${table}`);
      for (const [key, value] of url.searchParams) {
        if (['select', 'order', 'offset', 'limit', 'or'].includes(key)) continue;
        rows = rows.filter((row) => !(key in row) || keep(row, key, value));
      }
      const order = url.searchParams.get('order');
      if (order) {
        const keys = order.split(',').map((part) => { const [column, direction] = part.split('.'); return { column, sign: direction === 'desc' ? -1 : 1 }; });
        rows = [...rows].sort((a, b) => {
          for (const { column, sign } of keys) {
            const left = String(a[column] ?? ''), right = String(b[column] ?? '');
            if (left !== right) return (left < right ? -1 : 1) * sign;
          }
          return 0;
        });
      }
      const from = Number(url.searchParams.get('offset') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? rows.length);
      const page = rows.slice(from, from + limit);
      return new Response(method === 'HEAD' ? null : JSON.stringify(single ? page[0] ?? null : page), {
        status: 200, headers: { 'content-type': 'application/json', 'content-range': `*/${rows.length}` },
      });
    } },
  });
});
afterEach(() => vi.restoreAllMocks());
const run = () => GET(new NextRequest('https://synthetic.invalid/api/cron/weekly-digest'));

describe('the weekly digest reaches a parent who can read it', () => {
  it('goes to the parent with a login when a parent without one is stored first', async () => {
    h.members = [
      member(1, { display_name: 'Grandpa (no login)', role: 'adult', created_at: '2026-02-01T00:00:00.000Z' }),
      member(2, { display_name: 'Mom', user_id: MOM, created_at: '2026-01-01T00:00:00.000Z' }),
    ];
    h.emails.set(MOM, 'mom@synthetic.invalid');
    const res = await run();
    expect(await res.json()).toEqual({ sent: 1, failed: 0, skipped: 0 });
    expect(h.sends).toEqual(['mom@synthetic.invalid']);
  });

  it('passes over an earlier-joined managed parent with no login', async () => {
    // Onboarding adds the other parent as a managed profile in the same run.
    h.members = [
      member(1, { display_name: 'Dad (managed)', created_at: '2026-01-01T00:00:00.000Z' }),
      member(2, { display_name: 'Mom', user_id: MOM, created_at: '2026-01-01T00:00:01.000Z' }),
    ];
    h.emails.set(MOM, 'mom@synthetic.invalid');
    await run();
    expect(h.sends).toEqual(['mom@synthetic.invalid']);
  });

  it('goes to the same, earliest-joined, manager whatever order the rows are stored in', async () => {
    // Dad's member id sorts first, so only the join time can put Mom first.
    const mom = member(4, { display_name: 'Mom', user_id: MOM, created_at: '2026-01-01T00:00:00.000Z' });
    const dad = member(3, { display_name: 'Dad', user_id: DAD, role: 'adult', created_at: '2026-03-01T00:00:00.000Z' });
    h.emails.set(MOM, 'mom@synthetic.invalid').set(DAD, 'dad@synthetic.invalid');
    for (const stored of [[dad, mom], [mom, dad]]) {
      h.members = stored; h.sends = [];
      await run();
      expect(h.sends).toEqual(['mom@synthetic.invalid']);
    }
  });

  it('settles two managers who joined at the same instant by member id', async () => {
    const first = member(5, { display_name: 'Mom', user_id: MOM });
    const second = member(6, { display_name: 'Dad', user_id: DAD });
    h.emails.set(MOM, 'mom@synthetic.invalid').set(DAD, 'dad@synthetic.invalid');
    for (const stored of [[second, first], [first, second]]) {
      h.members = stored; h.sends = [];
      await run();
      expect(h.sends).toEqual(['mom@synthetic.invalid']);
    }
  });

  it('passes over a manager whose account has no email on file', async () => {
    h.members = [
      member(2, { display_name: 'Mom', user_id: MOM, created_at: '2026-01-01T00:00:00.000Z' }),
      member(3, { display_name: 'Dad', user_id: DAD, created_at: '2026-02-01T00:00:00.000Z' }),
    ];
    h.emails.set(DAD, 'dad@synthetic.invalid');
    await run();
    expect(h.sends).toEqual(['dad@synthetic.invalid']);
  });

  it('still honours the chosen parent’s own opt-out, without choosing another', async () => {
    h.members = [
      member(1, { display_name: 'Grandpa (no login)', role: 'adult', created_at: '2025-12-01T00:00:00.000Z' }),
      member(2, { display_name: 'Mom', user_id: MOM, created_at: '2026-01-01T00:00:00.000Z' }),
      member(3, { display_name: 'Dad', user_id: DAD, created_at: '2026-02-01T00:00:00.000Z' }),
    ];
    h.emails.set(MOM, 'mom@synthetic.invalid').set(DAD, 'dad@synthetic.invalid');
    h.optedOut.add(MOM);
    const res = await run();
    expect(await res.json()).toEqual({ sent: 0, failed: 0, skipped: 1 });
    expect(h.sends).toEqual([]);
    expect(h.preferenceReads).toEqual([MOM]);
  });

  it('skips a family whose parents and adults all lack a login, reading no preference', async () => {
    h.members = [
      member(1, { display_name: 'Managed parent' }),
      member(2, { display_name: 'A child with a login', user_id: MOM, role: 'child' }),
    ];
    h.emails.set(MOM, 'kid@synthetic.invalid');
    const res = await run();
    expect(await res.json()).toEqual({ sent: 0, failed: 0, skipped: 1 });
    expect(h.sends).toEqual([]);
    expect(h.preferenceReads).toEqual([]);
  });
});
