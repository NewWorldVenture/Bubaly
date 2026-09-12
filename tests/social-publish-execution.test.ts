import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ConnectorPublishOutput } from '@/lib/social/connectors';
import { InMemorySupabase } from './helpers/in-memory-supabase';

const { publish } = vi.hoisted(() => ({ publish: vi.fn() }));
vi.mock('@/lib/social/connectors', () => ({ getConnector: () => ({ publish }) }));
// This direct pipeline fixture has no request session; approval reads still run.
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: () => { throw new Error('Unexpected request actor lookup'); } }));
import { runPublishNow } from '@/lib/social/publish';

const confirmed: ConnectorPublishOutput = { ok: true, status: 'published', providerObjectId: 'external-1', permalinkUrl: 'https://x.com/user/status/1' };
const rejected: ConnectorPublishOutput = { ok: false, status: 'failed', errorCode: 'rejected', errorMessage: 'Rejected' };
const fid = 'family-a';
const pid = 'post-a';
const actor = 'user-a';

function fixture(status = 'draft') {
  const db = new InMemorySupabase();
  db.seed('social_posts', [{ id: pid, family_id: fid, body: 'Hello', kind: 'text', link: null, status, approval_status: 'not_required', published_at: null, metadata: { retained: true }, deleted_at: null }]);
  db.seed('social_accounts', [{ id: 'account-a', family_id: fid, platform: 'x', provider_account_id: 'external-account', deleted_at: null }]);
  db.seed('social_post_targets', [{ id: 'target-a', post_id: pid, family_id: fid, account_id: 'account-a', platform: 'x', status: 'pending', metadata: { retained: true }, published_at: null }]);
  return db;
}

function run(db: InMemorySupabase, familyId = fid) {
  return runPublishNow(db as unknown as SupabaseClient<Database>, familyId, pid, actor);
}

