// The super-admin console: step-up, targets it must not touch, writes it must
// not lose, and the record it must keep.
//
//  - Every admin gate asked only "is this email a super-admin?", never whether
//    the session proved the authenticator the admin enrolled. A password-only
//    (aal1) session was sent to /auth/step-up on /dashboard/bills and waved
//    through the console that grants super-admin and replaces the Stripe keys.
//  - adminSetUserBanAction banned another super-admin, the built-in owner too.
//  - saveStripeSettingsAction ignored its read error and wrote both Stripe
//    secrets as NULL on a "keep existing" save.
//  - /admin/admins revoke/deactivate changed only the cosmetic roster.
//  - adminCreateUserAction lost its audit row when the family join failed.
//  - feature-tier and AI-engine changes were not audited, and the tier save was
//    a non-atomic read-modify-write that dropped a concurrent change.
//  - a marketplace report resolve withdrew the listing before checking the
//    report was still open.
//  - audit_logs.resource_id is a uuid: a key, an email or 'singleton' passed as
//    resourceId was refused by Postgres and the row silently lost. The fake
//    below refuses it the same way, so only rows that would land are counted.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const EN_US = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>;

type Op = {
  table: string;
  kind: 'select' | 'insert' | 'upsert' | 'update' | 'delete';
  payload?: unknown;
  options?: unknown;
  columns?: string;
  filters: [string, string, unknown][];
  returning: boolean;
  rejected?: boolean;
};
type Answer = { data: unknown; error: unknown };

const h = vi.hoisted(() => ({
  superAdmin: true,
  user: { id: 'admin-1', email: 'second.admin@example.com' } as { id: string; email: string } | null,
  assurance: { data: { currentLevel: 'aal2', nextLevel: 'aal2' }, error: null } as { data: unknown; error: unknown },
  ops: [] as Op[],
  respond: (_op: Op): Answer => ({ data: null, error: null }),
  authAdmin: {
    inviteUserByEmail: vi.fn(),
    updateUserById: vi.fn(),
    getUserById: vi.fn(),
  },
  serviceClientCalls: 0,
  requireUserContext: vi.fn(),
}));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NEW_USER = '11111111-1111-4111-8111-111111111111';
const ROW_1 = '22222222-2222-4222-8222-222222222222';
const ROW_2 = '33333333-3333-4333-8333-333333333333';
const LISTING = '44444444-4444-4444-8444-444444444444';

/** What Postgres answers an insert whose uuid column holds something else. */
function uuidRefusal(op: Op): Answer | null {
  if (op.table !== 'audit_logs' || op.kind !== 'insert') return null;
  const id = (op.payload as { resource_id?: unknown }).resource_id;
  if (id === null || id === undefined || (typeof id === 'string' && UUID.test(id))) return null;
  return { data: null, error: { code: '22P02', message: `invalid input syntax for type uuid: "${String(id)}"` } };
}

function builder(table: string) {
  const op: Op = { table, kind: 'select', filters: [], returning: false };
  let started = false;
  const settle = () => {
    h.ops.push(op);
    const refused = uuidRefusal(op);
    if (refused) op.rejected = true;
    return Promise.resolve(refused ?? h.respond(op));
  };
  const b: Record<string, unknown> = {
    select(columns?: string) {
      if (started) op.returning = true; else { op.kind = 'select'; op.columns = columns; started = true; }
      return b;
    },
    insert(payload: unknown) { op.kind = 'insert'; op.payload = payload; started = true; return b; },
    upsert(payload: unknown, options?: unknown) { op.kind = 'upsert'; op.payload = payload; op.options = options; started = true; return b; },
    update(payload: unknown) { op.kind = 'update'; op.payload = payload; started = true; return b; },
    delete() { op.kind = 'delete'; started = true; return b; },
    eq(col: string, v: unknown) { op.filters.push(['eq', col, v]); return b; },
    in(col: string, v: unknown) { op.filters.push(['in', col, v]); return b; },
    order() { return b; },
    limit() { return b; },
    abortSignal() { return b; },
    maybeSingle: settle,
    single: settle,
    then(resolve: (v: Answer) => unknown, reject: (e: unknown) => unknown) { return settle().then(resolve, reject); },
  };
  return b;
}
const serviceClient = { from: (table: string) => builder(table), auth: { admin: h.authAdmin } };

