// The eight Social Command actions, called the way the console calls them, by
// every household role, on a family with Social and on one without, and with
// another family's ids.
//
// THE POLICY, from the sources rather than from the actions:
//   - The plan: Social is a Basic feature (lib/constants/feature-catalog.ts:69,
//     navigation.ts:128 minLevel 1). Every action but disconnectAccountAction
//     asks resolveFeatureEntitlement('/dashboard/social') and lets a super
//     administrator through (actions.ts `familyId()`); disconnecting is never
//     plan-gated (actions.ts disconnectAccountAction's comment, N2-R1).
//   - The social role: lib/social/roles.ts `defaultSocialRoleForMember` maps a
//     parent to admin, an adult to marketing_manager, a teen to
//     content_creator and everyone else (child, kid login, caregiver, guest) to
//     read_only; an explicit social_access_permissions row overrides it.
//     ROLE_PERMISSIONS decides what each may do, and 0348/0356 make the
//     database ask the same permission on every social table the actions write.
//     requireSocialPermission (lib/social/access.ts) is driven for real here,
//     against the in-memory client, with the caller's auth user.
//   - The family is the session's: every row carries `family_id` from it and
//     every read or write by id is filtered by it.
//
// Seams, each a provider boundary or a module outside this audit's scope:
//   - resolveFeatureEntitlement is answered from the family's plan here, allowed
//     only for '/dashboard/social' on a Basic family;
//   - X's OAuth (`beginXAuthorization`, `clearXTokens`) is stubbed: the OAuth
//     flow itself belongs to another agent's area, so only the gates in front of
//     it are tested;
//   - runPublishNow is stubbed for a publish-now (it contacts providers), and
//     the real one runs for a retry, where every case ends before a provider;
//   - the scheduled-publish receipts (`createScheduledPublishReceipt`,
//     `armScheduledPublishReceipt`, `publishScheduledPostNow`) are stubbed.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';
import {
  FAMILY_A, FAMILY_B, memberRows, userIdOf, type Caller,
} from './helpers/role-callers';

const harness = vi.hoisted(() => ({
  caller: 'parent' as string | null,
  family: '' as string,
  db: null as unknown,
  plans: {} as Record<string, 'free' | 'basic' | 'unreadable'>,
  superAdmin: false,
  revalidated: [] as string[],
  beginX: [] as unknown[],
  clearX: [] as unknown[],
  published: [] as unknown[],
  retrying: false,
}));

vi.mock('next/cache', () => ({ revalidatePath: (path: string) => { harness.revalidated.push(path); } }));
vi.mock('next/headers', () => ({ cookies: async () => ({ set: () => {}, get: () => undefined }), headers: async () => new Headers() }));
vi.mock('@/lib/supabase/auth', async () => {
  const callers = await import('./helpers/role-callers');
  return {
    requireUserContext: async () => (harness.caller
      ? callers.contextFor(harness.caller as Caller, harness.family)
      : callers.signedOut()),
    isSuperAdmin: async () => harness.superAdmin,
    requireFeature: async () => { throw new Error('requireFeature is a page guard, not an action one'); },
  };
});
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => harness.db, createServiceClient: () => harness.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params) };
});
vi.mock('@/lib/server/feature-entitlement', () => ({
  resolveFeatureEntitlement: async (_db: unknown, familyId: string, href: string) => {
    const plan = harness.plans[familyId];
    if (plan === 'unreadable') throw new Error('plan read failed');
    return plan === 'basic' && href === '/dashboard/social'
      ? { allowed: true, planLevel: 1 }
      : { allowed: false, reason: 'plan', needLevel: 1, planLevel: 0 };
  },
}));
vi.mock('@/lib/social/x-oauth', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  beginXAuthorization: async (actor: unknown) => {
    harness.beginX.push(actor);
    return { authorizationUrl: 'https://x.example.com/authorize', cookie: 'flow', redirectUri: 'https://app.example.com/api/social/x/callback' };
  },
}));
vi.mock('@/lib/social/account-tokens', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  clearXTokens: async (...args: unknown[]) => { harness.clearX.push(args); },
}));
vi.mock('@/lib/social/publish', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/social/publish')>();
  return {
    ...actual,
    // A retry runs the real one (every case here ends before a provider); a
    // publish-now from the composer is answered without a provider.
    runPublishNow: async (...args: Parameters<typeof actual.runPublishNow>) => {
      harness.published.push(args.slice(1));
      return harness.retrying
        ? actual.runPublishNow(...args)
        : { postId: args[2], jobId: null, status: 'published', targets: [] };
    },
  };
});
vi.mock('@/lib/social/scheduled-publish', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createScheduledPublishReceipt: async () => ({ receiptId: 'receipt-1' }),
  armScheduledPublishReceipt: async () => ({ phase: 'queued' }),
  publishScheduledPostNow: async () => null,
}));

