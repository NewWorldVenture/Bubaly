import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { InMemorySupabase } from './helpers/in-memory-supabase';

// Actual actions, schedule-time helpers and target creation execute. The private
// receipt seam is controlled here; its real authority/CAS chain has separate tests.
const state = vi.hoisted(() => ({
  db: undefined as unknown as InMemorySupabase, create: vi.fn(), arm: vi.fn(), scheduledNow: vi.fn(), manual: vi.fn(),
  permission: vi.fn(), operations: [] as Array<{ table: string; operation: string }>,
  fault: null as null | { table: string; operation: string; after?: boolean; throw?: boolean; data?: unknown },
}));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => state.db }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: async () => ({ active: { familyId: '11111111-1111-4111-8111-111111111111' }, user: { id: '22222222-2222-4222-8222-222222222222' } }) }));
vi.mock('@/lib/social/access', () => ({ requireSocialPermission: state.permission }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key, getLocaleContext: async () => ({ locale: { code: 'en-US' } }) }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: async () => ({ set() {} }) }));
vi.mock('next/link', () => ({ default: 'a' }));
vi.mock('next/navigation', () => ({ notFound() { throw new Error('not found'); } }));
vi.mock('@/lib/social/x-oauth', () => ({}));
vi.mock('@/lib/social/account-tokens', () => ({}));
vi.mock('@/lib/social/scheduled-publish', () => ({
  createScheduledPublishReceipt: state.create, armScheduledPublishReceipt: state.arm, publishScheduledPostNow: state.scheduledNow,
  ScheduledPublishError: class ScheduledPublishError extends Error { constructor(readonly key: string) { super(key); } },
}));
vi.mock('@/lib/social/publish', async original => ({ ...await original<typeof import('@/lib/social/publish')>(), runPublishNow: state.manual }));
vi.mock('@/lib/social/queries', () => ({ getPost: async () => ({ post: state.db.table('social_posts')[0], variants: [], targets: state.db.table('social_post_targets'), results: [] }) }));
import { createPostAction, retryPublishAction } from '@/app/(app)/dashboard/social/actions';
import PostPage from '@/app/(app)/dashboard/social/posts/[id]/page';