vi.mock('@/lib/supabase/auth', () => ({
  getUser: async () => h.user,
  isSuperAdmin: async () => h.superAdmin,
  requireUserContext: (...args: unknown[]) => h.requireUserContext(...args),
}));
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => { h.serviceClientCalls += 1; return serviceClient; },
  createServer: async () => ({ auth: { mfa: { getAuthenticatorAssuranceLevel: async () => h.assurance } } }),
  describeConfiguredServiceKey: () => null,
  serviceKeyRemedy: () => null,
}));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => EN_US[key] ?? key }));
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); },
  notFound: () => { throw new Error('NOT_FOUND'); },
}));

const admin = await import('@/app/(app)/admin/actions');
const roster = await import('@/app/(app)/admin/admins/actions');
const tiers = await import('@/app/(app)/admin/tier-features/actions');
const ai = await import('@/app/(app)/admin/ai/actions');
const reports = await import('@/app/(app)/admin/marketplace/reports/actions');
const { superAdminGate } = await import('@/lib/auth/super-admin-gate');
const { requireMarketingAdmin } = await import('@/lib/marketing/admin');
const { FEATURE_CATALOG_BY_KEY } = await import('@/lib/constants/feature-catalog');

const PASSWORD_ONLY = { data: { currentLevel: 'aal1', nextLevel: 'aal2' }, error: null };
const STEPPED_UP = { data: { currentLevel: 'aal2', nextLevel: 'aal2' }, error: null };
const NO_FACTOR = { data: { currentLevel: 'aal1', nextLevel: 'aal1' }, error: null };
const NEEDS_CODE = EN_US['actions.adminConsoleNeedsYourCode'];

const writes = () => h.ops.filter((o) => o.kind !== 'select');
// Only the rows the database would have kept.
const audits = () => h.ops.filter((o) => o.table === 'audit_logs' && o.kind === 'insert' && !o.rejected).map((o) => o.payload as Record<string, unknown>);
const refusedAudits = () => h.ops.filter((o) => o.table === 'audit_logs' && o.rejected);
const form = (fields: Record<string, string>) => { const fd = new FormData(); for (const [k, v] of Object.entries(fields)) fd.set(k, v); return fd; };
const stripeInput = { enabled: true, publishableKey: 'pk_live_x', secretKey: '', webhookSecret: '', connectAccountId: null, serviceFeeCents: 120, serviceFeePriceId: null };

