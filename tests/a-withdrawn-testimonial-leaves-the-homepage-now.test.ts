// Admin reach N4 (with its duplicate N11) and N5 (with its duplicate N10) —
// the homepage's testimonials.
//
// N4: the published-testimonials read is an unstable_cache entry populated
// while the homepage renders, kept for an hour, and it carried NO tag. The
// three testimonial actions called only revalidatePath('/admin/marketing/
// reputation'), which does not reach that entry, so a quote unpublished or
// deleted because its author withdrew permission, or a misattribution
// corrected, stayed on bubaly.com under "Shared with permission" for up to an
// hour. Case studies had a tag; testimonials did not.
//
// N5: the rating field is optional, and a blank one was Number('') = 0, which
// clampRating raised to 1 — so every testimonial saved without a rating went
// public as one star out of five under a named person's quote.
//
// Driven through the REAL actions and the REAL public reader against the
// in-memory database. next/cache is modelled the way Next keeps it: an entry
// per key carrying its tags, dropped by revalidateTag for a tag it carries;
// revalidatePath of the admin page reaches nothing the homepage populated.
// Negative controls: before the fix each withdrawal still read the old quote,
// and a blank rating read as 1.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({
  db: null as unknown,
  entries: new Map<string, { value: unknown; tags: string[] }>(),
  requireMarketingAdmin: vi.fn(),
}));

vi.mock('next/cache', () => ({
  unstable_cache: (fn: () => Promise<unknown>, keys: string[], opts?: { tags?: string[] }) => async () => {
    const key = keys.join('|');
    const hit = h.entries.get(key);
    if (hit) return hit.value;
    const value = await fn();
    h.entries.set(key, { value, tags: opts?.tags ?? [] });
    return value;
  },
  revalidateTag: (tag: string) => {
    for (const [key, entry] of h.entries) if (entry.tags.includes(tag)) h.entries.delete(key);
  },
  revalidatePath: () => {},
}));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db }));
vi.mock('@/lib/marketing/admin', () => ({
  requireMarketingAdmin: h.requireMarketingAdmin,
  logMarketingAudit: vi.fn(async () => undefined),
  marketingActionFailure: (operation: string) => { throw new Error(`Could not ${operation}.`); },
}));

const { getPublishedTestimonials } = await import('@/lib/marketing/reputation-server');
const { saveTestimonialAction, togglePublishTestimonialAction, deleteTestimonialAction } = await import('@/app/(app)/admin/marketing/reputation/actions');

let db: InMemorySupabase;
const quote = {
  id: 'quote-1', author_name: 'Synthetic Parent', author_role: 'Parent of two', company: null,
  quote: 'Our week finally fits on one screen.', rating: 5, is_published: true, sort_order: 1,
};
function form(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.set(key, value);
  return fd;
}
const shown = async () => (await getPublishedTestimonials()).map((t) => ({ id: t.id, quote: t.quote, rating: t.rating }));

beforeEach(() => {
  h.entries.clear();
  db = createInMemorySupabase({ defaults: { testimonials: { sort_order: 0 } } });
  h.db = db;
  db.seed('testimonials', [quote]);
  h.requireMarketingAdmin.mockReset().mockResolvedValue({ supabase: db, actorId: 'admin-1', actorEmail: 'admin@example.test' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('a withdrawn testimonial leaves the homepage at once', () => {
  it('an unpublished quote is gone from the next homepage read', async () => {
    expect(await shown()).toEqual([{ id: 'quote-1', quote: quote.quote, rating: 5 }]);
    await togglePublishTestimonialAction('quote-1', false);
    expect(await shown()).toEqual([]);
  });

  it('a deleted quote is gone from the next homepage read', async () => {
    expect(await shown()).toHaveLength(1);
    await deleteTestimonialAction('quote-1');
    expect(await shown()).toEqual([]);
  });

  it('a corrected quote replaces the old one on the next homepage read', async () => {
    expect(await shown()).toHaveLength(1);
    await saveTestimonialAction(form({ id: 'quote-1', author_name: 'Synthetic Parent', quote: 'Corrected wording.', rating: '5', is_published: 'on' }));
    expect(await shown()).toEqual([{ id: 'quote-1', quote: 'Corrected wording.', rating: 5 }]);
  });

  it('the control: with no admin write the cached list is served without a second read', async () => {
    expect(await shown()).toHaveLength(1);
    db.table('testimonials')[0].quote = 'Changed behind the cache';
    expect(await shown()).toEqual([{ id: 'quote-1', quote: quote.quote, rating: 5 }]);
  });
});

describe('a testimonial saved with no rating has no stars', () => {
  it.each([['', null], ['   ', null], ['4', 4], ['5', 5]])('rating %j is stored and shown as %j', async (rating, expected) => {
    db.replace('testimonials', []);
    await saveTestimonialAction(form({ author_name: 'Synthetic Parent', quote: 'Kind words.', rating, is_published: 'on' }));
    expect(db.table('testimonials')[0].rating).toBe(expected);
    expect((await shown())[0].rating).toBe(expected);
  });
});
