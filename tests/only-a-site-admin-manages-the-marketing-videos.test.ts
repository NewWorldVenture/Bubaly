// The marketing video library's three server actions
// (app/(app)/admin/marketing/video/actions.ts), called as every kind of caller
// with valid input.
//
// THE POLICY. Videos are published to the public site, and managing them is a
// site-admin tool: each action opens with requireMarketingAdmin
// (lib/marketing/admin.ts:76-87), which refuses a signed-out caller (401),
// anyone who is not a super admin (403) and a super admin who still owes their
// two-step code (403). No household role is a platform admin. marketing_videos
// and marketing_assets are site-wide, not family data, so there is no "other
// family" id to reach.
//
// WHAT IS ASSERTED: a super admin's save creates (from a YouTube URL) or
// updates (from an uploaded video asset) exactly the row it promises, a toggle
// flips the status, a delete soft-deletes, each with one audit row; every other
// caller is refused by the gate and nothing anywhere changes.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { newAdminWorld, REFUSED_CALLERS, signInAs, snapshot, SUPER_ADMIN } from './helpers/admin-callers';
import type { InMemorySupabase } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/server', async (importOriginal) =>
  (await import('./helpers/admin-callers')).supabaseServerModule(await importOriginal()));
vi.mock('next/cache', () => ({ revalidatePath: h.revalidatePath, revalidateTag: vi.fn() }));

const { saveVideoAction, toggleVideoPublishAction, deleteVideoAction } = await import('@/app/(app)/admin/marketing/video/actions');

const SAVE = 'ACTION-74941DD5D790';
const TOGGLE = 'ACTION-6860916259AA';
const DELETE = 'ACTION-7F1AA5436C30';

const VIDEO_ID = 'c0000000-0000-4000-8000-0000000000b1';
const ASSET_ID = 'c0000000-0000-4000-8000-0000000000b2';
const YOUTUBE = 'https://www.youtube.com/watch?v=abcdefghijk';

let db: InMemorySupabase;