beforeEach(() => {
  h.superAdmin = true;
  h.user = { id: 'admin-1', email: 'second.admin@example.com' };
  h.assurance = STEPPED_UP;
  h.ops = [];
  h.respond = () => ({ data: null, error: null });
  h.serviceClientCalls = 0;
  h.requireUserContext.mockReset().mockRejectedValue(new Error('requireUserContext must not be called here'));
  h.authAdmin.inviteUserByEmail.mockReset();
  h.authAdmin.updateUserById.mockReset().mockResolvedValue({ data: {}, error: null });
  h.authAdmin.getUserById.mockReset().mockResolvedValue({ data: { user: { id: 'target', email: 'someone@example.com' } }, error: null });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('a password-only session of an MFA-enrolled super-admin is refused everywhere in the console', () => {
  const refusedActions: [string, () => Promise<unknown>][] = [
    ['adminSetSuperAdminAction', () => admin.adminSetSuperAdminAction({ email: 'attacker@example.com', makeAdmin: true })],
    ['adminCreateUserAction', () => admin.adminCreateUserAction({ email: 'new@example.com', familyId: 'fam-1' })],
    ['saveStripeSettingsAction', () => admin.saveStripeSettingsAction({ ...stripeInput, secretKey: 'sk_attacker' })],
    ['adminSetUserBanAction', () => admin.adminSetUserBanAction('victim', true)],
    ['revokeAdminAction', () => roster.revokeAdminAction(ROW_1)],
    ['resolveReportAction', () => reports.resolveReportAction({ id: 'r1', status: 'actioned', withdrawListing: true })],
  ];

  it.each(refusedActions)('%s answers with the step-up sentence and writes nothing', async (_name, run) => {
    h.assurance = PASSWORD_ONLY;
    await expect(run()).resolves.toEqual({ ok: false, error: NEEDS_CODE });
    expect(writes()).toEqual([]);
    expect(h.authAdmin.inviteUserByEmail).not.toHaveBeenCalled();
    expect(h.authAdmin.updateUserById).not.toHaveBeenCalled();
  });

  it('superAdminGate answers step_up, and its callers refuse', async () => {
    h.assurance = PASSWORD_ONLY;
    expect(await superAdminGate()).toEqual({ status: 'step_up' });
    await expect(tiers.setFeatureTierAction(Object.keys(FEATURE_CATALOG_BY_KEY)[0], 'off')).resolves.toEqual({ ok: false, error: NEEDS_CODE });
    await expect(ai.saveAIConfigAction(form({ model: 'gpt-x', openaiKey: 'sk-attacker' }))).resolves.toEqual({ ok: false, error: NEEDS_CODE });
    expect(writes()).toEqual([]);
  });

  it('requireMarketingAdmin refuses with a 403', async () => {
    h.assurance = PASSWORD_ONLY;
    await expect(requireMarketingAdmin()).rejects.toMatchObject({ name: 'MarketingAuthError', status: 403 });
  });

  it('the /admin layout sends the session to step-up', async () => {
    h.assurance = PASSWORD_ONLY;
    const { default: SiteAdminLayout } = await import('@/app/(app)/admin/layout');
    await expect(SiteAdminLayout({ children: null })).rejects.toThrow(/^REDIRECT:\/auth\/step-up/);
  });

  it('the /api/admin export routes answer 403 step_up_required', async () => {
    h.assurance = PASSWORD_ONLY;
    for (const path of ['@/app/api/admin/benchmarks/export/route', '@/app/api/admin/support-tickets/export/route']) {
      const { GET } = await import(path);
      const res = await GET();
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe('step_up_required');
    }
    expect(h.serviceClientCalls).toBe(0);
  });

  it('an unreadable assurance level fails closed', async () => {
    h.assurance = { data: null, error: new Error('auth down') };
    expect(await superAdminGate()).toEqual({ status: 'step_up' });
    await expect(admin.adminSetSuperAdminAction({ email: 'x@example.com', makeAdmin: true })).resolves.toEqual({ ok: false, error: NEEDS_CODE });
  });

  it('control: a stepped-up session, and an admin with no factor enrolled, are allowed', async () => {
    for (const level of [STEPPED_UP, NO_FACTOR]) {
      h.assurance = level;
      expect(await superAdminGate()).toMatchObject({ status: 'allowed' });
      await expect(admin.adminSetSuperAdminAction({ email: 'x@example.com', makeAdmin: true })).resolves.toEqual({ ok: true });
    }
  });
});

describe('a super-admin cannot be banned from the console', () => {
  it('refuses the built-in/env owner', async () => {
    h.authAdmin.getUserById.mockResolvedValue({ data: { user: { id: 'owner', email: 'Daniel.Hughen@gmail.com' } }, error: null });
    await expect(admin.adminSetUserBanAction('owner', true)).resolves.toEqual({ ok: false, error: EN_US['actions.revokeSuperAdminBeforeBanning'] });
    expect(h.authAdmin.updateUserById).not.toHaveBeenCalled();
  });

  it('refuses a DB-granted super-admin', async () => {
    h.respond = (op) => (op.table === 'super_admins' ? { data: { email: 'someone@example.com' }, error: null } : { data: null, error: null });
    await expect(admin.adminSetUserBanAction('target', true)).resolves.toEqual({ ok: false, error: EN_US['actions.revokeSuperAdminBeforeBanning'] });
    expect(h.authAdmin.updateUserById).not.toHaveBeenCalled();
  });

  it('control: an ordinary account is banned, and a ban can always be lifted', async () => {
    await expect(admin.adminSetUserBanAction('target', true)).resolves.toEqual({ ok: true });
    expect(h.authAdmin.updateUserById).toHaveBeenCalledWith('target', { ban_duration: '876000h' });
    h.authAdmin.getUserById.mockResolvedValue({ data: { user: { id: 'owner', email: 'daniel.hughen@gmail.com' } }, error: null });
    await expect(admin.adminSetUserBanAction('owner', false)).resolves.toEqual({ ok: true });
  });
});

describe('a Stripe save never writes the stored secrets as NULL', () => {
  it('a refused read stops the save before the upsert', async () => {
    h.respond = (op) => (op.table === 'stripe_settings' && op.kind === 'select'
      ? { data: null, error: { message: 'upstream timeout', code: '57014' } } : { data: null, error: null });
    const result = await admin.saveStripeSettingsAction(stripeInput);
    expect(result.ok).toBe(false);
    expect(h.ops.filter((o) => o.table === 'stripe_settings' && o.kind === 'upsert')).toEqual([]);
    expect(audits()).toEqual([]);
  });

  it('blank secret fields are left out of the write', async () => {
    await expect(admin.saveStripeSettingsAction(stripeInput)).resolves.toEqual({ ok: true });
    const upsert = h.ops.find((o) => o.table === 'stripe_settings' && o.kind === 'upsert')!.payload as Record<string, unknown>;
    expect(upsert).not.toHaveProperty('secret_key');
    expect(upsert).not.toHaveProperty('webhook_secret');
    expect(upsert.service_fee_cents).toBe(120);
  });

  it('control: a pasted secret is written', async () => {
    await admin.saveStripeSettingsAction({ ...stripeInput, secretKey: ' sk_new ', webhookSecret: 'whsec_new' });
    const upsert = h.ops.find((o) => o.table === 'stripe_settings' && o.kind === 'upsert')!.payload as Record<string, unknown>;
    expect(upsert).toMatchObject({ secret_key: 'sk_new', webhook_secret: 'whsec_new' });
  });
});

describe('an admin-created account is audited even when the family join fails', () => {
  it('writes the create row before the join, and a join_failed row after it', async () => {
    h.authAdmin.inviteUserByEmail.mockResolvedValue({ data: { user: { id: NEW_USER } }, error: null });
    h.respond = (op) => (op.table === 'family_members' ? { data: null, error: { message: 'fk violation', code: '23503' } } : { data: null, error: null });
    const result = await admin.adminCreateUserAction({ email: 'new@example.com', familyId: 'fam-x' });
    expect(result.ok).toBe(false);
    expect(audits()).toEqual([
      expect.objectContaining({ action: 'create', resource: 'users', resource_id: NEW_USER, actor_id: 'admin-1' }),
      expect.objectContaining({ action: 'join_failed', resource: 'family_members', resource_id: NEW_USER }),
    ]);
  });
});

describe('the /admin/admins roster removes real access and is audited', () => {
  const rosterRow = (email: string) => (op: Op): Answer => {
    if (op.table === 'admin_users' && op.kind === 'select') return { data: { id: ROW_1, email, admin_role: 'super_administrator' }, error: null };
    if (op.table === 'admin_users') return { data: { id: ROW_1 }, error: null };
    if (op.table === 'super_admins' && op.kind === 'delete') return { data: [{ email }], error: null };
    return { data: null, error: null };
  };

  it.each([
    ['revokeAdminAction', (id: string) => roster.revokeAdminAction(id), 'revoke'],
    ['deactivateAdminAction', (id: string) => roster.deactivateAdminAction(id), 'deactivate'],
  ] as const)('%s deletes the super_admins grant and audits both changes', async (_name, run, action) => {
    h.respond = rosterRow('db.admin@example.com');
    await expect(run(ROW_1)).resolves.toEqual({ ok: true });
    const del = h.ops.find((o) => o.table === 'super_admins' && o.kind === 'delete')!;
    expect(del.filters).toContainEqual(['eq', 'email', 'db.admin@example.com']);
    expect(audits()).toEqual([
      expect.objectContaining({ action: 'revoke', resource: 'super_admins', resource_id: null, actor_id: 'admin-1', metadata: expect.objectContaining({ email: 'db.admin@example.com' }) }),
      expect.objectContaining({ action, resource: 'admin_users', resource_id: ROW_1, actor_id: 'admin-1' }),
    ]);
  });

  it('refuses the built-in/env admin and the acting admin themself, changing nothing', async () => {
    h.respond = rosterRow('daniel.hughen@gmail.com');
    await expect(roster.revokeAdminAction(ROW_1)).resolves.toEqual({ ok: false, error: EN_US['actions.thisAdminIsSetVia'] });
    h.respond = rosterRow('second.admin@example.com');
    await expect(roster.deactivateAdminAction(ROW_1)).resolves.toEqual({ ok: false, error: EN_US['actions.youCanTRemoveYour'] });
    expect(writes()).toEqual([]);
  });

  it('invite is audited under the roster row it wrote, not the email', async () => {
    h.respond = (op) => (op.table === 'admin_users' && op.kind === 'upsert' ? { data: { id: ROW_2 }, error: null } : { data: null, error: null });
    await expect(roster.inviteAdminAction(form({ email: 'new.staff@example.com', admin_role: 'administrator' }))).resolves.toEqual({ ok: true });
    expect(refusedAudits()).toEqual([]);
    expect(audits()).toEqual([
      expect.objectContaining({ action: 'invite', resource: 'admin_users', resource_id: ROW_2, actor_id: 'admin-1', metadata: expect.objectContaining({ email: 'new.staff@example.com' }) }),
    ]);
  });

  it('activate puts back the super_admins grant deactivate removed, and audits both', async () => {
    h.respond = rosterRow('db.admin@example.com');
    await expect(roster.deactivateAdminAction(ROW_1)).resolves.toEqual({ ok: true });
    await expect(roster.activateAdminAction(ROW_1)).resolves.toEqual({ ok: true });
    const grant = h.ops.find((o) => o.table === 'super_admins' && o.kind === 'upsert')!;
    expect(grant.payload).toEqual({ email: 'db.admin@example.com' });
    expect(refusedAudits()).toEqual([]);
    expect(audits().slice(2)).toEqual([
      expect.objectContaining({ action: 'activate', resource: 'admin_users', resource_id: ROW_1, actor_id: 'admin-1' }),
      expect.objectContaining({ action: 'grant', resource: 'super_admins', resource_id: null, metadata: expect.objectContaining({ email: 'db.admin@example.com' }) }),
    ]);
  });

  it('activate grants nothing for a role without console access, or for a built-in admin', async () => {
    h.respond = (op) => (op.table === 'admin_users' && op.kind === 'select'
      ? { data: { id: ROW_2, email: 'viewer@example.com', admin_role: 'viewer' }, error: null }
      : { data: { id: ROW_2 }, error: null });
    await expect(roster.activateAdminAction(ROW_2)).resolves.toEqual({ ok: true });
    h.respond = rosterRow('daniel.hughen@gmail.com');
    await expect(roster.activateAdminAction(ROW_1)).resolves.toEqual({ ok: true });
    expect(h.ops.filter((o) => o.table === 'super_admins')).toEqual([]);
  });

  it('a grant that cannot be restored is reported, not answered with success', async () => {
    h.respond = (op) => (op.table === 'super_admins'
      ? { data: null, error: { message: 'boom', code: '57014' } } : rosterRow('db.admin@example.com')(op));
    expect((await roster.activateAdminAction(ROW_1)).ok).toBe(false);
  });
});

describe('feature-tier changes are audited, carry an actor, and do not lose a concurrent save', () => {
  const gated = Object.values(FEATURE_CATALOG_BY_KEY).filter((d) => d.defaultTier !== 'off');
  const [a, b] = [gated[0], gated[1]];

  it('a set is audited with the previous tier and stamps updated_by', async () => {
    h.respond = (op) => {
      if (op.table === 'app_settings' && op.kind === 'select') return { data: { value: {}, updated_at: 't0' }, error: null };
      if (op.table === 'app_settings' && op.kind === 'update') return { data: [{ key: 'feature_tiers' }], error: null };
      return { data: null, error: null };
    };
    await expect(tiers.setFeatureTierAction(a.key, 'off')).resolves.toEqual({ ok: true });
    const update = h.ops.find((o) => o.table === 'app_settings' && o.kind === 'update')!;
    expect(update.payload).toMatchObject({ value: { [a.key]: 'off' }, updated_by: 'admin-1' });
    expect(update.filters).toContainEqual(['eq', 'updated_at', 't0']);
    expect(audits()).toEqual([expect.objectContaining({
      action: 'update', resource: 'feature_tiers', resource_id: null, actor_id: 'admin-1',
      metadata: expect.objectContaining({ key: a.key, previous_tier: a.defaultTier, tier: 'off' }),
    })]);
    expect(audits()[0].metadata).not.toHaveProperty('resource_key');
  });

  it('a save that lost the race re-reads and keeps the other admin\'s change', async () => {
    let reads = 0;
    h.respond = (op) => {
      if (op.table === 'app_settings' && op.kind === 'select') {
        reads += 1;
        // The other admin's save lands between this one's first read and its write.
        return reads === 1
          ? { data: { value: {}, updated_at: 't0' }, error: null }
          : { data: { value: { [b.key]: 'off' }, updated_at: 't1' }, error: null };
      }
      if (op.table === 'app_settings' && op.kind === 'update') {
        const stamp = op.filters.find((f) => f[1] === 'updated_at')?.[2];
        return stamp === 't1' ? { data: [{ key: 'feature_tiers' }], error: null } : { data: [], error: null };
      }
      return { data: null, error: null };
    };
    await expect(tiers.setFeatureTierAction(a.key, 'off')).resolves.toEqual({ ok: true });
    const landed = h.ops.filter((o) => o.table === 'app_settings' && o.kind === 'update').at(-1)!;
    expect(landed.payload).toMatchObject({ value: { [a.key]: 'off', [b.key]: 'off' } });
    expect(h.ops.some((o) => o.table === 'app_settings' && o.kind === 'upsert')).toBe(false);
  });

  it('a save that keeps losing reports a conflict instead of overwriting', async () => {
    h.respond = (op) => {
      if (op.table === 'app_settings' && op.kind === 'select') return { data: { value: {}, updated_at: `t${h.ops.length}` }, error: null };
      if (op.table === 'app_settings' && op.kind === 'update') return { data: [], error: null };
      return { data: null, error: null };
    };
    await expect(tiers.setFeatureTierAction(a.key, 'off')).resolves.toEqual({ ok: false, error: EN_US['tierFeatures.theFeatureTiersChangedWhileSaving'] });
    expect(audits()).toEqual([]);
  });

  it('a reset is audited with the overrides it cleared and stamps updated_by', async () => {
    h.respond = (op) => (op.table === 'app_settings' && op.kind === 'select'
      ? { data: { value: { [a.key]: 'off' } }, error: null } : { data: null, error: null });
    await expect(tiers.resetFeatureTiersAction()).resolves.toEqual({ ok: true });
    const upsert = h.ops.find((o) => o.table === 'app_settings' && o.kind === 'upsert')!;
    expect(upsert.payload).toMatchObject({ value: {}, updated_by: 'admin-1' });
    expect(audits()).toEqual([expect.objectContaining({
      action: 'reset', resource: 'feature_tiers', resource_id: null, actor_id: 'admin-1',
      metadata: expect.objectContaining({ setting_key: 'feature_tiers', previous_overrides: { [a.key]: 'off' } }),
    })]);
  });
});

describe('an AI engine change is audited without the key', () => {
  it('records the model and that a key was changed, never the key', async () => {
    await expect(ai.saveAIConfigAction(form({ model: 'gpt-5', openaiKey: 'sk-secret-123' }))).resolves.toEqual({ ok: true });
    const [row] = audits();
    expect(row).toMatchObject({ action: 'update', resource: 'app_settings', resource_id: null, actor_id: 'admin-1', metadata: expect.objectContaining({ setting_key: 'ai_provider', model: 'gpt-5', key_changed: true }) });
    expect(JSON.stringify(audits())).not.toContain('sk-secret-123');
  });
});

describe('a marketplace report resolve withdraws only for a report that is still open', () => {
  const world = (reportStatus: string, reportUpdates: boolean) => (op: Op): Answer => {
    if (op.table === 'marketplace_reports' && op.kind === 'select') return { data: { id: 'r1', listing_id: LISTING, status: reportStatus }, error: null };
    if (op.table === 'marketplace_listings' && op.kind === 'select') return { data: { id: LISTING, status: 'available' }, error: null };
    if (op.table === 'marketplace_listings' && op.kind === 'update') return { data: { id: LISTING }, error: null };
    if (op.table === 'marketplace_reports' && op.kind === 'update') return { data: reportUpdates ? { id: 'r1' } : null, error: null };
    return { data: null, error: null };
  };
  const input = { id: 'r1', status: 'actioned' as const, withdrawListing: true };

  it('a report already dismissed is refused before the listing is touched', async () => {
    h.respond = world('dismissed', false);
    await expect(reports.resolveReportAction(input)).resolves.toEqual({ ok: false, error: EN_US['actions.reportNotFoundOrAlready'] });
    expect(writes()).toEqual([]);
  });

  it('a report that another admin resolves mid-flight gets its listing put back', async () => {
    h.respond = world('open', false);
    expect((await reports.resolveReportAction(input)).ok).toBe(false);
    const listingWrites = h.ops.filter((o) => o.table === 'marketplace_listings' && o.kind === 'update').map((o) => o.payload);
    expect(listingWrites).toEqual([{ status: 'withdrawn' }, { status: 'available' }]);
  });

  it('a listing that cannot be put back still has its withdrawal audited', async () => {
    const base = world('open', false);
    let listingUpdates = 0;
    h.respond = (op) => {
      if (op.table === 'marketplace_listings' && op.kind === 'update') {
        listingUpdates += 1;
        return listingUpdates === 1 ? { data: { id: LISTING }, error: null } : { data: null, error: { message: 'boom', code: '57014' } };
      }
      return base(op);
    };
    expect((await reports.resolveReportAction(input)).ok).toBe(false);
    expect(audits()).toEqual([expect.objectContaining({
      action: 'withdraw', resource: 'marketplace_listings', resource_id: LISTING, actor_id: 'admin-1',
      metadata: expect.objectContaining({ restore_failed: true, previous_status: 'available' }),
    })]);
  });

  it('control: an open report is resolved and the withdrawal is audited', async () => {
    h.respond = world('open', true);
    await expect(reports.resolveReportAction(input)).resolves.toEqual({ ok: true });
    expect(audits()).toEqual([expect.objectContaining({ action: 'withdraw', resource: 'marketplace_listings', resource_id: LISTING, actor_id: 'admin-1' })]);
  });
});

describe('an audit row keyed by something other than a uuid still lands', () => {
  it('logAudit moves a non-uuid resourceId into metadata.resource_key and sends null', async () => {
    const { logAudit } = await import('@/lib/server/audit');
    await logAudit(serviceClient as never, { familyId: null, action: 'update', resource: 'app_settings', resourceId: 'some_key', metadata: { a: 1 } });
    await logAudit(serviceClient as never, { familyId: null, action: 'update', resource: 'users', resourceId: NEW_USER });
    expect(refusedAudits()).toEqual([]);
    expect(audits()).toEqual([
      expect.objectContaining({ resource_id: null, metadata: { a: 1, resource_key: 'some_key' } }),
      expect.objectContaining({ resource_id: NEW_USER, metadata: null }),
    ]);
  });

  it('a super-admin grant is audited with the email in metadata', async () => {
    await expect(admin.adminSetSuperAdminAction({ email: 'new.admin@example.com', makeAdmin: true })).resolves.toEqual({ ok: true });
    expect(refusedAudits()).toEqual([]);
    expect(audits()).toEqual([expect.objectContaining({
      action: 'grant', resource: 'super_admins', resource_id: null, actor_id: 'admin-1',
      metadata: expect.objectContaining({ email: 'new.admin@example.com' }),
    })]);
    expect(audits()[0].metadata).not.toHaveProperty('resource_key');
  });

  it('a Stripe save is audited', async () => {
    await expect(admin.saveStripeSettingsAction(stripeInput)).resolves.toEqual({ ok: true });
    expect(refusedAudits()).toEqual([]);
    expect(audits()).toEqual([expect.objectContaining({
      action: 'update', resource: 'stripe_settings', resource_id: null,
      metadata: expect.objectContaining({ setting_key: 'singleton', service_fee_cents: 120 }),
    })]);
  });

  it('a feature-flag toggle is audited with its key', async () => {
    h.respond = (op) => (op.table === 'feature_flags' ? { data: [{ key: 'wallet_virtual_ledger_enabled' }], error: null } : { data: null, error: null });
    await expect(admin.adminToggleFeatureFlagAction('wallet_virtual_ledger_enabled', true)).resolves.toEqual({ ok: true });
    expect(refusedAudits()).toEqual([]);
    expect(audits()).toEqual([expect.objectContaining({
      action: 'update', resource: 'feature_flags', resource_id: null,
      metadata: expect.objectContaining({ key: 'wallet_virtual_ledger_enabled', enabled: true }),
    })]);
  });
});

describe('super-admin surfaces outside /admin ask for the code too', () => {
  const ctx = { user: { id: 'admin-1', email: 'second.admin@example.com' }, active: { familyId: 'fam-1', member: null } };

  it('the feedback status write refuses a password-only session and writes nothing', async () => {
    h.requireUserContext.mockResolvedValue(ctx);
    h.assurance = PASSWORD_ONLY;
    const feedback = await import('@/app/(app)/feedback/actions');
    await expect(feedback.setIdeaStatusAction({ ideaId: 'idea-1', status: 'shipped' })).resolves.toEqual({ ok: false, error: EN_US['actions.teamActionNeedsYourCode'] });
    expect(writes()).toEqual([]);
    expect(h.serviceClientCalls).toBe(0);
  });

  it('control: a stepped-up session moves the idea', async () => {
    h.requireUserContext.mockResolvedValue(ctx);
    h.respond = (op) => (op.table === 'feedback_ideas' ? { data: [{ id: 'idea-1' }], error: null } : { data: null, error: null });
    const feedback = await import('@/app/(app)/feedback/actions');
    await expect(feedback.setIdeaStatusAction({ ideaId: 'idea-1', status: 'shipped' })).resolves.toEqual({ ok: true });
  });

  it.each([
    ['@/app/(app)/dashboard/onboarding-funnel/page', '/dashboard/onboarding-funnel'],
    ['@/app/(app)/dashboard/journeys/page', '/dashboard/journeys'],
    ['@/app/(app)/admin/onboarding/page', '/admin'],
  ])('%s sends a password-only session to step-up before any read', async (path, next) => {
    h.requireUserContext.mockResolvedValue(ctx);
    h.assurance = PASSWORD_ONLY;
    const { default: Page } = await import(path);
    await expect(Page()).rejects.toThrow(`REDIRECT:/auth/step-up?next=${encodeURIComponent(next)}`);
    expect(h.ops).toEqual([]);
    expect(h.serviceClientCalls).toBe(0);
  });
});

describe('the step-up on the way into /admin never provisions a family', () => {
  const params = (next: string) => ({ searchParams: Promise.resolve({ next }) });

  it('asks only for the signed-in user when the destination is the console', async () => {
    h.assurance = PASSWORD_ONLY;
    const { default: StepUpPage } = await import('@/app/(app)/auth/step-up/page');
    await expect(StepUpPage(params('/admin/users'))).resolves.toBeTruthy();
    h.assurance = STEPPED_UP;
    await expect(StepUpPage(params('/admin'))).rejects.toThrow('REDIRECT:/admin');
    expect(h.requireUserContext).not.toHaveBeenCalled();
  });

  it('sends a signed-out visitor to login, back to the console', async () => {
    h.user = null;
    const { default: StepUpPage } = await import('@/app/(app)/auth/step-up/page');
    await expect(StepUpPage(params('/admin'))).rejects.toThrow(`REDIRECT:/login?redirect=${encodeURIComponent('/admin')}`);
    expect(h.requireUserContext).not.toHaveBeenCalled();
  });

  it('control: a family page still resolves the family context', async () => {
    h.requireUserContext.mockResolvedValue({ user: { id: 'admin-1' } });
    h.assurance = STEPPED_UP;
    const { default: StepUpPage } = await import('@/app/(app)/auth/step-up/page');
    await expect(StepUpPage(params('/dashboard/bills'))).rejects.toThrow('REDIRECT:/dashboard/bills');
    expect(h.requireUserContext).toHaveBeenCalled();
  });
});