const actions = await import('@/app/(app)/dashboard/social/actions');
const {
  connectAccountAction, createMediaAction, createPostAction, disconnectAccountAction,
  grantAccessAction, resolveCommentAction, retryPublishAction, updateSettingsAction,
} = actions;

const NOT_IN_PLAN = "Social media tools aren't part of your family's plan.";
const PLAN_UNREADABLE = 'Bubaly could not confirm your plan right now. Try again in a moment.';
const missing = (permission: string) => `Missing social permission: ${permission}`;

const ACCOUNT_A = 'a0000000-0000-4000-8000-0000005ac001';
const ACCOUNT_B = 'b0000000-0000-4000-8000-0000005ac001';
const POST_A = 'a0000000-0000-4000-8000-0000005b0001';
const POST_B = 'b0000000-0000-4000-8000-0000005b0001';
const COMMENT_A = 'a0000000-0000-4000-8000-0000005c0001';
const COMMENT_B = 'b0000000-0000-4000-8000-0000005c0001';

/** By default (lib/social/roles.ts defaultSocialRoleForMember). */
const MANAGERS: Caller[] = ['parent', 'adult'];
const CREATORS: Caller[] = ['parent', 'adult', 'teen'];
const READERS_ONLY: Caller[] = ['child', 'kid', 'caregiver', 'guest'];
const NOT_MANAGERS: Caller[] = ['teen', ...READERS_ONLY];

const SOCIAL_TABLES = [
  'social_accounts', 'social_posts', 'social_post_variants', 'social_post_targets', 'social_schedules',
  'social_calendar_items', 'social_media_library', 'social_settings', 'social_access_permissions', 'social_comments',
];

let db: InMemorySupabase;
const table = (name: string) => db.table(name);
const rowOf = (name: string, id: string) => table(name).find((row) => row.id === id) as Row | undefined;
/** Every social table, as a deep copy, to prove a refused call wrote nothing anywhere. */
const snapshot = () => structuredClone(Object.fromEntries(SOCIAL_TABLES.map((name) => [name, table(name)])));

function form(fields: Record<string, string | string[]>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    for (const item of Array.isArray(value) ? value : [value]) data.append(key, item);
  }
  return data;
}

function as(caller: Caller | null, family = FAMILY_A) {
  harness.caller = caller;
  harness.family = family;
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  for (const name of ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET']) vi.stubEnv(name, '');
  harness.retrying = false;
  db = createInMemorySupabase({
    uniques: { social_settings: [['family_id']], social_access_permissions: [['family_id', 'user_id']] },
  });
  // The session's own auth user, as getSocialAccess reads it.
  harness.db = {
    from: (name: string) => db.from(name),
    rpc: (name: string, args?: Record<string, unknown>) => db.rpc(name, args),
    auth: { getUser: async () => ({ data: { user: harness.caller ? { id: userIdOf(harness.caller as Caller, harness.family) } : null }, error: null }) },
  };
  as('parent');
  harness.plans = { [FAMILY_A]: 'basic', [FAMILY_B]: 'basic' };
  harness.superAdmin = false;
  harness.revalidated = [];
  harness.beginX = [];
  harness.clearX = [];
  harness.published = [];
  db.seed('family_members', [...memberRows(FAMILY_A), ...memberRows(FAMILY_B)]);
  db.seed('social_accounts', [
    { id: ACCOUNT_A, family_id: FAMILY_A, platform: 'linkedin', status: 'connected', deleted_at: null, provider_account_id: null },
    { id: ACCOUNT_B, family_id: FAMILY_B, platform: 'linkedin', status: 'connected', deleted_at: null, provider_account_id: null },
  ]);
  db.seed('social_posts', [
    { id: POST_A, family_id: FAMILY_A, title: 'Ours', body: 'Ours', status: 'partially_published', deleted_at: null, approval_status: 'not_required' },
    { id: POST_B, family_id: FAMILY_B, title: 'Theirs', body: 'Theirs', status: 'failed', deleted_at: null, approval_status: 'not_required' },
  ]);
  db.seed('social_post_targets', [
    { id: 'a0000000-0000-4000-8000-0000005d0001', post_id: POST_A, family_id: FAMILY_A, account_id: ACCOUNT_A, platform: 'linkedin', status: 'published' },
    { id: 'b0000000-0000-4000-8000-0000005d0001', post_id: POST_B, family_id: FAMILY_B, account_id: ACCOUNT_B, platform: 'linkedin', status: 'failed' },
  ]);
  db.seed('social_comments', [
    { id: COMMENT_A, family_id: FAMILY_A, status: 'open', body: 'Nice!' },
    { id: COMMENT_B, family_id: FAMILY_B, status: 'open', body: 'Theirs' },
  ]);
});