beforeEach(() => {
  h.revalidatePath.mockReset();
  db = newAdminWorld();
  db.seed('marketing_videos', [{
    id: VIDEO_ID, title: 'Old tour', provider: 'youtube', video_id: 'zyxwvutsrqp', url: 'https://youtu.be/zyxwvutsrqp',
    storage_path: null, status: 'draft', tags: [], source_hash: 'old-hash', license: 'embedded_source', deleted_at: null,
  }]);
  db.seed('marketing_assets', [{
    id: ASSET_ID, name: 'Tour clip', kind: 'video', storage_path: `video/${ASSET_ID}-tour.mp4`, content_hash: 'clip-hash',
    license: 'original', source_url: null, attribution: 'Studio', deleted_at: null,
  }]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

function createForm(): FormData {
  const fd = new FormData();
  fd.set('title', 'Product tour');
  fd.set('url', YOUTUBE);
  fd.set('status', 'published');
  fd.set('tags', 'tour');
  return fd;
}

function updateFromAssetForm(): FormData {
  const fd = new FormData();
  fd.set('id', VIDEO_ID);
  fd.set('title', 'Tour (uploaded)');
  fd.set('asset_id', ASSET_ID);
  return fd;
}

describe(`${SAVE} saveVideoAction`, () => {
  it(`${SAVE} a super admin creates a video from a YouTube URL`, async () => {
    signInAs({ kind: 'super_admin' });
    await saveVideoAction(createForm());
    const created = db.table('marketing_videos').filter((row) => row.id !== VIDEO_ID);
    expect(created).toEqual([expect.objectContaining({
      title: 'Product tour', provider: 'youtube', video_id: 'abcdefghijk', url: YOUTUBE, storage_path: null,
      status: 'published', tags: ['tour'], license: 'embedded_source', created_by: SUPER_ADMIN.id,
    })]);
    expect(db.table('marketing_audit_logs').map((a) => [a.action, a.actor_id, a.resource_id])).toEqual([
      ['create', SUPER_ADMIN.id, created[0].id],
    ]);
    expect(h.revalidatePath).toHaveBeenCalledWith('/admin/marketing/video');
  });

  it(`${SAVE} a super admin re-points a video at an uploaded asset`, async () => {
    signInAs({ kind: 'super_admin' });
    await saveVideoAction(updateFromAssetForm());
    expect(db.table('marketing_videos')).toEqual([expect.objectContaining({
      id: VIDEO_ID, title: 'Tour (uploaded)', provider: 'upload', video_id: null, url: null,
      storage_path: `video/${ASSET_ID}-tour.mp4`, source_hash: 'clip-hash', license: 'original', attribution: 'Studio',
      status: 'draft',
    })]);
    expect(db.table('marketing_audit_logs').map((a) => [a.action, a.resource_id])).toEqual([['update', VIDEO_ID]]);
  });

  it.each(REFUSED_CALLERS)(`${SAVE} $label is refused, creating or updating nothing`, async ({ caller, status }) => {
    signInAs(caller);
    const before = snapshot(db);
    await expect(saveVideoAction(createForm())).rejects.toMatchObject({ name: 'MarketingAuthError', status });
    await expect(saveVideoAction(updateFromAssetForm())).rejects.toMatchObject({ name: 'MarketingAuthError', status });
    expect(snapshot(db)).toEqual(before);
    expect(db.table('marketing_videos')).toHaveLength(1);
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });
});

describe(`${TOGGLE} toggleVideoPublishAction`, () => {
  it(`${TOGGLE} a super admin publishes and unpublishes a video`, async () => {
    signInAs({ kind: 'super_admin' });
    await toggleVideoPublishAction(VIDEO_ID, true);
    expect(db.table('marketing_videos')[0].status).toBe('published');
    await toggleVideoPublishAction(VIDEO_ID, false);
    expect(db.table('marketing_videos')[0].status).toBe('draft');
    expect(db.table('marketing_audit_logs').map((a) => [a.action, a.actor_id, a.metadata])).toEqual([
      ['update', SUPER_ADMIN.id, { status: 'published' }],
      ['update', SUPER_ADMIN.id, { status: 'draft' }],
    ]);
  });

  it.each(REFUSED_CALLERS)(`${TOGGLE} $label is refused and the video stays a draft`, async ({ caller, status }) => {
    signInAs(caller);
    const before = snapshot(db);
    await expect(toggleVideoPublishAction(VIDEO_ID, true)).rejects.toMatchObject({ name: 'MarketingAuthError', status });
    expect(snapshot(db)).toEqual(before);
    expect(db.table('marketing_videos')[0].status).toBe('draft');
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });
});

describe(`${DELETE} deleteVideoAction`, () => {
  it(`${DELETE} a super admin soft-deletes a video and the asset stays in the library`, async () => {
    signInAs({ kind: 'super_admin' });
    await deleteVideoAction(VIDEO_ID);
    expect(db.table('marketing_videos')).toEqual([expect.objectContaining({ id: VIDEO_ID, deleted_at: expect.any(String) })]);
    expect(db.table('marketing_assets')).toEqual([expect.objectContaining({ id: ASSET_ID, deleted_at: null })]);
    expect(db.table('marketing_audit_logs').map((a) => [a.action, a.actor_id, a.resource_id])).toEqual([
      ['delete', SUPER_ADMIN.id, VIDEO_ID],
    ]);
  });

  it.each(REFUSED_CALLERS)(`${DELETE} $label is refused and the video stays`, async ({ caller, status }) => {
    signInAs(caller);
    const before = snapshot(db);
    await expect(deleteVideoAction(VIDEO_ID)).rejects.toMatchObject({ name: 'MarketingAuthError', status });
    expect(snapshot(db)).toEqual(before);
    expect(db.table('marketing_videos')[0].deleted_at).toBeNull();
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });
});
