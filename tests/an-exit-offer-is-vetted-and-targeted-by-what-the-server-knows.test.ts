// Admin reach N18 and N19 — exit-intent offers.
//
// N18: an offer went live to every public visitor the moment it was saved
// (the action and the form both defaulted to 'active'), with its CTA href
// stored as typed — no check like the landing CTA's safeHref, so a typo, a
// relative 'signup' that resolves against the current page or a '//host' link
// went to everyone — and headline, body and button label had no length bound.
//
// N19: the public resolve route built the visitor context's country,
// segments and session count from the request body. The real client sends
// none of them, so an offer targeted by country or minimum sessions never
// reached a genuine visitor, and anyone who POSTed {country, sessions,
// segments} got it.
//
// Driven through the REAL admin page and action, and the REAL resolve route,
// against the in-memory database. Negative controls: before the fix the form
// defaulted to active, unvetted links and oversized copy were stored, a forged
// body selected the targeted offers, and the edge's country did not.
import { createElement, type ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { REFUSAL_DIGEST_PREFIX } from '@/lib/actions/refusal';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';
import { renderServerPage } from './helpers/render-server-page';

const h = vi.hoisted(() => ({ db: null as unknown, gate: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db }));
vi.mock('@/lib/i18n/server', () => ({
  getTranslations: async () => (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params),
}));
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: ComponentProps<'a'>) => createElement('a', { href, ...props }, children),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/marketing/admin', () => ({
  requireMarketingAdmin: h.gate,
  logMarketingAudit: vi.fn(async () => undefined),
  marketingActionFailure: (operation: string) => { throw new Error(`Could not ${operation}.`); },
}));

const { default: ExitIntentPage } = await import('@/app/(app)/admin/marketing/exit-intent/page');
const { createExitIntentAction } = await import('@/app/(app)/admin/marketing/exit-intent/actions');
const { POST: resolve } = await import('@/app/api/exit-intent/resolve/route');

let db: InMemorySupabase;
function form(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [key, value] of Object.entries({ name: 'Spring offer', headline: 'Wait — 10% off', ...fields })) fd.set(key, value);
  return fd;
}
async function digestOf(run: Promise<unknown>) {
  const error = await run.then(() => null, (e: unknown) => e as { digest?: string });
  return error?.digest ?? null;
}

beforeEach(() => {
  db = createInMemorySupabase({
    defaults: { marketing_exit_intent: { deleted_at: null, impressions: 0, conversions: 0 } },
    rpc: { rate_limit_hit: () => [{ allowed: true, retry_after: 0 }] },
  });
  h.db = db;
  db.seed('marketing_exit_intent', []);
  h.gate.mockReset().mockResolvedValue({ supabase: db, actorId: 'admin-1', actorEmail: 'admin@example.test' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('a new exit-intent offer', () => {
  it('starts paused, in the form and in the action', async () => {
    const html = await renderServerPage(await ExitIntentPage());
    const status = /<select[^>]*name="status"[^>]*>([\s\S]*?)<\/select>/.exec(html)?.[1] ?? '';
    expect(status).toMatch(/<option value="paused" selected="">/);
    expect(html).not.toContain('name="minSessions"');
    await createExitIntentAction(form({}));
    expect(db.table('marketing_exit_intent')[0]).toMatchObject({ status: 'paused' });
  });

  it.each(['javascript:alert(1)', '//evil.example/x', 'signup', 'ftp://files.example/x', '/ok\nnext'])(
    'refuses the CTA link %j and stores nothing', async (href) => {
      expect(await digestOf(createExitIntentAction(form({ cta_href: href, status: 'active' })))).toBe(`${REFUSAL_DIGEST_PREFIX}invalid`);
      expect(db.table('marketing_exit_intent')).toEqual([]);
    });

  it.each([
    ['headline', 'h'.repeat(121)], ['body', 'b'.repeat(601)], ['cta_label', 'c'.repeat(41)],
  ])('refuses an oversized %s', async (field, value) => {
    expect(await digestOf(createExitIntentAction(form({ [field]: value })))).toBe(`${REFUSAL_DIGEST_PREFIX}invalid`);
    expect(db.table('marketing_exit_intent')).toEqual([]);
  });

  it('refuses session-count targeting, which no trusted source can match', async () => {
    expect(await digestOf(createExitIntentAction(form({ minSessions: '3' })))).toBe(`${REFUSAL_DIGEST_PREFIX}invalid`);
    expect(db.table('marketing_exit_intent')).toEqual([]);
  });

  it('the control: a same-site path or an https link at the limits is stored as typed', async () => {
    await createExitIntentAction(form({ headline: 'h'.repeat(120), cta_label: 'c'.repeat(40), cta_href: '/signup', status: 'active' }));
    await createExitIntentAction(form({ cta_href: 'https://example.com/spring?x=1' }));
    expect(db.table('marketing_exit_intent').map((row) => [row.cta_href, row.status])).toEqual([['/signup', 'active'], ['https://example.com/spring?x=1', 'paused']]);
  });
});

describe('the public resolve route', () => {
  const offer = (id: string, priority: number, match: Row, extra: Row = {}): Row => ({
    id, name: id, headline: `Offer ${id}`, body: null, cta_label: null, cta_href: '/signup', match, trigger_config: {},
    priority, status: 'active', deleted_at: null, created_at: '2026-10-01T00:00:00.000Z', ...extra,
  });
  async function offerFor(body: Record<string, unknown>, headers: Record<string, string> = {}) {
    const res = await resolve(new NextRequest('https://bubaly.com/api/exit-intent/resolve', {
      method: 'POST', body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '198.51.100.7', ...headers },
    }));
    return ((await res.json()) as { offer: { id: string; cta_href: string | null } | null }).offer;
  }
  beforeEach(() => {
    db.replace('marketing_exit_intent', [
      offer('general', 0, {}),
      offer('us-only', 5, { countries: ['US'] }),
      offer('regulars', 10, { minSessions: 3 }),
      offer('vip', 20, { segments: ['vip'] }),
    ]);
  });

  it('does not let a forged body choose a country, session count or segment offer', async () => {
    expect((await offerFor({ path: '/pricing', country: 'US', sessions: 99, segments: ['vip'] }))?.id).toBe('general');
  });

  it("targets by the edge's country", async () => {
    expect((await offerFor({ path: '/pricing' }, { 'x-vercel-ip-country': 'US' }))?.id).toBe('us-only');
    expect((await offerFor({ path: '/pricing' }, { 'x-vercel-ip-country': 'FR' }))?.id).toBe('general');
  });

  it('serves no button for a link stored before the console checked it', async () => {
    db.replace('marketing_exit_intent', [offer('old', 0, {}, { cta_href: '//evil.example/x' })]);
    expect(await offerFor({ path: '/pricing' })).toMatchObject({ id: 'old', cta_href: null });
  });
});