const FAMILY = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '33333333-3333-4333-8333-333333333333';
const OTHER_ACCOUNT = '44444444-4444-4444-8444-444444444444';
const RECEIPT = '55555555-5555-4555-8555-555555555555';
function form(patch: Record<string, string | string[]> = {}) {
  const values: Record<string, string | string[]> = { intent: 'schedule', kind: 'text', body: 'A bounded scheduled post',
    scheduled_for: '2026-09-13T13:00:00.000Z', scheduled_local: '2026-09-13T09:00', timezone: 'America/New_York',
    platforms: ['x'], account_ids: [ACCOUNT], recurrence: 'none', ...patch };
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) for (const item of Array.isArray(value) ? value : [value]) data.append(key, item);
  return data;
}
const writes = () => state.operations.filter(item => item.operation !== 'select');

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-12T12:00:00Z'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  state.create.mockReset().mockResolvedValue({ receiptId: RECEIPT });
  state.arm.mockReset().mockResolvedValue({ phase: 'queued' });
  state.scheduledNow.mockReset().mockResolvedValue(null);
  state.manual.mockReset().mockResolvedValue({ status: 'published', targets: [] });
  state.permission.mockReset().mockResolvedValue({});
  state.operations = []; state.fault = null;
  state.db = new InMemorySupabase({ defaults: { social_posts: { deleted_at: null, approval_status: 'not_required', metadata: {} } } });
  state.db.seed('social_accounts', [{ id: ACCOUNT, family_id: FAMILY, platform: 'x', status: 'connected', provider_account_id: '12345', deleted_at: null }]);
  const from = state.db.from.bind(state.db);
  vi.spyOn(state.db, 'from').mockImplementation(table => {
    const query = from(table); let operation = 'select';
    const execute = async (run: () => unknown) => {
      state.operations.push({ table, operation });
      const fault = state.fault?.table === table && state.fault.operation === operation ? state.fault : null;
      if (fault && !fault.after) {
        if (fault.throw) throw new Error('Synthetic transport failure');
        return { data: null, error: { code: '42501', message: 'Synthetic required storage failure' }, count: null };
      }
      const result = await run() as { data: unknown; error: unknown; count: number | null };
      if (fault?.after) {
        if (fault.throw) throw new Error('Synthetic response lost after commit');
        return { ...result, data: fault.data };
      }
      return result;
    };
    const proxy = new Proxy(query, { get(target, key) {
      if (key === 'then') return (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) => execute(() => target).then(resolve, reject);
      if (key === 'single' || key === 'maybeSingle') return () => execute(() => target[key]());
      const member = Reflect.get(target, key);
      if (typeof member !== 'function') return member;
      return (...args: unknown[]) => {
        if (['insert', 'update', 'delete', 'upsert'].includes(String(key))) operation = String(key);
        const result = Reflect.apply(member, target, args);
        return result === target ? proxy : result;
      };
    } });
    return proxy;
  });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('scheduled action rejects invalid intent and time before writes', () => {
  it.each([
    ['unknown intent', { intent: 'reschedule_everything' }],
    ['missing zone', { timezone: '' }], ['invalid zone', { timezone: 'Mars/Olympus' }],
    ['bare local instant', { scheduled_for: '2026-09-13T09:00' }],
    ['local and absolute mismatch', { scheduled_local: '2026-09-13T10:00' }],
    ['past instant', { scheduled_for: '2026-09-11T13:00:00.000Z', scheduled_local: '' }],
    ['clock gap', { scheduled_local: '2027-03-14T02:30', scheduled_for: '2027-03-14T07:30:00.000Z' }],
    ['clock overlap', { scheduled_local: '2026-11-01T01:30', scheduled_for: '2026-11-01T05:30:00.000Z' }],
    ['unsupported media', { kind: 'video' }], ['unsupported platform', { platforms: ['facebook'] }],
    ['unknown platform', { platforms: ['made-up-platform'] }],
    ['recurrence', { recurrence: 'weekly' }], ['no account', { account_ids: [] }],
    ['too many accounts', { account_ids: Array.from({ length: 11 }, (_, i) => `account-${i}`) }],
    ['body bound', { body: 'x'.repeat(10_001) }],
  ] as Array<[string, Record<string, string | string[]>]>)('%s', async (_label, patch) => {
    expect(await createPostAction(form(patch))).toMatchObject({ ok: false });
    expect(writes()).toEqual([]); expect(state.create).not.toHaveBeenCalled(); expect(state.arm).not.toHaveBeenCalled();
  });
  it.each(['disconnected', 'wrong platform', 'deleted', 'foreign family', 'missing provider identity'])('rejects %s account before writes', async mode => {
    Object.assign(state.db.table('social_accounts')[0], mode === 'disconnected' ? { status: 'disconnected' }
      : mode === 'wrong platform' ? { platform: 'facebook' } : mode === 'deleted' ? { deleted_at: '2026-01-01' }
        : mode === 'foreign family' ? { family_id: 'other-family' } : { provider_account_id: null });
    expect(await createPostAction(form())).toMatchObject({ ok: false }); expect(writes()).toEqual([]);
  });
  it('rejects repeated provider account identities', async () => {
    state.db.seed('social_accounts', [{ ...state.db.table('social_accounts')[0], id: OTHER_ACCOUNT }]);
    expect(await createPostAction(form({ account_ids: [ACCOUNT, OTHER_ACCOUNT] }))).toMatchObject({ ok: false });
    expect(writes()).toEqual([]);
  });
  it.each([false, true])('fails closed on returned/thrown account read failure: %s', async throws => {
    state.fault = { table: 'social_accounts', operation: 'select', throw: throws };
    expect(await createPostAction(form())).toMatchObject({ ok: false }); expect(writes()).toEqual([]);
  });
  it.each([
    ['oversize text', { body: 'x'.repeat(281) }],
    ['body plus link exceeds provider limit', { kind: 'link', body: 'x'.repeat(257), link: 'https://example.invalid/story' }],
    ['empty provider payload despite title', { title: 'A title is not sent to X', body: '' }],
    ['link kind missing required link', { kind: 'link', link: '' }],
  ] as Array<[string, Record<string, string | string[]>]>)('rejects %s before queuing', async (_label, patch) => {
    expect(await createPostAction(form(patch))).toMatchObject({ ok: false });
    expect(writes()).toEqual([]); expect(state.create).not.toHaveBeenCalled(); expect(state.arm).not.toHaveBeenCalled();
  });
  it.each([
    ['exact text limit', { body: 'x'.repeat(280) }],
    ['body plus weighted link exactly fits', { kind: 'link', body: 'x'.repeat(256), link: 'https://example.invalid/story' }],
    ['long URL still has fixed provider weight', { body: `A link https://example.invalid/${'a'.repeat(400)}` }],
  ] as Array<[string, Record<string, string | string[]>]>)('preserves %s', async (_label, patch) => {
    expect(await createPostAction(form(patch))).toMatchObject({ ok: true, action: 'schedule' });
    expect(state.arm).toHaveBeenCalledOnce();
  });
});

