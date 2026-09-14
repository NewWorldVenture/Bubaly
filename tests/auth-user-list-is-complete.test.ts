import { describe, it, expect } from 'vitest';
import { listAllAuthUsers } from '../lib/server/list-all-auth-users';

/**
 * A fake GoTrue that behaves like the real one in the way that matters: it
 * CLAMPS per_page to its own maximum and says nothing about it. That clamp is
 * the whole defect — a bare listUsers() sends an empty per_page, the server
 * applies its default of 50, and the caller receives 50 users believing that is
 * the project.
 */
function fakeAdmin(total: number, serverMax: number) {
  const calls: Array<{ page: number; perPage: number }> = [];
  const all = Array.from({ length: total }, (_, i) => ({ id: `u${i + 1}` }));
  return {
    calls,
    client: {
      auth: {
        admin: {
          listUsers: async (params?: { page?: number; perPage?: number }) => {
            const perPage = Math.min(params?.perPage ?? 50, serverMax);
            const page = params?.page ?? 1;
            calls.push({ page, perPage });
            const start = (page - 1) * perPage;
            return { data: { users: all.slice(start, start + perPage) }, error: null };
          },
        },
      },
    },
  };
}

describe('every auth user is read, not the first page', () => {
  it('reads past the server cap that a bare listUsers() stops at', async () => {
    // 137 users, server hands out at most 50 — the real GoTrue default.
    const { client, calls } = fakeAdmin(137, 50);
    const { users, error } = await listAllAuthUsers(client);
    expect(error).toBeNull();
    expect(users).toHaveLength(137);
    expect(users.at(-1)?.id).toBe('u137');
    // 50 + 50 + 37 + one empty page that proves the end.
    expect(calls.map((c) => c.page)).toEqual([1, 2, 3, 4]);
  });

  it('does not mistake the server clamping per_page for the end of the list', async () => {
    // The trap: the caller asks for 1000, the server gives 50. A pager that
    // stopped on a page SHORTER than requested would return 50 and call it
    // complete — the original bug, rebuilt inside its own fix.
    const { client } = fakeAdmin(120, 50);
    const { users } = await listAllAuthUsers(client, { pageSize: 1000 });
    expect(users).toHaveLength(120);
  });

  it('stops cleanly when the list divides exactly into pages', async () => {
    const { client, calls } = fakeAdmin(100, 50);
    const { users, error } = await listAllAuthUsers(client);
    expect(error).toBeNull();
    expect(users).toHaveLength(100);
    expect(calls).toHaveLength(3); // 50, 50, then the empty page
  });

  it('handles an empty project', async () => {
    const { client } = fakeAdmin(0, 50);
    const { users, error } = await listAllAuthUsers(client);
    expect(error).toBeNull();
    expect(users).toEqual([]);
  });

  it('returns the error and NO users, never a partial list reported as whole', async () => {
    let call = 0;
    const client = {
      auth: { admin: { listUsers: async () => {
        call += 1;
        if (call === 1) return { data: { users: [{ id: 'u1' }] }, error: null };
        return { data: null, error: new Error('gotrue exploded') };
      } } },
    };
    const { users, error } = await listAllAuthUsers(client, { pageSize: 1 });
    expect(error).toBeTruthy();
    expect(users).toEqual([]); // the half-read list is withheld, not returned
  });

  it('refuses to report a partial list as complete when the page guard trips', async () => {
    const { client } = fakeAdmin(1_000_000, 50);
    const { users, error } = await listAllAuthUsers(client, { maxPages: 3 });
    expect(users).toEqual([]);
    expect((error as Error).message).toContain('refusing to report a partial list as complete');
  });

  it('never calls listUsers without an explicit page size', async () => {
    // A bare call is the defect. Every request must state what it wants.
    const { client, calls } = fakeAdmin(10, 50);
    await listAllAuthUsers(client);
    for (const c of calls) {
      expect(c.perPage).toBeGreaterThan(0);
      expect(c.page).toBeGreaterThan(0);
    }
  });
});

describe('the three production callers ask for every user', () => {
  const files = [
    'lib/server/notification-emails.ts',
    'app/api/cron/weekly-digest/route.ts',
    'app/api/cron/chore-reminders/route.ts',
  ];
  it.each(files)('%s uses listAllAuthUsers and no bare listUsers()', async (file) => {
    const src = await import('node:fs').then((fs) => fs.readFileSync(file, 'utf8'));
    expect(src).toContain('listAllAuthUsers');
    // The bare call is what silently truncated to 50.
    expect(src).not.toMatch(/auth\.admin\.listUsers\(\s*\)/);
  });
});