/** Inject failures at the actual fluent query boundary, retaining stateful writes. */
function intercept(db: InMemorySupabase, shouldFail: (table: string, operation: string, patch: Record<string, unknown>) => boolean, throws = false) {
  const from = db.from.bind(db);
  vi.spyOn(db, 'from').mockImplementation((table) => {
    const query = from(table);
    let operation = 'select';
    let patch: Record<string, unknown> = {};
    const wrap = new Proxy(query, {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          if (['insert', 'update', 'delete'].includes(String(key))) {
            operation = String(key);
            patch = (args[0] ?? {}) as Record<string, unknown>;
          }
          if (['single', 'maybeSingle', 'then'].includes(String(key)) && shouldFail(table, operation, patch)) {
            const failure = throws ? Promise.reject(new Error('transport fixture failure'))
              : Promise.resolve({ data: null, error: { code: '42501', message: 'fixture denied' } });
            return key === 'then' ? failure.then(args[0] as never, args[1] as never) : failure;
          }
          const result: unknown = Reflect.apply(value, target, args);
          return result === target ? wrap : result;
        };
      },
    });
    return wrap;
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  publish.mockReset().mockResolvedValue(confirmed);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('social publishing execution and durable claims', () => {
  it('sends once when two callers concurrently publish the same target', async () => {
    const db = fixture();
    const results = await Promise.allSettled([run(db), run(db)]);
    expect(results.some((result) => result.status === 'fulfilled')).toBe(true);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(db.table('social_publish_results')).toHaveLength(1);
    expect(db.table('social_posts')[0].status).toBe('published');
    expect(db.table('social_post_targets')[0].metadata).toMatchObject({ retained: true });
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ familyId: fid, accountId: 'account-a', userId: actor, kind: 'text' }));
  });

  it('includes an earlier success when a retried target fails and retains its publication date', async () => {
    const db = fixture('partially_published');
    const earlier = '2026-01-01T00:00:00.000Z';
    db.table('social_posts')[0].published_at = earlier;
    db.table('social_post_targets')[0].status = 'failed';
    db.seed('social_post_targets', [{ id: 'target-b', post_id: pid, family_id: fid, platform: 'x', account_id: 'account-b', status: 'published', provider_object_id: 'prior', published_at: earlier }]);
    publish.mockResolvedValue(rejected);
    expect((await run(db)).status).toBe('partially_published');
    expect(db.table('social_posts')[0].published_at).toBe(earlier);
    expect(db.table('social_post_targets')[1].provider_object_id).toBe('prior');
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it.each(['skipped', 'canceled'])('does not claim complete publication when another target is %s', async (status) => {
    const db = fixture();
    db.seed('social_post_targets', [{ id: 'target-b', post_id: pid, family_id: fid, platform: 'x', status }]);
    expect((await run(db)).status).toBe('partially_published');
  });

  it.each(['published', 'publishing'])('makes a repeated %s invocation read-only', async (status) => {
    const db = fixture(status);
    db.table('social_post_targets')[0].status = status;
    const before = structuredClone(db.table('social_posts'));
    expect((await run(db)).status).toBe(status);
    expect(publish).not.toHaveBeenCalled();
    expect(db.table('social_publish_jobs')).toHaveLength(0);
    expect(db.table('social_posts')).toEqual(before);
  });

  it('does not mutate a failed post with no remaining eligible targets', async () => {
    const db = fixture('failed');
    db.replace('social_post_targets', []);
    expect((await run(db)).status).toBe('failed');
    expect(db.table('social_posts')[0].status).toBe('failed');
    expect(publish).not.toHaveBeenCalled();
  });

  it('reports incomplete targets honestly when the stored parent incorrectly says published', async () => {
    const db = fixture('published');
    expect((await run(db)).status).toBe('publishing');
    expect(publish).not.toHaveBeenCalled();
    expect(db.table('social_publish_jobs')).toHaveLength(0);
    expect(db.table('social_posts')[0].status).toBe('published');
  });

  it.each([
    { ok: false, status: 'publishing', errorCode: 'confirmation_unknown' },
    { ok: true, status: 'published' },
    { ok: false, status: 'published', providerObjectId: 'possible' },
    { ok: true, status: 'failed', providerObjectId: 'possible' },
    { ok: false, status: 'failed', providerObjectId: 'possible' },
  ])('holds an unconfirmed or contradictory result for review: %j', async (result) => {
    const db = fixture();
    publish.mockResolvedValue(result);
    expect((await run(db)).status).toBe('publishing');
    expect((await run(db)).status).toBe('publishing');
    expect(publish).toHaveBeenCalledTimes(1);
    expect(db.table('social_publish_results')[0]).toMatchObject({ status: 'publishing', error_code: 'confirmation_unknown' });
    expect(db.table('social_publish_jobs')[0].status).toBe('running');
  });

  it('does not retry a thrown connector after possible provider acceptance', async () => {
    const db = fixture();
    publish.mockRejectedValue(new Error('connection lost'));
    expect((await run(db)).status).toBe('publishing');
    await run(db);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('retains claims if result persistence fails (throws=%s)', async (throws) => {
    const db = fixture();
    intercept(db, (table, op) => table === 'social_publish_results' && op === 'insert', throws);
    await expect(run(db)).rejects.toThrow('Review the post status');
    expect(db.table('social_posts')[0].status).toBe('publishing');
    expect(db.table('social_post_targets')[0].status).toBe('publishing');
    await run(db);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('keeps the confirmed receipt and claim if the target completion write fails', async () => {
    const db = fixture();
    intercept(db, (table, op, patch) => table === 'social_post_targets' && op === 'update' && patch.status === 'published');
    await expect(run(db)).rejects.toThrow('Review the post status');
    expect(db.table('social_publish_results')[0]).toMatchObject({ status: 'published', provider_object_id: 'external-1' });
    await run(db);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it.each(['social_posts', 'social_post_targets', 'social_post_variants', 'social_accounts'])('fails before claims and provider calls when %s is unavailable', async (failedTable) => {
    const db = fixture();
    intercept(db, (table, op) => table === failedTable && op === 'select');
    await expect(run(db)).rejects.toThrow('Review the post status');
    expect(publish).not.toHaveBeenCalled();
    expect(db.table('social_posts')[0].status).toBe('draft');
    expect(db.table('social_publish_jobs')).toHaveLength(0);
  });

  it('rejects another family and soft-deleted posts without a provider call', async () => {
    const db = fixture();
    await expect(run(db, 'family-b')).rejects.toThrow();
    db.table('social_posts')[0].deleted_at = new Date().toISOString();
    await expect(run(db)).rejects.toThrow();
    expect(publish).not.toHaveBeenCalled();
  });

  it('holds a target whose claim was replaced instead of overwriting its outcome', async () => {
    const db = fixture();
    publish.mockImplementation(async () => {
      db.table('social_post_targets')[0].metadata = { publish_job_id: 'other-job' };
      return confirmed;
    });
    await expect(run(db)).rejects.toThrow('Review the post status');
    expect(db.table('social_post_targets')[0].status).toBe('publishing');
    expect(db.table('social_publish_results')).toHaveLength(1);
  });

  it('checks target claims against concurrent cancellation before any send', async () => {
    const db = fixture();
    const from = db.from.bind(db);
    vi.spyOn(db, 'from').mockImplementation((table) => {
      if (table === 'social_publish_jobs') db.table('social_post_targets')[0].status = 'canceled';
      return from(table);
    });
    await expect(run(db)).rejects.toThrow();
    expect(publish).not.toHaveBeenCalled();
    expect(db.table('social_post_targets')[0].status).toBe('canceled');
  });

  it('rejects duplicate accounts and a failed target carrying a provider confirmation', async () => {
    const db = fixture();
    db.seed('social_post_targets', [{ ...db.table('social_post_targets')[0], id: 'duplicate' }]);
    await expect(run(db)).rejects.toThrow();
    db.table('social_post_targets').pop();
    db.table('social_post_targets')[0].status = 'failed';
    db.table('social_post_targets')[0].provider_object_id = 'already-external';
    await expect(run(db)).rejects.toThrow();
    expect(publish).not.toHaveBeenCalled();
  });

  it('does not resend an account already published under another target row', async () => {
    const db = fixture('partially_published');
    db.table('social_post_targets')[0].status = 'failed';
    db.seed('social_post_targets', [{ ...db.table('social_post_targets')[0], id: 'prior', status: 'published', provider_object_id: 'known-post' }]);
    await expect(run(db)).rejects.toThrow();
    expect(publish).not.toHaveBeenCalled();
    expect(db.table('social_posts')[0].status).toBe('partially_published');
  });

  it('reads all target and variant pages even under a one-row API cap', async () => {
    const db = fixture();
    db.seed('social_post_targets', [{ id: 'target-b', post_id: pid, family_id: fid, platform: 'x', status: 'published', provider_object_id: 'prior', published_at: '2026-01-01T00:00:00.000Z' }]);
    db.seed('social_post_variants', [
      { id: 'variant-a', family_id: fid, post_id: pid, platform: 'reddit', body: 'Other' },
      { id: 'variant-b', family_id: fid, post_id: pid, platform: 'x', body: 'Chosen variant' },
    ]);
    const from = db.from.bind(db);
    vi.spyOn(db, 'from').mockImplementation((table) => {
      const query = from(table);
      if (['social_post_targets', 'social_post_variants'].includes(table)) {
        const limit = query.limit.bind(query);
        query.limit = () => limit(1);
      }
      return query;
    });
    publish.mockResolvedValue(rejected);
    expect((await run(db)).status).toBe('partially_published');
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ body: 'Chosen variant' }));
  });

  it('fails before sending when target volume exceeds the safety bound', async () => {
    const db = fixture();
    db.seed('social_post_targets', Array.from({ length: 2000 }, (_, i) => ({
      id: `target-${String(i).padStart(4, '0')}`, post_id: pid, family_id: fid,
      platform: 'x', status: 'published', provider_object_id: String(i),
    })));
    await expect(run(db)).rejects.toThrow();
    expect(publish).not.toHaveBeenCalled();
    expect(db.table('social_publish_jobs')).toHaveLength(0);
  });
});