describe('scheduled action persistence and arming', () => {
  it.each(['queued', 'approval_required'])('confirms %s only after exact public rows and private arm', async phase => {
    state.arm.mockResolvedValue({ phase });
    const result = await createPostAction(form());
    expect(result).toMatchObject({ ok: true, action: 'schedule', schedulePhase: phase });
    expect(state.db.table('social_schedules')).toHaveLength(1); expect(state.db.table('social_calendar_items')).toHaveLength(1);
    expect(state.create).toHaveBeenCalledWith(expect.objectContaining({ familyId: FAMILY, postId: result.postId,
      scheduleId: state.db.table('social_schedules')[0].id, scheduledFor: '2026-09-13T13:00:00.000Z', timezone: 'America/New_York',
      expected: { kind: 'text', body: 'A bounded scheduled post', link: null, accountIds: [ACCOUNT] } }));
    expect(state.arm).toHaveBeenCalledWith(RECEIPT); expect(state.manual).not.toHaveBeenCalled();
  });
  it.each(['social_post_variants', 'social_post_targets', 'social_schedules', 'social_calendar_items'])('cleans an unarmed post after %s rejects', async table => {
    state.fault = { table, operation: 'insert' };
    expect(await createPostAction(form())).toMatchObject({ ok: false });
    expect(state.db.table('social_posts')).toEqual([]); expect(state.arm).not.toHaveBeenCalled();
  });
  it.each([
    { table: 'social_schedules', data: null }, { table: 'social_schedules', data: {} },
    { table: 'social_schedules', data: { id: 'invalid-id' } },
    { table: 'social_calendar_items', data: [] }, { table: 'social_calendar_items', data: [{}] },
    { table: 'social_calendar_items', data: [{ id: 'invalid-id' }] },
  ])('rejects malformed $table receipt $data before arm', async ({ table, data }) => {
    state.fault = { table, operation: 'insert', after: true, data };
    expect(await createPostAction(form())).toMatchObject({ ok: false });
    expect(state.arm).not.toHaveBeenCalled(); expect(state.create).not.toHaveBeenCalled();
  });
  it('cleans public post after private unarmed receipt preparation fails', async () => {
    state.create.mockRejectedValue(new Error('Synthetic private preparation failure'));
    expect(await createPostAction(form())).toMatchObject({ ok: false }); expect(state.db.table('social_posts')).toEqual([]);
    expect(state.arm).not.toHaveBeenCalled();
  });
  it('retains post identity and suppresses cleanup when arm commits but its response is lost', async () => {
    let committed = false;
    state.arm.mockImplementation(async () => { committed = true; throw new Error('Synthetic lost arm response'); });
    const result = await createPostAction(form());
    expect(committed).toBe(true); expect(result).toMatchObject({ ok: false, action: 'schedule', postId: state.db.table('social_posts')[0].id });
    expect(state.db.table('social_posts')).toHaveLength(1);
    expect(writes().filter(item => item.operation === 'delete')).toEqual([]);
  });
  it.each(['draft', 'schedule', 'publish'].flatMap(intent => [null, {}, { id: 'invalid-id' }].map(data => ({ intent, data }))))('requires review after an ambiguous initial $intent insert receipt: $data', async ({ intent, data }) => {
    state.fault = { table: 'social_posts', operation: 'insert', after: true, data };
    expect(await createPostAction(form({ intent }))).toMatchObject({ ok: false, reviewRequired: true });
    expect(state.db.table('social_posts')).toHaveLength(1);
    expect(state.arm).not.toHaveBeenCalled(); expect(state.manual).not.toHaveBeenCalled();
    expect(writes().some(write => write.table !== 'social_posts' || write.operation !== 'insert')).toBe(false);
  });
  it('keeps a definitive initial insert rejection editable without a false saved identity', async () => {
    state.fault = { table: 'social_posts', operation: 'insert' };
    const result = await createPostAction(form());
    expect(result).toMatchObject({ ok: false });
    expect(result).not.toMatchObject({ reviewRequired: true });
    expect(result.postId).toBeUndefined(); expect(state.db.table('social_posts')).toEqual([]);
  });
  it.each(['draft', 'schedule', 'publish'])('requires review after the initial %s insert commits then throws', async intent => {
    state.fault = { table: 'social_posts', operation: 'insert', after: true, throw: true };
    expect(await createPostAction(form({ intent }))).toMatchObject({ ok: false, reviewRequired: true });
    expect(state.db.table('social_posts')).toHaveLength(1);
    expect(state.arm).not.toHaveBeenCalled(); expect(state.manual).not.toHaveBeenCalled();
    expect(writes()).toEqual([{ table: 'social_posts', operation: 'insert' }]);
  });
  it.each([false, true])('retains identity for review if unarmed cleanup fails or throws: %s', async throws => {
    state.create.mockRejectedValue(new Error('Synthetic private preparation failure'));
    state.fault = { table: 'social_posts', operation: 'delete', throw: throws };
    const result = await createPostAction(form());
    expect(state.db.table('social_posts')).toHaveLength(1);
    expect(result).toMatchObject({ ok: false, reviewRequired: true, postId: state.db.table('social_posts')[0].id });
    expect(state.arm).not.toHaveBeenCalled(); expect(state.manual).not.toHaveBeenCalled();
  });
  it.each([null, [], [{}], [{ id: 'invalid-id' }]].map(data => ({ data })))('does not treat an unconfirmed cleanup receipt as permission to recreate: $data', async ({ data }) => {
    state.create.mockRejectedValue(new Error('Synthetic private preparation failure'));
    state.fault = { table: 'social_posts', operation: 'delete', after: true, data };
    const result = await createPostAction(form());
    expect(result).toMatchObject({ ok: false, reviewRequired: true });
    expect(result.postId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(state.db.table('social_posts')).toEqual([]);
    expect(state.arm).not.toHaveBeenCalled(); expect(state.manual).not.toHaveBeenCalled();
  });
});

describe('scheduled retry authority branch', () => {
  it.each(['scheduled', 'publishing', 'failed'])('never falls back to live publish when the private helper returns %s', async status => {
    state.scheduledNow.mockResolvedValue({ status, targets: [], postId: RECEIPT, jobId: null });
    expect(await retryPublishAction(RECEIPT)).toMatchObject({ ok: true, postId: RECEIPT, outcome: { status } });
    expect(state.manual).not.toHaveBeenCalled();
  });
  it('does not fall back after private authority read failure', async () => {
    state.scheduledNow.mockRejectedValue(new Error('Private read unavailable'));
    expect(await retryPublishAction(RECEIPT)).toMatchObject({ ok: false, postId: RECEIPT });
    expect(state.manual).not.toHaveBeenCalled();
  });
  it('uses the existing manual path only for an explicit null private result', async () => {
    expect(await retryPublishAction(RECEIPT)).toMatchObject({ ok: true }); expect(state.manual).toHaveBeenCalledOnce();
  });
});

describe('post input URL boundary review', () => {
  it('rejects an active-content link before schedule persistence', async () => {
    expect(await createPostAction(form({ kind: 'link', link: 'javascript:alert(document.domain)' }))).toMatchObject({ ok: false });
    expect(writes()).toEqual([]);
  });
  it('bounds link text before schedule persistence', async () => {
    expect(await createPostAction(form({ kind: 'link', link: `https://example.invalid/${'a'.repeat(4096)}` }))).toMatchObject({ ok: false });
    expect(writes()).toEqual([]);
  });
  it('does not render a stored active-content URL as a clickable post link', async () => {
    const result = await createPostAction(form({ intent: 'draft', kind: 'link', link: 'javascript:alert(document.domain)' }));
    if (!result.ok) expect(writes()).toEqual([]);
    else expect(renderToStaticMarkup(await PostPage({ params: Promise.resolve({ id: result.postId! }) }))).not.toContain('href="javascript:');
  });
  it.each(['javascript:alert(document.domain)', 'data:text/html,<script>alert(1)</script>', '//untrusted.invalid/path'])('fences legacy/direct database post and target links: %s', async unsafeUrl => {
    state.db.seed('social_posts', [{ id: RECEIPT, family_id: FAMILY, title: 'Legacy post', body: 'Legacy content', kind: 'link',
      link: unsafeUrl, status: 'published', approval_status: 'not_required', metadata: {}, deleted_at: null }]);
    state.db.seed('social_post_targets', [{ id: OTHER_ACCOUNT, post_id: RECEIPT, family_id: FAMILY, platform: 'x',
      status: 'published', permalink_url: unsafeUrl, metadata: {} }]);
    const html = renderToStaticMarkup(await PostPage({ params: Promise.resolve({ id: RECEIPT }) }));
    expect(html).not.toMatch(/href="(?:javascript:|data:|\/\/)/i);
    expect(html).toContain('Legacy content');
  });
  it('preserves valid post and provider links when rendering stored content', async () => {
    state.db.seed('social_posts', [{ id: RECEIPT, family_id: FAMILY, title: 'Legacy post', body: 'Legacy content', kind: 'link',
      link: 'https://example.invalid/story', status: 'published', approval_status: 'not_required', metadata: {}, deleted_at: null }]);
    state.db.seed('social_post_targets', [{ id: OTHER_ACCOUNT, post_id: RECEIPT, family_id: FAMILY, platform: 'x',
      status: 'published', permalink_url: 'https://x.com/i/web/status/12345', metadata: {} }]);
    const html = renderToStaticMarkup(await PostPage({ params: Promise.resolve({ id: RECEIPT }) }));
    expect(html).toContain('href="https://example.invalid/story"');
    expect(html).toContain('href="https://x.com/i/web/status/12345"');
  });
});