describe('connectAccountAction (ACTION-38924C6BA1BC)', () => {
  const connect = () => connectAccountAction(form({ platform: 'linkedin' }));

  it.each(MANAGERS)('ACTION-38924C6BA1BC a %s starts connecting an account for their own family', async (caller) => {
    as(caller);
    expect(await connect()).toEqual({ ok: true, requiresSetup: true });
    expect(table('social_accounts').filter((row) => row.id !== ACCOUNT_A && row.id !== ACCOUNT_B)).toEqual([
      expect.objectContaining({ family_id: FAMILY_A, platform: 'linkedin', status: 'requires_setup', user_id: userIdOf(caller), created_by: userIdOf(caller) }),
    ]);
  });

  it.each(NOT_MANAGERS)('ACTION-38924C6BA1BC a %s is refused connect_accounts and nothing is written', async (caller) => {
    as(caller);
    const before = snapshot();
    await expect(connect()).rejects.toThrow(missing('connect_accounts'));
    await expect(connectAccountAction(form({ platform: 'x' }))).rejects.toThrow(missing('connect_accounts'));
    expect(harness.beginX).toEqual([]);
    expect(snapshot()).toEqual(before);
  });

  it('ACTION-38924C6BA1BC a parent starts X authorization for their own family (the OAuth flow itself is out of scope)', async () => {
    expect(await connectAccountAction(form({ platform: 'x' }))).toEqual(expect.objectContaining({ ok: true, authorizationUrl: 'https://x.example.com/authorize' }));
    expect(harness.beginX).toEqual([{ familyId: FAMILY_A, userId: userIdOf('parent') }]);
  });

  it('ACTION-38924C6BA1BC a parent of a family without Social is refused, and a super administrator is not', async () => {
    harness.plans[FAMILY_A] = 'free';
    const before = snapshot();
    expect(await connect()).toEqual({ ok: false, error: NOT_IN_PLAN });
    expect(await connectAccountAction(form({ platform: 'x' }))).toEqual({ ok: false, error: NOT_IN_PLAN });
    expect(harness.beginX).toEqual([]);
    expect(snapshot()).toEqual(before);

    harness.superAdmin = true;
    expect(await connect()).toEqual({ ok: true, requiresSetup: true });
    expect(table('social_accounts')).toHaveLength(3);
  });

  it('ACTION-38924C6BA1BC an unreadable plan is refused, and a signed-out caller is sent to sign in', async () => {
    harness.plans[FAMILY_A] = 'unreadable';
    const before = snapshot();
    expect(await connect()).toEqual({ ok: false, error: PLAN_UNREADABLE });
    as(null);
    await expect(connect()).rejects.toThrow('NEXT_REDIRECT');
    expect(snapshot()).toEqual(before);
  });
});

