// A stranger's review is never published on arrival (audit N4).
//
// /reviews/new is public. Once an admin set reputation_settings.auto_approve_min,
// any review at or above it was written `approved` and drawn on the public
// /reviews wall at once — the only control was 5 a minute per address, so one
// address could post 7,200 approved five-star reviews a day under invented
// names, and rotating addresses removed even that bound. Driven through the
// real action against the in-memory database: a stranger's submission waits for
// moderation whatever the threshold, a signed-in member's still clears it (the
// control), a filled honeypot writes nothing and is told what a person is told,
// an address gets three a day, and the same text twice in a day is one review.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { rateLimitHit } from './helpers/rate-limit-rpc';

const h = vi.hoisted(() => ({ db: null as unknown, userId: null as string | null, ip: '203.0.113.9' }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db }));
vi.mock('@/lib/auth/signed-in-user', () => ({ signedInUserId: async () => h.userId }));
vi.mock('next/headers', () => ({ headers: async () => new Headers({ 'x-forwarded-for': h.ip }) }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

type Db = ReturnType<typeof createInMemorySupabase>;
let db: Db;
const submit = async (input: Record<string, unknown>) => (await import('@/app/reviews/new/actions')).submitReviewAction(input as never);
const reviews = () => db.table('reviews');

beforeEach(() => {
  vi.resetModules();
  h.userId = null;
  h.ip = '203.0.113.9';
  db = createInMemorySupabase({ rpc: { rate_limit_hit: rateLimitHit } });
  // The admin has set the threshold: the configuration under which the defect holds.
  db.seed('reputation_settings', [{ singleton: true, auto_approve_min: 4 }]);
  h.db = db;
});
afterEach(() => { vi.restoreAllMocks(); });

describe('who clears the auto-approve threshold', () => {
  it('a stranger\'s five-star review is written pending, not approved', async () => {
    expect(await submit({ rating: 5, title: 'Wonderful', body: 'Changed our mornings.', name: 'Pat' })).toEqual({ ok: true });
    expect(reviews()).toHaveLength(1);
    expect(reviews()[0]).toMatchObject({ rating: 5, title: 'Wonderful', author_name: 'Pat', status: 'pending' });
  });

  it('a signed-in member\'s review still clears it, and still waits below it (control)', async () => {
    h.userId = 'user-member';
    expect(await submit({ rating: 5, title: 'Wonderful', body: 'Changed our mornings.' })).toEqual({ ok: true });
    expect(await submit({ rating: 3, title: 'Fine', body: 'Does the job.' })).toEqual({ ok: true });
    expect(reviews().map((row) => [row.rating, row.status])).toEqual([[5, 'approved'], [3, 'pending']]);
  });

  it('with no threshold configured a member\'s review is pending too (the shipped default)', async () => {
    db.table('reputation_settings')[0].auto_approve_min = null;
    h.userId = 'user-member';
    expect(await submit({ rating: 5, body: 'Lovely.' })).toEqual({ ok: true });
    expect(reviews()[0]).toMatchObject({ status: 'pending' });
  });
});

describe('what a bot gets', () => {
  it('a filled honeypot is answered exactly like a success and writes nothing', async () => {
    expect(await submit({ rating: 5, body: 'Buy now', website: 'https://spam.example' })).toEqual({ ok: true });
    expect(reviews()).toEqual([]);
  });

  it('an empty honeypot is a person (control)', async () => {
    expect(await submit({ rating: 4, body: 'Helpful.', website: '' })).toEqual({ ok: true });
    expect(reviews()).toHaveLength(1);
  });

  it('the fourth review from one address in a day is refused; another address is not', async () => {
    for (const body of ['First.', 'Second.', 'Third.']) expect(await submit({ rating: 5, body })).toEqual({ ok: true });
    expect(await submit({ rating: 5, body: 'Fourth.' })).toEqual({ ok: false, error: 'actions.tooManyReviewAttemptsPlease' });
    expect(reviews()).toHaveLength(3);
    h.ip = '198.51.100.7';
    expect(await submit({ rating: 5, body: 'Fourth, elsewhere.' })).toEqual({ ok: true });
    expect(reviews()).toHaveLength(4);
  });

  it('the same text twice in a day is one review, and the repeat is told nothing', async () => {
    const review = { rating: 5, title: 'Wonderful', body: 'Changed our mornings.' };
    expect(await submit(review)).toEqual({ ok: true });
    expect(await submit({ ...review, name: 'Someone Else' })).toEqual({ ok: true });
    expect(reviews()).toHaveLength(1);
  });
});
