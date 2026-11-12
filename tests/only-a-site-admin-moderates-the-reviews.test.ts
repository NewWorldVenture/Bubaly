// The review-moderation console's server actions (app/(app)/admin/marketing/reviews/actions.ts),
// called as every kind of caller with valid input.
//
// THE POLICY. Approving, featuring, replying to and deleting a review decides what
// the public site shows about the product, so it is a site-admin control. Each
// action opens with requireMarketingAdmin (lib/marketing/admin.ts:82-93): signed
// out 401; anyone off the super-admin allowlist 403, a household's parent included
// (lib/marketing/admin.ts:74-79); a super admin owing a two-step code 403.
// moderateReviewAction drops an unknown status before the gate
// (app/(app)/admin/marketing/reviews/actions.ts:18), so every call here passes a
// valid one.
//
// A review row carries the author's family_id (supabase/migrations/0041_reviews.sql:32),
// but moderation is site-wide: the admin acts on any household's review, and no
// household member may moderate one — not even the review their own family
// wrote. So the "other family" question is answered by a parent of household A
// being refused on household A's own review, and an admin's action on B's review
// leaving A's untouched.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FAMILY_A, FAMILY_B, newAdminWorld, REFUSED_CALLERS, signInAs, snapshot, SUPER_ADMIN } from './helpers/admin-callers';
import type { InMemorySupabase } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/server', async (importOriginal) =>
  (await import('./helpers/admin-callers')).supabaseServerModule(await importOriginal()));
vi.mock('next/cache', () => ({ revalidatePath: h.revalidatePath, revalidateTag: vi.fn() }));

const actions = await import('@/app/(app)/admin/marketing/reviews/actions');

const IDS = {
  moderate: 'ACTION-CC165F41AE00',
  reply: 'ACTION-4CD0228A0979',
  remove: 'ACTION-05FB23BEB1BC',
  settings: 'ACTION-5BDD312CA8E2',
} as const;
const REVIEW_A = 'e0000000-0000-4000-8000-00000000000a';
const REVIEW_B = 'e0000000-0000-4000-8000-00000000000b';

let db: InMemorySupabase;

beforeEach(() => {
  h.revalidatePath.mockReset();
  db = newAdminWorld();
  db.seed('reviews', [
    { id: REVIEW_A, rating: 5, title: 'Love it', body: 'Great app', author_email: 'parent.a@example.com', status: 'pending', family_id: FAMILY_A, deleted_at: null, reply: null },
    { id: REVIEW_B, rating: 2, title: 'Meh', body: 'Slow', author_email: 'parent.b@example.com', status: 'pending', family_id: FAMILY_B, deleted_at: null, reply: null },
  ]);
  db.seed('reputation_settings', [{ singleton: true, google_url: null, min_public_rating: 4 }]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

const audit = () => db.table('marketing_audit_logs').map((r) => [r.action, r.resource, r.resource_id ?? null, r.actor_id]);
const review = (id: string) => db.table('reviews').find((r) => r.id === id);
const fd = (fields: Record<string, string>) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return form;
};

const CALLS: [string, () => Promise<unknown>][] = [
  [IDS.moderate, () => actions.moderateReviewAction(REVIEW_A, 'featured')],
  [IDS.reply, () => actions.replyToReviewAction(fd({ id: REVIEW_A, reply: 'Thank you!' }))],
  [IDS.remove, () => actions.deleteReviewAction(REVIEW_A)],
  [IDS.settings, () => actions.saveReputationSettingsAction(fd({ google_url: 'https://g.example.com/review', min_public_rating: '3' }))],
];

describe("every review action refuses anyone but a site admin, even on the caller's own family's review", () => {
  const matrix = CALLS.flatMap(([id, call]) => REFUSED_CALLERS.map((c) => ({ id, call, ...c })));
  it.each(matrix)('$id $label is refused and nothing is written', async ({ call, caller, status }) => {
    signInAs(caller);
    const before = snapshot(db);
    await expect(call()).rejects.toMatchObject({ name: 'MarketingAuthError', status });
    expect(snapshot(db)).toEqual(before);
    expect(h.revalidatePath).not.toHaveBeenCalled();
  });
});

describe('a site admin', () => {
  beforeEach(() => signInAs({ kind: 'super_admin' }));

  it(`${IDS.moderate} features household B's review and leaves household A's pending`, async () => {
    await actions.moderateReviewAction(REVIEW_B, 'featured');
    expect(review(REVIEW_B)).toMatchObject({ status: 'featured' });
    expect(review(REVIEW_A)).toMatchObject({ status: 'pending' });
    expect(audit()).toEqual([['update', 'review', REVIEW_B, SUPER_ADMIN.id]]);
  });

  it(`${IDS.reply} replies to the named review only, signed by the admin`, async () => {
    await actions.replyToReviewAction(fd({ id: REVIEW_A, reply: 'Thank you!' }));
    expect(review(REVIEW_A)).toMatchObject({ reply: 'Thank you!', replied_by: SUPER_ADMIN.id, replied_at: expect.any(String) });
    expect(review(REVIEW_B)).toMatchObject({ reply: null });
    expect(audit()).toEqual([['reply', 'review', REVIEW_A, SUPER_ADMIN.id]]);
  });

  it(`${IDS.remove} soft-deletes the named review only, and a second delete finds nothing`, async () => {
    await actions.deleteReviewAction(REVIEW_A);
    expect(review(REVIEW_A)?.deleted_at).toEqual(expect.any(String));
    expect(review(REVIEW_B)?.deleted_at).toBeNull();
    expect(audit()).toEqual([['delete', 'review', REVIEW_A, SUPER_ADMIN.id]]);
    const before = snapshot(db);
    await expect(actions.deleteReviewAction(REVIEW_A)).rejects.toThrow();
    expect(snapshot(db)).toEqual(before);
  });

  it(`${IDS.settings} saves the reputation settings over the one singleton row`, async () => {
    await actions.saveReputationSettingsAction(fd({ google_url: 'https://g.example.com/review', min_public_rating: '3' }));
    expect(db.table('reputation_settings')).toEqual([expect.objectContaining({
      singleton: true, google_url: 'https://g.example.com/review', trustpilot_url: null, min_public_rating: 3,
      auto_approve_min: null, updated_by: SUPER_ADMIN.id,
    })]);
    expect(audit()).toEqual([['update', 'reputation_settings', null, SUPER_ADMIN.id]]);
  });
});