describe('disconnectAccountAction (ACTION-34DED829EF63)', () => {
  it.each(MANAGERS)('ACTION-34DED829EF63 a %s disconnects an account of their own family', async (caller) => {
    as(caller);
    expect(await disconnectAccountAction(ACCOUNT_A)).toEqual({ ok: true });
    expect(rowOf('social_accounts', ACCOUNT_A)).toEqual(expect.objectContaining({ status: 'disconnected', updated_by: userIdOf(caller), deleted_at: expect.any(String) }));
    expect(rowOf('social_accounts', ACCOUNT_B)?.status).toBe('connected');
  });

  it.each(NOT_MANAGERS)('ACTION-34DED829EF63 a %s is refused connect_accounts and the account stays connected', async (caller) => {
    as(caller);
    const before = snapshot();
    await expect(disconnectAccountAction(ACCOUNT_A)).rejects.toThrow(missing('connect_accounts'));
    expect(snapshot()).toEqual(before);
  });

  it('ACTION-34DED829EF63 a parent of a family without Social may still disconnect (removal is never plan-gated)', async () => {
    harness.plans[FAMILY_A] = 'free';
    expect(await disconnectAccountAction(ACCOUNT_A)).toEqual({ ok: true });
    expect(rowOf('social_accounts', ACCOUNT_A)?.status).toBe('disconnected');
  });

  it("ACTION-34DED829EF63 another family's account is not disconnected, and its tokens are not touched", async () => {
    db.table('social_accounts').push({ ...structuredClone(rowOf('social_accounts', ACCOUNT_B)!), id: 'b0000000-0000-4000-8000-0000005ac00f', platform: 'x' });
    const before = snapshot();
    expect(await disconnectAccountAction(ACCOUNT_B)).toEqual({ ok: false, error: 'Could not disconnect that account.' });
    expect(await disconnectAccountAction('b0000000-0000-4000-8000-0000005ac00f')).toEqual({ ok: false, error: 'Could not disconnect that account.' });
    expect(harness.clearX).toEqual([]);
    expect(snapshot()).toEqual(before);
  });

  it('ACTION-34DED829EF63 a signed-out caller is sent to sign in', async () => {
    as(null);
    const before = snapshot();
    await expect(disconnectAccountAction(ACCOUNT_A)).rejects.toThrow('NEXT_REDIRECT');
    expect(snapshot()).toEqual(before);
  });
});

