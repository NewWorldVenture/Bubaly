// The marketing Asset Library's three server actions
// (app/(app)/admin/marketing/assets/actions.ts), called as every kind of caller
// with valid input.
//
// THE POLICY. The library is a site-admin tool: each action opens with
// requireMarketingAdmin (lib/marketing/admin.ts:76-87), which refuses a
// signed-out caller (401), anyone who is not a super admin (403) and a super
// admin who still owes their two-step code (403). A household's roles grant
// nothing here — a family's parent is not a platform admin
// (lib/constants/roles.ts manages one household, not the site). The library's
// rows and bucket objects are site-wide, not family data, so there is no
// "other family" id to reach.
//
// WHAT IS ASSERTED: a super admin's upload stores the object and the row it
// promises, an edit changes exactly the editable fields, a delete removes the
// object and soft-deletes the row, each with one audit row; every other caller
// is refused by the gate and both households, the library and the bucket are
// exactly as they were.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { newAdminWorld, REFUSED_CALLERS, signInAs, snapshot, SUPER_ADMIN } from './helpers/admin-callers';
import type { InMemorySupabase } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/server', async (importOriginal) =>
  (await import('./helpers/admin-callers')).supabaseServerModule(await importOriginal()));
vi.mock('next/cache', () => ({ revalidatePath: h.revalidatePath, revalidateTag: vi.fn() }));

const { uploadAssetAction, updateAssetAction, deleteAssetAction } = await import('@/app/(app)/admin/marketing/assets/actions');

const UPLOAD = 'ACTION-578FDE4E7B8A';
const UPDATE = 'ACTION-71630153BB4B';
const DELETE = 'ACTION-4A2066895C0E';

const ASSET_ID = 'c0000000-0000-4000-8000-0000000000a1';
const ASSET_PATH = `image/${ASSET_ID}-logo.png`;
const BUCKET = 'marketing-assets';

let db: InMemorySupabase;

beforeEach(() => {
  h.revalidatePath.mockReset();
  db = newAdminWorld();
  db.seed('marketing_assets', [{
    id: ASSET_ID, name: 'Logo', kind: 'image', storage_path: ASSET_PATH, mime_type: 'image/png', size_bytes: 3,
    alt_text: 'Old alt', tags: ['old'], content_hash: 'seeded-hash', license: 'original', source_url: null,
    attribution: null, created_by: SUPER_ADMIN.id, deleted_at: null,
  }]);
  db.table('storage.objects').push({ bucket_id: BUCKET, name: ASSET_PATH, size: 3, content_type: 'image/png' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

function uploadForm(): FormData {
  const fd = new FormData();
  fd.set('file', new File([new Uint8Array([1, 2, 3, 4, 5])], 'hero.png', { type: 'image/png' }));
  fd.set('name', 'Hero image');
  fd.set('alt_text', 'A family at breakfast');
  fd.set('tags', 'Home, Hero');
  return fd;
}

function updateForm(id: string): FormData {
  const fd = new FormData();
  fd.set('id', id);
  fd.set('name', 'Logo (dark)');
  fd.set('alt_text', 'The logo on dark');
  fd.set('tags', 'brand');
  fd.set('license', 'licensed');
  return fd;
}

describe(`${UPLOAD} uploadAssetAction`, () => {
  it(`${UPLOAD} a super admin's upload stores the file and one library row that names it`, async () => {
    signInAs({ kind: 'super_admin' });
    await uploadAssetAction(uploadForm());

    const rows = db.table('marketing_assets').filter((row) => row.id !== ASSET_ID);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row).toMatchObject({
      name: 'Hero image', kind: 'image', mime_type: 'image/png', size_bytes: 5, alt_text: 'A family at breakfast',
      tags: ['home', 'hero'], license: 'original', created_by: SUPER_ADMIN.id,
    });
    expect(row.storage_path).toBe(`image/${String(row.id)}-hero.png`);
    expect(db.table('storage.objects').map((o) => [o.bucket_id, o.name])).toEqual([
      [BUCKET, ASSET_PATH],
      [BUCKET, row.storage_path],
    ]);
    expect(db.table('marketing_audit_logs').map((a) => [a.action, a.actor_id, a.resource, a.resource_id])).toEqual([
      ['create', SUPER_ADMIN.id, 'marketing_asset', row.id],
    ]);
    expect(h.revalidatePath).toHaveBeenCalledWith('/admin/marketing/assets');
  });

  it.each(REFUSED_CALLERS)(`${UPLOAD} $label is refused and nothing is stored`, async ({ caller, status }) => {
    signInAs(caller);
    const before = snapshot(db);
    await expect(uploadAssetAction(uploadForm())).rejects.toMatchObject({ name: 'MarketingAuthError', status });
    expect(snapshot(db)).toEqual(before);
    expect(db.table('storage.objects')).toHaveLength(1);
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });
});

describe(`${UPDATE} updateAssetAction`, () => {
  it(`${UPDATE} a super admin's edit changes the editable fields and keeps the file`, async () => {
    signInAs({ kind: 'super_admin' });
    await updateAssetAction(updateForm(ASSET_ID));
    expect(db.table('marketing_assets')).toEqual([expect.objectContaining({
      id: ASSET_ID, name: 'Logo (dark)', alt_text: 'The logo on dark', tags: ['brand'], license: 'licensed',
      storage_path: ASSET_PATH, content_hash: 'seeded-hash', deleted_at: null,
    })]);
    expect(db.table('storage.objects').map((o) => o.name)).toEqual([ASSET_PATH]);
    expect(db.table('marketing_audit_logs').map((a) => [a.action, a.actor_id, a.resource_id])).toEqual([
      ['update', SUPER_ADMIN.id, ASSET_ID],
    ]);
  });

  it.each(REFUSED_CALLERS)(`${UPDATE} $label is refused and the asset is unchanged`, async ({ caller, status }) => {
    signInAs(caller);
    const before = snapshot(db);
    await expect(updateAssetAction(updateForm(ASSET_ID))).rejects.toMatchObject({ name: 'MarketingAuthError', status });
    expect(snapshot(db)).toEqual(before);
    expect(db.table('marketing_assets')[0].name).toBe('Logo');
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });
});

describe(`${DELETE} deleteAssetAction`, () => {
  it(`${DELETE} a super admin's delete removes the file and soft-deletes the row`, async () => {
    signInAs({ kind: 'super_admin' });
    await deleteAssetAction(ASSET_ID, ASSET_PATH);
    expect(db.table('marketing_assets')).toEqual([expect.objectContaining({ id: ASSET_ID, deleted_at: expect.any(String) })]);
    expect(db.table('storage.objects')).toEqual([]);
    expect(db.table('marketing_audit_logs').map((a) => [a.action, a.actor_id, a.resource_id])).toEqual([
      ['delete', SUPER_ADMIN.id, ASSET_ID],
    ]);
  });

  it.each(REFUSED_CALLERS)(`${DELETE} $label is refused and the file and row stay`, async ({ caller, status }) => {
    signInAs(caller);
    const before = snapshot(db);
    await expect(deleteAssetAction(ASSET_ID, ASSET_PATH)).rejects.toMatchObject({ name: 'MarketingAuthError', status });
    expect(snapshot(db)).toEqual(before);
    expect(db.table('storage.objects').map((o) => o.name)).toEqual([ASSET_PATH]);
    expect(db.table('marketing_assets')[0].deleted_at).toBeNull();
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });
});
