// The chore-reminder cron, driven rather than spell-checked.
//
// This file used to hold nine assertions of the form
// `expect(<file text>).toContain('<identifier>')`. It never imported the route,
// so it was satisfied by the WORD appearing anywhere — a comment, a string.
// Three real regressions left it green: emptying the body of an error branch
// while keeping its condition, dropping `else failed++`, and the recipient read
// being a single page, which no string in it mentioned at all.
//
// The weekly digest's half is in tests/the-weekly-digest-reaches-every-family.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  assignments: [] as Row[],
  families: [] as Row[],
  users: [] as { id: string; email: string | null }[],
  authPageSize: 50,
  assignmentsError: null as null | { message: string },
  familiesError: null as null | { message: string },
  authError: null as null | { message: string },
  sends: [] as string[],
  failSendTo: null as string | null,
}));

vi.mock('@/lib/server/cron-auth', () => ({ hasCronAuthorization: () => true }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/emails/chore-reminder', () => ({ ChoreReminderEmail: () => null }));
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
          const size = Math.min(perPage, state.authPageSize);
          return { data: { users: state.users.slice((page - 1) * size, page * size) }, error: null };
        },
      },
    },
    from: (table: string) => {
      let range: [number, number] | null = null;
      const b: Row = {};
      const settle = () => {
        if (table === 'chore_assignments') {
          if (state.assignmentsError) return { data: null, error: state.assignmentsError };
          const all = state.assignments;
          return { data: range ? all.slice(range[0], range[1] + 1) : all, error: null };
        }
        if (state.familiesError) return { data: null, error: state.familiesError };
        return { data: state.families, error: null };
      };
      Object.assign(b, {
        select: () => b, order: () => b, in: () => b, not: () => b, lte: () => b, eq: () => b,
        range: (from: number, to: number) => { range = [from, to]; return b; },
        then: (resolve: (v: unknown) => void) => resolve(settle()),
      });
      return b;
    },
  }),
}));

const { GET } = await import('@/app/api/cron/chore-reminders/route');
const request = () => new Request('https://bubaly.test/api/cron/chore-reminders') as never;

/** n members, each with one open chore due this week and an email on file. */
function seed(n: number) {
  state.families = [{ id: 'fam-1', name: 'Family One' }];
  state.assignments = Array.from({ length: n }, (_, i) => ({
    id: `a-${i}`, member_id: `mem-${i}`, due_at: '2026-09-20T00:00:00Z', family_id: 'fam-1',
    chores: { title: 'Dishes', points: 5 },
    family_members: { display_name: `Member ${i}`, user_id: `user-${i}` },
  }));
  state.users = Array.from({ length: n }, (_, i) => ({ id: `user-${i}`, email: `member${i}@example.test` }));
}

beforeEach(() => {
  state.assignments = []; state.families = []; state.users = [];
  state.authPageSize = 50; state.assignmentsError = null;
  state.familiesError = null; state.authError = null;
  state.sends = []; state.failSendTo = null;
});
afterEach(() => vi.clearAllMocks());

describe('scheduled digest read boundaries', () => {
  it('emails all 51 members when the recipient list runs past one auth page', async () => {
    // THE CASE THE OLD GUARD COULD NOT SEE. listUsers() with no arguments is
    // fifty users; member 51 had no email on file and was dropped.
    seed(51);
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: 51, failed: 0, skipped: 0 });
    expect(state.sends).toContain('member50@example.test');
  });

  it('does not mistake a server-capped page for the end of the table', async () => {
    seed(120);
    const res = await GET(request());
    expect((await res.json()).sent).toBe(120);
  });

  it('answers 500 when the assignment read fails, and sends nothing', async () => {
    seed(3);
    state.assignmentsError = { message: 'assignments unavailable' };
    const res = await GET(request());
    expect(res.status).toBe(500);
    expect(state.sends).toEqual([]);
  });

  it('answers 500 when the family-name read fails', async () => {
    seed(3);
    state.familiesError = { message: 'families unavailable' };
    const res = await GET(request());
    expect(res.status).toBe(500);
    expect(state.sends).toEqual([]);
  });

  it('answers 500 when the recipient read fails', async () => {
    seed(3);
    state.authError = { message: 'auth admin unavailable' };
    const res = await GET(request());
    expect(res.status).toBe(500);
    expect(state.sends).toEqual([]);
  });

  it('answers 502 and counts the failure when one send fails', async () => {
    seed(3);
    state.failSendTo = 'member1@example.test';
    const res = await GET(request());
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ sent: 2, failed: 1, skipped: 0 });
  });

  it('counts a member it could not reach rather than dropping them silently', async () => {
    seed(2);
    state.users = state.users.slice(0, 1);
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: 1, failed: 0, skipped: 1 });
  });

  it('answers 200 with nothing due', async () => {
    const res = await GET(request());
    expect(res.status).toBe(200);
    expect((await res.json()).sent).toBe(0);
  });
});