describe('createPostAction (ACTION-3C9C7E7C3208)', () => {
  const draft = () => createPostAction(form({ intent: 'draft', title: 'Bake sale', body: 'Saturday at ten', platforms: ['linkedin'] }));
  const created = () => table('social_posts').filter((row) => row.id !== POST_A && row.id !== POST_B);

  it.each(CREATORS)('ACTION-3C9C7E7C3208 a %s saves a draft in their own family, with its variant', async (caller) => {
    as(caller);
    const result = await draft();
    expect(created()).toEqual([expect.objectContaining({ family_id: FAMILY_A, status: 'draft', body: 'Saturday at ten', user_id: userIdOf(caller), created_by: userIdOf(caller) })]);
    expect(result).toEqual({ ok: true, postId: created()[0].id, action: 'draft' });
    expect(table('social_post_variants')).toEqual([expect.objectContaining({ post_id: created()[0].id, family_id: FAMILY_A, platform: 'linkedin' })]);
  });

  it.each(READERS_ONLY)('ACTION-3C9C7E7C3208 a %s is refused a draft and nothing is written', async (caller) => {
    as(caller);
    const before = snapshot();
    expect(await draft()).toEqual({ ok: false, error: 'You do not have permission to draft posts.' });
    expect(snapshot()).toEqual(before);
  });

  it.each(MANAGERS)('ACTION-3C9C7E7C3208 a %s publishes now to an account of their own family (the provider call is stubbed)', async (caller) => {
    as(caller);
    const result = await createPostAction(form({ intent: 'publish', body: 'Live', platforms: ['linkedin'], account_ids: [ACCOUNT_A] }));
    expect(result).toEqual(expect.objectContaining({ ok: true, action: 'publish', postId: created()[0].id }));
    expect(table('social_post_targets').filter((row) => row.post_id === created()[0].id)).toEqual([
      expect.objectContaining({ family_id: FAMILY_A, account_id: ACCOUNT_A, status: 'pending' }),
    ]);
    expect(harness.published).toEqual([[FAMILY_A, created()[0].id, userIdOf(caller)]]);
  });

  it.each(NOT_MANAGERS)('ACTION-3C9C7E7C3208 a %s is refused publish and schedule, and nothing is written', async (caller) => {
    as(caller);
    const before = snapshot();
    expect(await createPostAction(form({ intent: 'publish', body: 'Live', platforms: ['linkedin'], account_ids: [ACCOUNT_A] })))
      .toEqual({ ok: false, error: 'You do not have permission to publish posts.' });
    expect(await createPostAction(form({ intent: 'schedule', body: 'Later', platforms: ['x'], account_ids: [ACCOUNT_A], scheduled_for: '2030-01-15T15:00:00.000Z', timezone: 'America/New_York' })))
      .toEqual({ ok: false, error: 'You do not have permission to schedule posts.' });
    expect(harness.published).toEqual([]);
    expect(snapshot()).toEqual(before);
  });

  it("ACTION-3C9C7E7C3208 another family's account is not a target: the post is rolled back and nothing is sent", async () => {
    const before = snapshot();
    const result = await createPostAction(form({ intent: 'publish', body: 'Live', platforms: ['linkedin'], account_ids: [ACCOUNT_B] }));
    // createTargets refuses the foreign id ("One or more selected social
    // accounts are unavailable"); the action reports its own sentence and
    // deletes the post it had just created.
    expect(result).toEqual({ ok: false, error: 'Social publishing could not be saved completely. Review the post status before retrying.' });
    expect(harness.published).toEqual([]);
    // The variant written before the refusal belongs to the post the action
    // deleted; 0034 declares social_post_variants.post_id `on delete cascade`,
    // which this client does not run, so it is dropped here as Postgres would.
    const orphans = table('social_post_variants').filter((row) => !table('social_posts').some((post) => post.id === row.post_id));
    expect(orphans).toEqual([expect.objectContaining({ family_id: FAMILY_A, body: 'Live' })]);
    db.replace('social_post_variants', table('social_post_variants').filter((row) => !orphans.includes(row)));
    expect(snapshot()).toEqual(before);
  });

  it('ACTION-3C9C7E7C3208 a parent of a family without Social is refused, and a super administrator is not', async () => {
    harness.plans[FAMILY_A] = 'free';
    const before = snapshot();
    expect(await draft()).toEqual({ ok: false, error: NOT_IN_PLAN });
    expect(snapshot()).toEqual(before);
    harness.superAdmin = true;
    expect(await draft()).toEqual(expect.objectContaining({ ok: true, action: 'draft' }));
    expect(created()).toHaveLength(1);
  });

  it('ACTION-3C9C7E7C3208 a signed-out caller is sent to sign in', async () => {
    as(null);
    const before = snapshot();
    await expect(draft()).rejects.toThrow('NEXT_REDIRECT');
    expect(snapshot()).toEqual(before);
  });
});

describe('retryPublishAction (ACTION-FD08580CBD41)', () => {
  beforeEach(() => { harness.retrying = true; });

  it.each(MANAGERS)('ACTION-FD08580CBD41 a %s retries a post of their own family', async (caller) => {
    as(caller);
    const before = snapshot();
    const result = await retryPublishAction(POST_A);
    // POST_A's one target is already published, so the real runner reports it
    // and writes nothing: no provider is reached.
    expect(result).toEqual({ ok: true, postId: POST_A, action: 'publish', outcome: expect.objectContaining({ postId: POST_A, status: 'published' }) });
    expect(snapshot()).toEqual(before);
  });

  it.each(NOT_MANAGERS)('ACTION-FD08580CBD41 a %s is refused publish_posts and nothing runs', async (caller) => {
    as(caller);
    expect(await retryPublishAction(POST_A)).toEqual({ ok: false, error: 'You do not have permission to publish posts.' });
    expect(harness.published).toEqual([]);
  });

  it("ACTION-FD08580CBD41 another family's failed post is not retried and is left as it was", async () => {
    const before = snapshot();
    const result = await retryPublishAction(POST_B);
    expect(result).toEqual({ ok: false, postId: POST_B, error: 'Social publishing could not be saved completely. Review the post status before retrying.' });
    expect(snapshot()).toEqual(before);
  });

  it('ACTION-FD08580CBD41 a parent of a family without Social is refused before anything runs', async () => {
    harness.plans[FAMILY_A] = 'free';
    expect(await retryPublishAction(POST_A)).toEqual({ ok: false, error: NOT_IN_PLAN });
    expect(harness.published).toEqual([]);
    harness.superAdmin = true;
    expect(await retryPublishAction(POST_A)).toEqual(expect.objectContaining({ ok: true, postId: POST_A }));
  });
});

