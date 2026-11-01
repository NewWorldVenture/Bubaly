import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { createElement } from 'react';
import { createInMemorySupabase, withFaults, type FaultCall, type InMemorySupabase } from './helpers/in-memory-supabase';
import { renderServerPage, textOf } from './helpers/render-server-page';

// admin-writers N8. The public /reviews headline — "{average} from {total}
// reviews" — was computed from the 200 cards the page lists, read featured
// first and then newest. Past 200 public reviews the count was pinned at 200,
// and the average was whatever the featured and the newest said: a moderator
// marking reviews featured moved the published rating. The headline is now
// counted over every approved and featured review, per star. The REAL page
// against the in-memory database with PostgREST's 1,000-row cap.

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES: messages } = await import('@/lib/i18n/messages');
  const { translate } = await import('@/lib/i18n/translate');
  return {
    getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(messages, key, params),
    getLocaleContext: async () => ({ locale: { code: 'en-US' }, messages }),
  };
});
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: ComponentProps<'a'>) => createElement('a', { href, ...props }, children),
}));

let db: InMemorySupabase;
const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1) + minutes * 60_000).toISOString();

function review(id: string, rating: number, status: string, minutes: number, extra: Record<string, unknown> = {}) {
  return { id, rating, status, title: null, body: `Review ${id}`, author_name: 'A family', reply: null, submitted_at: at(minutes), deleted_at: null, ...extra };
}

async function wall(): Promise<string> {
  const { default: ReviewsWallPage } = await import('@/app/reviews/page');
  return textOf(await renderServerPage(await ReviewsWallPage()));
}

beforeEach(() => {
  db = createInMemorySupabase({ maxRows: 1000 });
  h.db = db;
  // 200 older one-star reviews, 50 newer five-star ones, and ten featured fives.
  db.seed('reviews', [
    ...Array.from({ length: 200 }, (_, i) => review(`old-${i}`, 1, 'approved', i)),
    ...Array.from({ length: 50 }, (_, i) => review(`new-${i}`, 5, 'approved', 1000 + i)),
    ...Array.from({ length: 10 }, (_, i) => review(`feat-${i}`, 5, 'featured', 500 + i)),
    // Neither of these is public.
    review('pending-1', 5, 'pending', 2000),
    review('deleted-1', 5, 'approved', 2001, { deleted_at: at(2002) }),
  ]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

describe('the public rating', () => {
  it('is counted over every public review, not the 200 cards listed', async () => {
    // 260 public reviews: 60 fives and 200 ones, so 1.9. The listed 200 (the
    // ten featured, the fifty newest, then 140 old ones) said 2.2 from 200.
    const text = await wall();
    expect(text).toContain('1.9 from 260 reviews');
    expect(text).not.toContain('from 200 reviews');
    // The cards are still the 200 the page lists.
    expect(text.match(/Review (old|new|feat)-\d+/g)).toHaveLength(200);
  });

  it('is not moved by which reviews are featured', async () => {
    const before = await wall();
    // Feature fifty of the one-star reviews: the set of public reviews is the same.
    db.replace('reviews', db.table('reviews').map((r) => (String(r.id).startsWith('old-') && Number(String(r.id).slice(4)) < 50 ? { ...r, status: 'featured' } : r)));
    const after = await wall();
    expect(after).toContain('1.9 from 260 reviews');
    expect(before).toContain('1.9 from 260 reviews');
  });

  it('is not shown at all when a count cannot be read, rather than taken from part of the set', async () => {
    h.db = withFaults(db, (table, calls: FaultCall[]) => (table === 'reviews' && calls.some((c) => c.method === 'eq' && c.args[0] === 'rating' && c.args[1] === 3)
      ? { message: 'reviews count unavailable' } : null));
    const text = await wall();
    expect(text).not.toMatch(/from \d+ reviews?/);
    expect(text).toContain('Review new-49');
  });
});
