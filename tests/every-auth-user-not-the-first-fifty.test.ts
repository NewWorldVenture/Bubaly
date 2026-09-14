// `listUsers()` with no arguments is one page of fifty, and says nothing about it.
//
// Three callers built a recipient lookup that way: the weekly digest, the chore
// reminders, and lib/server/notification-emails.ts — whose own comment says it
// "Mirrors the weekly-digest cron's approach". Every recipient past the fiftieth
// simply had no email on file, and each caller's `if (!email) continue;` dropped
// them without counting a failure.
//
// These cases pin the paging rules, each of which exists because the obvious
// version of it is wrong.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { readAllAuthUsers } from '@/lib/supabase/read-all-auth-users';

type User = { id: string; email?: string | null };

/** A server holding `total` users and answering at most `cap` per page. */
const server = (total: number, cap: number) => {
  const users: User[] = Array.from({ length: total }, (_, i) => ({ id: `u-${i}` }));
  const calls: { page: number; perPage: number }[] = [];
  const listUsers = async (
    { page, perPage }: { page: number; perPage: number },
  ): Promise<{ data: { users: User[] } | null; error: Error | null }> => {
    calls.push({ page, perPage });
    const size = Math.min(perPage, cap);
    return { data: { users: users.slice((page - 1) * size, page * size) }, error: null };
  };
  return { listUsers, calls };
};

describe('every auth user, not the first fifty', () => {
  it('reads past the first page', async () => {
    const { users, error } = await readAllAuthUsers(server(51, 50).listUsers);
    expect(error).toBeNull();
    expect(users).toHaveLength(51);
  });

  it('does not stop on a SHORT page', async () => {
    // The rule readAll states for PostgREST, and it holds here for the same
    // reason: a page shorter than requested is equally the signature of a
    // server-side cap, so it is not proof of the end. Asking for 1,000 from a
    // server that caps at 50 must not look like a 50-user table.
    const { users } = await readAllAuthUsers(server(237, 50).listUsers, { pageSize: 1000 });
    expect(users).toHaveLength(237);
  });

  it('stops on an EMPTY page rather than paging forever', async () => {
    const s = server(100, 50);
    await readAllAuthUsers(s.listUsers, { pageSize: 50 });
    expect(s.calls.map((c) => c.page)).toEqual([1, 2, 3]);
  });

  it('reads past page nine, which nextPage cannot express', async () => {
    // supabase-js parses the page out of the Link header with `.substring(0, 1)`
    // (auth-js GoTrueAdminApi.listUsers), so page 10 arrives as page 1. Trusting
    // it would loop or stop early; this helper counts pages itself.
    const { users } = await readAllAuthUsers(server(1000, 50).listUsers, { pageSize: 50 });
    expect(users).toHaveLength(1000);
  });

  it('does not double-count a user two pages hand back', async () => {
    // Offset paging over a table someone is signing up to.
    let call = 0;
    const listUsers = async () => {
      call++;
      if (call === 1) return { data: { users: [{ id: 'a' }, { id: 'b' }] }, error: null };
      if (call === 2) return { data: { users: [{ id: 'b' }, { id: 'c' }] }, error: null };
      return { data: { users: [] }, error: null };
    };
    const { users } = await readAllAuthUsers(listUsers);
    expect(users.map((u) => u.id)).toEqual(['a', 'b', 'c']);
  });

  it('returns the error rather than a plausible prefix', async () => {
    let call = 0;
    const listUsers = async ({ page }: { page: number; perPage: number }) => {
      call++;
      if (page === 2) return { data: null, error: { message: 'auth admin unavailable' } };
      return { data: { users: [{ id: `u-${call}` }] }, error: null };
    };
    const { users, error } = await readAllAuthUsers(listUsers, { pageSize: 1 });
    expect(error).toEqual({ message: 'auth admin unavailable' });
    expect(users).toHaveLength(1); // partial — which is why the caller must check error first
  });

  it('reports an incomplete read when it hits the page cap', async () => {
    // Half a million users or a paging bug: either way the read is not complete,
    // and saying so beats returning a prefix that looks like the whole table.
    const { error } = await readAllAuthUsers(server(1000, 10).listUsers, { pageSize: 10, maxPages: 3 });
    expect(error?.message).toContain('incomplete');
  });

  it('nothing reaches for an unpaginated listUsers again', () => {
    const files = execSync("git ls-files 'app/**/*.ts' 'lib/**/*.ts'", { encoding: 'utf8' })
      .split('\n').filter(Boolean);
    const bare = files.filter((f) => /\.listUsers\(\s*\)/.test(readFileSync(f, 'utf8')));
    expect(bare, 'listUsers() with no arguments is one page of fifty').toEqual([]);
  });

  it('the two digest crons choose a time budget', () => {
    // Neither declared `maxDuration`, so both ran under the platform default —
    // and a loop killed mid-run always walks the same ordered prefix, so the
    // tail of the customer base is never served. A budget raises that ceiling by
    // an order of magnitude; only a resume cursor removes it, and that needs a
    // column (see F-001).
    for (const route of ['app/api/cron/weekly-digest/route.ts', 'app/api/cron/chore-reminders/route.ts']) {
      expect(readFileSync(route, 'utf8'), route).toMatch(/export const maxDuration = \d+/);
    }
  });
});