describe('resolveCommentAction (ACTION-29B242DBD1B3)', () => {
  // view_feed is every default social role's; which permission the inbox should
  // take is recorded as the owner's decision (lib/social/roles.ts), so only the
  // managers, whom any choice includes, are pinned here.
  it.each(MANAGERS)('ACTION-29B242DBD1B3 a %s resolves a comment of their own family', async (caller) => {
    as(caller);
    await expect(resolveCommentAction(COMMENT_A)).resolves.toBeUndefined();
    expect(rowOf('social_comments', COMMENT_A)).toEqual(expect.objectContaining({ status: 'resolved', updated_by: userIdOf(caller) }));
  });

  it('ACTION-29B242DBD1B3 a caller whose membership has ended holds no social role and is refused', async () => {
    as('child');
    const row = table('family_members').find((m) => m.user_id === userIdOf('child') && m.family_id === FAMILY_A)!;
    row.is_active = false;
    await expect(resolveCommentAction(COMMENT_A)).rejects.toThrow(missing('view_feed'));
    expect(rowOf('social_comments', COMMENT_A)?.status).toBe('open');
  });

  it("ACTION-29B242DBD1B3 another family's comment is not found and stays open", async () => {
    const before = snapshot();
    await expect(resolveCommentAction(COMMENT_B)).rejects.toThrow('That item could not be found — it may have already been removed.');
    expect(snapshot()).toEqual(before);
  });

  it('ACTION-29B242DBD1B3 a family without Social is refused, a super administrator is not, and a signed-out caller is sent to sign in', async () => {
    harness.plans[FAMILY_A] = 'free';
    await expect(resolveCommentAction(COMMENT_A)).rejects.toThrow(NOT_IN_PLAN);
    expect(rowOf('social_comments', COMMENT_A)?.status).toBe('open');
    as(null);
    await expect(resolveCommentAction(COMMENT_A)).rejects.toThrow('NEXT_REDIRECT');
    as('parent');
    harness.superAdmin = true;
    await expect(resolveCommentAction(COMMENT_A)).resolves.toBeUndefined();
    expect(rowOf('social_comments', COMMENT_A)?.status).toBe('resolved');
  });
});

describe('createMediaAction (ACTION-9F9715F212FF)', () => {
  const upload = () => createMediaAction(form({ title: 'Logo', url: 'https://cdn.example.com/logo.png', kind: 'image', tags: 'brand, logo' }));

  it.each(CREATORS)('ACTION-9F9715F212FF a %s adds media to their own family library', async (caller) => {
    as(caller);
    await expect(upload()).resolves.toBeUndefined();
    expect(table('social_media_library')).toEqual([expect.objectContaining({ family_id: FAMILY_A, user_id: userIdOf(caller), title: 'Logo', tags: ['brand', 'logo'], status: 'ready' })]);
  });

  it.each(READERS_ONLY)('ACTION-9F9715F212FF a %s is refused upload_media and nothing is written', async (caller) => {
    as(caller);
    await expect(upload()).rejects.toThrow(missing('upload_media'));
    expect(table('social_media_library')).toEqual([]);
  });

  it('ACTION-9F9715F212FF a family without Social is refused, and a super administrator is not', async () => {
    harness.plans[FAMILY_A] = 'free';
    await expect(upload()).rejects.toThrow(NOT_IN_PLAN);
    expect(table('social_media_library')).toEqual([]);
    harness.superAdmin = true;
    await expect(upload()).resolves.toBeUndefined();
    expect(table('social_media_library')).toHaveLength(1);
  });
});

