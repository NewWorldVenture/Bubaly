// The shared super-admin recipient lookup, and BOTH of its callers' contracts.
//
// lib/feedback/notify.ts has two readers of the same list:
//   - readSuperAdminRecipients: strict. The allowlist ∪ the super_admins table,
//     or an ERROR when the table could not be read completely. The admin digest
//     uses it and fails closed (tests/admin-digest-recipients-fail-closed.test.ts).
//   - allSuperAdminEmails: best-effort, for notifySuperAdmins' alert emails. A
//     failed read still reaches the allowlist rather than nobody (unchanged), and
//     is now logged instead of swallowed.
// The only other callers of either are the admin digest route and
// notifySuperAdmins (checked with a repository grep when this was written).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const state = vi.hoisted(() => ({ attempts: [] as string[], stray: [] as string[], fail: null as null | 'error' | 'throw' }));

const { readSuperAdminRecipients, allSuperAdminEmails, notifySuperAdmins } = await import('@/lib/feedback/notify');
const { superAdminEmails } = await import('@/lib/constants/super-admins');

const TABLE_ADMIN = 'table-admin@example.test';
const ENV_ADMIN = 'env-admin@example.test';

let db: InMemorySupabase;
function client() {
  return {
    from(table: string) {
      const qb = db.from(table) as unknown as { then: (f?: (v: unknown) => unknown, r?: (e: unknown) => unknown) => Promise<unknown> };
      if (table !== 'super_admins' || !state.fail) return qb;
      qb.then = (f, r) => (state.fail === 'throw'
        ? Promise.reject(new Error('injected: super_admins read threw'))
        : Promise.resolve({ data: null, error: { code: 'XX000', message: 'injected: super_admins read failed', details: null, hint: null }, count: null, status: 500, statusText: 'Internal Server Error' })
      ).then(f, r);
      return qb;
    },
  } as never;
}

const saved = { ...process.env };
let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  process.env.SUPER_ADMIN_EMAILS = ENV_ADMIN;
  process.env.RESEND_API_KEY = 'test-resend-key-not-real';
  db = createInMemorySupabase();
  state.attempts = []; state.stray = []; state.fail = null;
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    if (String(input) !== 'https://api.resend.com/emails') { state.stray.push(String(input)); throw new Error('network is disabled in this hermetic test'); }
    state.attempts.push((JSON.parse(String(init?.body)) as { to: string }).to);
    return new Response('{"id":"msg"}', { status: 200 });
  }));
  errors = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  expect(state.stray).toEqual([]);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const k of ['SUPER_ADMIN_EMAILS', 'RESEND_API_KEY']) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
});

const sorted = (xs: string[]) => [...xs].sort();

describe('readSuperAdminRecipients: an empty table is not an error; a failed read is', () => {
  it('a read that answers an error is an error, with no list', async () => {
    state.fail = 'error';
    expect(await readSuperAdminRecipients(client())).toEqual({ emails: null, error: 'injected: super_admins read failed' });
  });

  it('a read that throws is an error, with no list', async () => {
    state.fail = 'throw';
    expect(await readSuperAdminRecipients(client())).toEqual({ emails: null, error: 'injected: super_admins read threw' });
  });

  it('more rows than the ceiling is a truncated read: an error, not a short list', async () => {
    db.seed('super_admins', Array.from({ length: 1_001 }, (_, i) => ({ email: `admin-${String(i).padStart(4, '0')}@example.test` })));
    const read = await readSuperAdminRecipients(client());
    expect(read.emails).toBeNull();
    expect(read.error).toMatch(/1000|ceiling|more rows|stopped/i);
  });

  it('exactly the ceiling is a complete read', async () => {
    db.seed('super_admins', Array.from({ length: 1_000 }, (_, i) => ({ email: `admin-${String(i).padStart(4, '0')}@example.test` })));
    const read = await readSuperAdminRecipients(client());
    expect(read.error).toBeNull();
    expect(read.emails).toHaveLength(superAdminEmails().length + 1_000);
  });

  it('a successful read with zero rows is the configured allowlist, and no error', async () => {
    expect(await readSuperAdminRecipients(client())).toEqual({ emails: superAdminEmails(), error: null });
    expect(superAdminEmails()).toContain(ENV_ADMIN);
  });

  it('a successful read with rows is the allowlist ∪ the table, lowercased, de-duplicated, blanks skipped', async () => {
    db.seed('super_admins', [{ email: TABLE_ADMIN.toUpperCase() }, { email: ENV_ADMIN.toUpperCase() }, { email: null }, { email: '' }]);
    const read = await readSuperAdminRecipients(client());
    expect(read.error).toBeNull();
    expect(sorted(read.emails!)).toEqual(sorted([...new Set([...superAdminEmails(), TABLE_ADMIN])]));
  });
});

describe('allSuperAdminEmails / notifySuperAdmins: alerts stay best-effort, and a failed read is no longer silent', () => {
  it('a failed read still returns the allowlist, and logs why', async () => {
    state.fail = 'error';
    expect(await allSuperAdminEmails(client())).toEqual(superAdminEmails());
    expect(errors).toHaveBeenCalledWith('[feedback-notify] super_admins read failed; using the env allowlist only', 'injected: super_admins read failed');
  });

  it('a successful read is unchanged: the allowlist ∪ the table, nothing logged', async () => {
    db.seed('super_admins', [{ email: TABLE_ADMIN }]);
    expect(sorted(await allSuperAdminEmails(client()))).toEqual(sorted([...superAdminEmails(), TABLE_ADMIN]));
    expect(errors).not.toHaveBeenCalled();
  });

  it('notifySuperAdmins after a failed read: the alert is recorded and still emailed to the allowlist', async () => {
    state.fail = 'throw';
    await notifySuperAdmins(client(), { kind: 'info', title: 'Test alert' });
    expect(db.table('admin_notifications')).toHaveLength(1);
    expect(sorted(state.attempts)).toEqual(sorted(superAdminEmails()));
  });

  it('notifySuperAdmins after a successful read: the table admin is emailed too', async () => {
    db.seed('super_admins', [{ email: TABLE_ADMIN }]);
    await notifySuperAdmins(client(), { kind: 'info', title: 'Test alert' });
    expect(sorted(state.attempts)).toEqual(sorted([...superAdminEmails(), TABLE_ADMIN]));
  });
});
