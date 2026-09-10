import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { revalidateTag } from 'next/cache';
import { CASE_STUDIES_CACHE_TAG } from '@/lib/marketing/case-study';

const admin = vi.hoisted(() => ({ requireMarketingAdmin: vi.fn(), logMarketingAudit: vi.fn() }));
vi.mock('@/lib/marketing/admin', () => ({ ...admin, marketingActionFailure: (message: string) => { throw new Error(message); } }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
const { saveCaseStudyAction, deleteCaseStudyAction } = await import('@/app/(app)/admin/marketing/reputation/actions');
let db: ReturnType<typeof createInMemorySupabase>;
const form = (fields: Record<string, string>) => {
  const value = new FormData();
  for (const [key, item] of Object.entries(fields)) value.set(key, item);
  return value;
};
beforeEach(() => {
  vi.clearAllMocks();
  db = createInMemorySupabase();
  db.seed('case_studies', [{ id: 'story', title: 'Existing story', slug: 'existing-story', body: 'Original account', is_published: false }]);
  admin.requireMarketingAdmin.mockResolvedValue({ supabase: db, actorId: 'admin', actorEmail: 'admin@example.test' });
});

describe('customer story editing', () => {
  it('updates an existing draft body and publication without creating another record', async () => {
    await saveCaseStudyAction(form({ id: 'story', title: 'Updated story', slug: 'existing-story', body: 'Approved full account', is_published: 'on' }));
    expect(db.table('case_studies')).toHaveLength(1);
    expect(db.table('case_studies')[0]).toMatchObject({ id: 'story', body: 'Approved full account', is_published: true });
    expect(admin.logMarketingAudit).toHaveBeenCalledWith(db, expect.objectContaining({ action: 'update', resourceId: 'story' }));
    await saveCaseStudyAction(form({ id: 'story', title: 'Updated story', slug: 'existing-story', body: 'Approved full account' }));
    expect(db.table('case_studies')[0].is_published).toBe(false);
    expect(revalidateTag).toHaveBeenCalledTimes(2);
    expect(revalidateTag).toHaveBeenLastCalledWith(CASE_STUDIES_CACHE_TAG);
  });

  it('preserves a body on older forms that do not submit the field, but allows explicit clearing', async () => {
    await saveCaseStudyAction(form({ id: 'story', title: 'Existing story' }));
    expect(db.table('case_studies')[0].body).toBe('Original account');
    await saveCaseStudyAction(form({ id: 'story', title: 'Existing story', body: '' }));
    expect(db.table('case_studies')[0].body).toBeNull();
  });

  it('retains the admin authorization boundary for publishing', async () => {
    admin.requireMarketingAdmin.mockRejectedValue(new Error('Forbidden'));
    await expect(saveCaseStudyAction(form({ id: 'story', title: 'Existing story', body: 'Changed', is_published: 'on' }))).rejects.toThrow('Forbidden');
    expect(db.table('case_studies')[0]).toMatchObject({ body: 'Original account', is_published: false });
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it('invalidates public cards when a story is deleted', async () => {
    await deleteCaseStudyAction('story');
    expect(db.table('case_studies')).toEqual([]);
    expect(revalidateTag).toHaveBeenCalledWith(CASE_STUDIES_CACHE_TAG);
  });
});
