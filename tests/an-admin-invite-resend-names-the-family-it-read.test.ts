import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, withFaults, type InMemorySupabase } from './helpers/in-memory-supabase';

// adminResendInviteAction read the family's name and the inviter's profile and
// dropped both errors, so a failed read became "a family" and "A family
// admin": the real invitee was sent a reminder to join "a family" from "A
// family admin", and the super admin was told the invite had been re-sent
// (review R9-2-RESEND-INVITE-FAILED-NAME-READS-SENT-AS-GENERIC). Nothing is
// sent now until both reads answer. The REAL action over the in-memory
// database; the mailer is the only stand-in, and it records what it was asked
// to send.
const h = vi.hoisted(() => ({ db: null as unknown, sent: [] as { to: string; subject: string; props: Record<string, unknown> }[] }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db, createServer: async () => h.db }));
vi.mock('@/lib/supabase/auth', () => ({
  getUser: async () => ({ id: 'admin-1', email: 'root@example.com' }),
  isSuperAdmin: async () => true,
}));
vi.mock('@/lib/auth/super-admin-assurance', () => ({
  superAdminAssurance: async () => ({ ok: true }),
  decideSuperAdminAssurance: () => ({ ok: true }),
  SUPER_ADMIN_STEP_UP_PATH: '/auth/step-up?next=%2Fadmin',
}));
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params),
}));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock('@/lib/email', () => ({
  APP_URL: 'https://www.bubaly.com',
  sendReactEmail: async (message: { to: string; subject: string; react: { props: Record<string, unknown> } }) => {
    h.sent.push({ to: message.to, subject: message.subject, props: message.react.props });
    return { ok: true };
  },
}));

const { adminResendInviteAction } = await import('@/app/(app)/admin/actions');

let db: InMemorySupabase;
let faulted = 0;

function seed() {
  db.seed('invites', [{ id: 'inv-1', family_id: 'fam-1', email: 'partner@example.test', role: 'parent', status: 'pending', token: 'tok-1', invited_by: 'user-9', created_at: '2026-10-01T00:00:00.000Z' }]);
  db.seed('families', [{ id: 'fam-1', name: 'Rivera' }]);
  db.seed('profiles', [{ id: 'user-9', full_name: 'Pat Rivera', email: 'pat@example.test' }]);
}
/** Only `table`'s reads fail; each one is counted, so a fault that never fires cannot pass. */
function fail(table: string) {
  h.db = withFaults(db, (name) => {
    if (name !== table) return null;
    faulted += 1;
    return { message: `${table} unavailable` };
  });
}

beforeEach(() => {
  db = createInMemorySupabase({ maxRows: 1000 });
  h.db = db;
  h.sent = [];
  faulted = 0;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe('an invite reminder is sent only with the names it read', () => {
  it.each(['families', 'profiles'])('a %s read that FAILS sends nothing and is not a resend', async (table) => {
    seed();
    fail(table);
    const result = await adminResendInviteAction('inv-1');
    expect(faulted).toBe(1);
    expect(result).toEqual({ ok: false, error: SOURCE_MESSAGES['actions.couldNotCheckThatRefresh'] });
    expect(h.sent).toEqual([]);
    expect(db.log.filter((entry) => entry.table === 'audit_logs')).toEqual([]);
  });

  it('the control: both reads answer, and the reminder names the family and the inviter', async () => {
    seed();
    const result = await adminResendInviteAction('inv-1');
    expect(result).toEqual({ ok: true });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].to).toBe('partner@example.test');
    expect(h.sent[0].subject).toContain('join Rivera on Bubaly');
    expect(h.sent[0].props).toMatchObject({ familyName: 'Rivera', inviterName: 'Pat Rivera', token: 'tok-1', role: 'parent' });
    expect(db.log.filter((entry) => entry.table === 'audit_logs')).toHaveLength(1);
  });

  it('the control: a family and inviter that are really gone, from reads that answered, are the generic words', async () => {
    seed();
    db.replace('families', []);
    db.replace('profiles', []);
    const result = await adminResendInviteAction('inv-1');
    expect(result).toEqual({ ok: true });
    expect(h.sent[0].props).toMatchObject({ familyName: 'a family', inviterName: 'A family admin' });
  });
});
