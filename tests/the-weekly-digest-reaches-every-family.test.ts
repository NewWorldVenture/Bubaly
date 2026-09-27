// The weekly digest, driven rather than spell-checked.
//
// This file replaces nine `expect(<source text>).toContain('<identifier>')`
// assertions that never imported the route. Reasoned through, three real
// regressions left that guard green: emptying the body of an error branch while
// keeping its condition, dropping `else failed++`, and — the one that mattered —
// the recipient read being a single page, which no string in it mentioned at all.
//
// `supabase.auth.admin.listUsers()` with no arguments returns FIFTY users. Every
// family whose admin fell outside that page had no email on file, hit
// `if (!adminEmail) continue;`, and was dropped without incrementing `failed`.
// The route then answered 200 with `failed: 0` while most of the customer base
// received nothing — a cron reporting a clean run it did not have.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  families: [] as Row[],
  members: [] as Row[],
  users: [] as { id: string; email: string | null }[],
  /** GoTrue's page size. Fifty is the real default; cases override it. */
  authPageSize: 50,
  authError: null as null | { message: string },
  familiesError: null as null | { message: string },
  memberError: null as null | { message: string },
  sends: [] as string[],
  failSendTo: null as string | null,
}));

vi.mock('@/lib/server/cron-auth', () => ({ hasCronAuthorization: () => true }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/network/compare-line-server', () => ({ loadCompareLine: async () => null }));
vi.mock('@/lib/network/compare-line', () => ({ renderCompareLine: () => null }));
vi.mock('@/lib/emails/weekly-digest', () => ({ WeeklyDigestEmail: () => null }));
vi.mock('@/lib/email', () => ({
  sendReactEmail: async ({ to }: { to: string }) => {
    state.sends.push(to);
    return { ok: state.failSendTo !== to };
  },
}));

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    auth: {
      admin: {
        listUsers: async ({ page, perPage }: { page: number; perPage: number }) => {
          if (state.authError) return { data: null, error: state.authError };
          // GoTrue caps perPage at its own page size; the helper must not read a
          // short page as the end of the table.
          const size = Math.min(perPage, state.authPageSize);
          const slice = state.users.slice((page - 1) * size, page * size);
          return { data: { users: slice }, error: null };
        },
      },
    },
    from: (table: string) => {
      const filters: Row = {};
      let head = false;
      const rows = () => {
        const source = table === 'families' ? state.families
          : table === 'family_members' ? state.members
          : [];
        return source.filter((r) => Object.entries(filters).every(([c, v]) => {
          if (c === 'range') return true;
          if (c === 'roles') return (v as string[]).includes(String(r.role));
          return r[c] === v;
        }));
      };
      const settle = () => {
        if (table === 'families' && state.familiesError) return { data: null, error: state.familiesError };
        if (table === 'family_members' && state.memberError) return { data: null, error: state.memberError };
        const all = rows();
        const range = filters.range as [number, number] | undefined;
        const page = range ? all.slice(range[0], range[1] + 1) : all;
        return head ? { data: null, count: page.length, error: null } : { data: page, error: null };
      };
      const b: Row = {};
      Object.assign(b, {
        select: (_c?: string, opts?: { head?: boolean }) => { head = Boolean(opts?.head); return b; },
        order: () => b,
        limit: () => b,
        gte: () => b, lte: () => b,
        eq: (c: string, v: unknown) => { filters[c] = v; return b; },
        in: (c: string, v: unknown[]) => { filters[c === 'role' ? 'roles' : c] = v; return b; },
        range: (from: number, to: number) => { filters.range = [from, to]; return b; },
        maybeSingle: async () => {
          const r = settle();
          return { data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error };
        },
        then: (resolve: (v: unknown) => void) => resolve(settle()),
      });
      return b;
    },
  }),
}));

const { GET } = await import('@/app/api/cron/weekly-digest/route');

const request = () => new Request('https://bubaly.test/api/cron/weekly-digest') as never;

/** n families, each with one parent who has an email on file. */
function seed(n: number) {
  state.families = Array.from({ length: n }, (_, i) => ({ id: `fam-${i}`, name: `Family ${i}` }));
  state.members = state.families.map((f, i) => ({
    family_id: f.id, user_id: `user-${i}`, display_name: `Parent ${i}`, role: 'parent', is_active: true,
  }));
  state.users = state.families.map((_, i) => ({ id: `user-${i}`, email: `parent${i}@example.test` }));
}

beforeEach(() => {
  state.families = []; state.members = []; state.users = [];
  state.authPageSize = 50; state.authError = null;
  state.familiesError = null; state.memberError = null;
  state.sends = []; state.failSendTo = null;
});
afterEach(() => vi.clearAllMocks());

describe('the weekly digest reaches every family', () => {
  it('emails all 51 families when the recipient list runs past one auth page', async () => {
    // THE CASE THE OLD GUARD COULD NOT SEE. 51 users against GoTrue's 50-per-page
    // default: a single listUsers() call knows about `user-50` not at all.
    seed(51);
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: 51, failed: 0, skipped: 0 });
    expect(state.sends).toContain('parent50@example.test');
  });

  it('does not mistake a server-capped page for the end of the table', async () => {
    // The helper asks for 1,000 and GoTrue may answer with 50. A short page is
    // not proof of the end — it is equally the signature of a cap.
    seed(120);
    state.authPageSize = 50;
    const res = await GET(request());
    expect((await res.json()).sent).toBe(120);
  });

  it('answers 500 when the recipient read fails, and sends nothing', async () => {
    seed(3);
    state.authError = { message: 'auth admin unavailable' };
    const res = await GET(request());
    expect(res.status).toBe(500);
    expect(state.sends).toEqual([]);
  });

  it('answers 500 when the family read fails', async () => {
    seed(3);
    state.familiesError = { message: 'families unavailable' };
    const res = await GET(request());
    expect(res.status).toBe(500);
    expect(state.sends).toEqual([]);
  });

  it('answers 502 and counts the failure when one send fails', async () => {
    seed(3);
    state.failSendTo = 'parent1@example.test';
    const res = await GET(request());
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ sent: 2, failed: 1, skipped: 0 });
  });

  it('counts a family it could not reach rather than dropping it silently', async () => {
    // The distinction the response used to lose: "nobody was due" and "nobody
    // could be reached" both read as `{ sent: 0, failed: 0 }`.
    seed(2);
    state.users = state.users.slice(0, 1);
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: 1, failed: 0, skipped: 1 });
  });

  it('still answers 200 with nothing to do', async () => {
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: 0, failed: 0, skipped: 0 });
  });
});