describe('updateSettingsAction (ACTION-FD1221F34629)', () => {
  const save = () => updateSettingsAction(form({ default_timezone: 'America/New_York', ai_tone: 'warm', require_approval: 'on' }));

  it.each(MANAGERS)('ACTION-FD1221F34629 a %s saves their own family settings', async (caller) => {
    as(caller);
    await expect(save()).resolves.toBeUndefined();
    expect(table('social_settings')).toEqual([expect.objectContaining({ family_id: FAMILY_A, ai_tone: 'warm', require_approval: true, updated_by: userIdOf(caller) })]);
  });

  it.each(NOT_MANAGERS)('ACTION-FD1221F34629 a %s is refused manage_settings and nothing is written', async (caller) => {
    as(caller);
    await expect(save()).rejects.toThrow(missing('manage_settings'));
    expect(table('social_settings')).toEqual([]);
  });

  it("ACTION-FD1221F34629 a parent's save never touches another family's settings", async () => {
    db.seed('social_settings', [{ family_id: FAMILY_B, ai_tone: 'theirs', require_approval: true }]);
    await save();
    expect(table('social_settings').find((row) => row.family_id === FAMILY_B)).toEqual(expect.objectContaining({ ai_tone: 'theirs', require_approval: true }));
  });

  it('ACTION-FD1221F34629 a family without Social is refused, and a super administrator is not', async () => {
    harness.plans[FAMILY_A] = 'free';
    await expect(save()).rejects.toThrow(NOT_IN_PLAN);
    expect(table('social_settings')).toEqual([]);
    harness.superAdmin = true;
    await expect(save()).resolves.toBeUndefined();
    expect(table('social_settings')).toHaveLength(1);
  });
});

describe('grantAccessAction (ACTION-EB48756176AA)', () => {
  const grant = (userId: string, role = 'content_creator') => grantAccessAction(form({ user_id: userId, social_role: role }));
  /** An explicit social owner: the one role holding manage_access (lib/social/roles.ts). */
  const makeOwner = (caller: Caller) => db.seed('social_access_permissions', [
    { family_id: FAMILY_A, user_id: userIdOf(caller), social_role: 'owner', status: 'active' },
  ]);

  it('ACTION-EB48756176AA a social owner grants a member of their own family a social role', async () => {
    makeOwner('parent');
    await expect(grant(userIdOf('child'))).resolves.toBeUndefined();
    expect(table('social_access_permissions').find((row) => row.user_id === userIdOf('child')))
      .toEqual(expect.objectContaining({ family_id: FAMILY_A, social_role: 'content_creator', granted_by: userIdOf('parent'), status: 'active' }));
  });

  // A parent is left out on purpose: the database lets a family admin write
  // these rows (0034's insert/update policies) while the app gives manage_access
  // to an explicit owner alone. That is recorded as the owner's decision.
  it.each(['adult', ...NOT_MANAGERS] as Caller[])('ACTION-EB48756176AA a %s without an owner grant is refused manage_access', async (caller) => {
    as(caller);
    const before = snapshot();
    await expect(grant(userIdOf('child'))).rejects.toThrow(missing('manage_access'));
    expect(snapshot()).toEqual(before);
  });

  it("ACTION-EB48756176AA a social owner cannot grant a role to another family's member", async () => {
    makeOwner('parent');
    const before = snapshot();
    await expect(grant(userIdOf('child', FAMILY_B))).rejects.toThrow('That user is not an active family member.');
    expect(snapshot()).toEqual(before);
  });

  it('ACTION-EB48756176AA a family without Social is refused, and a super administrator is not', async () => {
    makeOwner('parent');
    harness.plans[FAMILY_A] = 'free';
    await expect(grant(userIdOf('child'))).rejects.toThrow(NOT_IN_PLAN);
    expect(table('social_access_permissions')).toHaveLength(1);
    harness.superAdmin = true;
    await expect(grant(userIdOf('child'))).resolves.toBeUndefined();
    expect(table('social_access_permissions')).toHaveLength(2);
  });

  it('ACTION-EB48756176AA a signed-out caller is sent to sign in', async () => {
    as(null);
    await expect(grant(userIdOf('child'))).rejects.toThrow('NEXT_REDIRECT');
    expect(table('social_access_permissions')).toEqual([]);
  });
});

// Every export of the file is driven above.
it('ACTION-3C9C7E7C3208 the file exports exactly the eight actions under test', () => {
  expect(Object.keys(actions).sort()).toEqual([
    'connectAccountAction', 'createMediaAction', 'createPostAction', 'disconnectAccountAction',
    'grantAccessAction', 'resolveCommentAction', 'retryPublishAction', 'updateSettingsAction',
  ]);
});
