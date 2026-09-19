import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Execute the real async route and query parser; only its client UI is a seam.
vi.mock('@/components/auth/callback-completion', () => ({ CallbackCompletion: () => null }));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));
import CallbackCompletionPage, { metadata } from '@/app/(auth)/auth/complete/page';

type Query = Record<string, string | string[] | undefined>;
const page = (query: Query) => CallbackCompletionPage({ searchParams: Promise.resolve(query) });
beforeEach(() => vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://completion-page.supabase.co'));
afterEach(() => vi.unstubAllEnvs());

describe('direct completion page admission', () => {
  it('awaits Next 15 searchParams and passes one admitted code and internal destination', async () => {
    const tree = await page({ code: 'synthetic-code', next: '/dashboard/meals?week=next', ignored: undefined });
    expect(tree.props).toEqual({ code: 'synthetic-code', next: '/dashboard/meals?week=next', admission: expect.any(String) });
    expect(metadata).toMatchObject({ robots: { index: false, follow: false }, referrer: 'no-referrer' });
  });

  it.each<[string, Query]>([
    ['missing', {}], ['empty', { code: '' }], ['duplicate', { code: ['one', 'two'] }],
    ['duplicate identical', { code: ['one', 'one'] }], ['whitespace', { code: 'one two' }],
    ['control', { code: 'one\u0000two' }], ['delete', { code: 'one\u007ftwo' }],
    ['oversized', { code: 'x'.repeat(4097) }], ['provider error', { code: 'one', error: 'denied' }],
    ['empty provider error', { code: 'one', error: '' }], ['provider error code', { code: 'one', error_code: 'denied' }],
  ])('rejects %s code even when the admission redirect is bypassed', async (_label, query) => {
    expect((await page(query)).props).toEqual({ code: null, next: '/home', admission: expect.any(String) });
  });

  it.each<[string, Query, string]>([
    ['external next', { next: 'https://evil.invalid/destination' }, '/home'],
    ['protocol relative next', { next: '//evil.invalid/destination' }, '/home'],
    ['backslash next', { next: '/\\evil.invalid' }, '/home'],
    ['ambiguous next with valid pricing', { next: ['/home', '/dashboard'], reviewPlan: 'plus_annual' }, '/home'],
    ['recognized review plan', { reviewPlan: 'basic_annual' }, '/onboarding?reviewPlan=basic_annual'],
    ['legacy plan', { plan: 'plus', billing: 'yearly' }, '/onboarding?reviewPlan=plus_annual'],
    ['ambiguous plan', { plan: ['basic', 'plus'], billing: 'monthly' }, '/home'],
    ['mixed plan', { reviewPlan: 'plus_annual', plan: 'basic', billing: 'monthly' }, '/home'],
    ['unrecognized plan', { reviewPlan: 'free_forever' }, '/home'],
    ['checkout flag', { reviewPlan: 'plus_annual', checkout: 'true' }, '/home'],
    ['explicit invite before pricing', { next: '/invite/synthetic', reviewPlan: 'plus_annual' }, '/invite/synthetic'],
  ])('resolves %s through the real selection contract', async (_label, query, expected) => {
    expect((await page({ code: 'synthetic-code', ...query })).props).toEqual({ code: 'synthetic-code', next: expected, admission: expect.any(String) });
  });

  it('does not serialize unadmitted token query values in the client element key or props', async () => {
    const clean = await page({ next: '/home' });
    const dirty = await page({ code: 'synthetic-code', next: '/home', access_token: 'synthetic-access-secret',
      refresh_token: 'synthetic-refresh-secret', token_hash: 'synthetic-token-hash', error_description: 'untrusted-detail' });
    expect(dirty.key).toBe(clean.key);
    expect(dirty.props).toEqual(clean.props);
    expect(JSON.stringify({ key: dirty.key, props: dirty.props })).not.toContain('synthetic-access-secret');
    expect(JSON.stringify({ key: dirty.key, props: dirty.props })).not.toContain('synthetic-refresh-secret');
  });

  it.each(['access_token', 'refresh_token', 'id_token', 'token_hash'])('rejects a direct code mixed with %s query credentials', async name => {
    expect((await page({ code: 'synthetic-code', [name]: 'synthetic-secret' })).props).toEqual({ code: null, next: '/home', admission: expect.any(String) });
  });

  it('unknown query values do not change the admitted operation key', async () => {
    const clean = await page({ code: 'synthetic-code', next: '/home' });
    const dirty = await page({ code: 'synthetic-code', next: '/home', unrelated: 'untrusted-value' });
    expect(dirty.key).toBe(clean.key);
    expect(dirty.props).toEqual(clean.props);
  });
});
