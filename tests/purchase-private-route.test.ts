import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const fakes = vi.hoisted(() => ({ load: vi.fn(), retry: vi.fn(), revalidate: vi.fn(), role: 'parent', db: {} }));
vi.mock('@/lib/services/purchases/private-result', () => ({ loadPrivatePurchaseAnswer: fakes.load, retryPrivatePurchaseAnswer: fakes.retry }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => fakes.db }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: async () => ({ user: { id: 'user' }, active: {
  familyId: 'family', role: fakes.role, member: { id: 'member' }, family: { timezone: 'UTC' },
} }) }));
vi.mock('next/cache', () => ({ revalidatePath: fakes.revalidate }));
vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('NOT_FOUND'); }, redirect: (url: string) => { throw new Error(`REDIRECT ${url}`); } }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string) => translate(SOURCE_MESSAGES, key) };
});
const { default: Page } = await import('@/app/(app)/dashboard/assistant/purchases/[approvalId]/page');
const { retryPurchaseAnswer } = await import('@/app/(app)/dashboard/assistant/purchases/[approvalId]/actions');
const page = (retry?: string) => Page({ params: Promise.resolve({ approvalId: 'approval' }), searchParams: Promise.resolve({ retry }) });
beforeEach(() => { vi.clearAllMocks(); fakes.role = 'parent'; });

describe('private purchase destination', () => {
  it('lets the requesting parent reach the approval screen while waiting', async () => {
    fakes.load.mockResolvedValue({ ok: true, data: { kind: 'waiting' } });
    const html = renderToStaticMarkup(await page());
    expect(html).toContain('href="/dashboard/trust"');
    expect(html).toContain('href="/dashboard/assistant/purchases/approval"');
    expect(html).toContain('waiting for approval');
    expect(fakes.load).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user', memberId: 'member', familyId: 'family', role: 'parent' }), 'approval');
  });

  it('gives a child a waiting status without offering the parent approval screen', async () => {
    fakes.role = 'child';
    fakes.load.mockResolvedValue({ ok: true, data: { kind: 'waiting' } });
    const html = renderToStaticMarkup(await page());
    expect(html).not.toContain('href="/dashboard/trust"');
    expect(html).toContain('Refresh status');
  });

  it('escapes privately stored evidence and never makes it executable markup', async () => {
    fakes.load.mockResolvedValue({ ok: true, data: { kind: 'ready', answer: 'Budget: $89\n<script>private()</script>' } });
    const html = renderToStaticMarkup(await page());
    expect(html).toContain('Budget: $89');
    expect(html).toContain('&lt;script&gt;private()&lt;/script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('hides a non-owner result and shows a recoverable storage failure separately', async () => {
    fakes.load.mockResolvedValue({ ok: false, code: 'denied', error: 'Private' });
    await expect(page()).rejects.toThrow('NOT_FOUND');
    fakes.load.mockResolvedValue({ ok: false, code: 'db_error', error: 'Internal storage detail' });
    const html = renderToStaticMarkup(await page());
    expect(html).toContain('role="alert"');
    expect(html).toContain('Refresh status');
    expect(html).not.toContain('Internal storage detail');
  });

  it('reruns only the persisted approval using the signed-in actor and returns to its private route', async () => {
    fakes.retry.mockResolvedValue({ ok: true, data: null });
    await expect(retryPurchaseAnswer('approval')).rejects.toThrow('REDIRECT /dashboard/assistant/purchases/approval');
    expect(fakes.retry).toHaveBeenCalledWith(expect.objectContaining({ userId: 'user', memberId: 'member', familyId: 'family' }), 'approval');
    expect(fakes.revalidate).toHaveBeenCalledWith('/dashboard/assistant/purchases/approval');
    fakes.retry.mockResolvedValue({ ok: false, code: 'db_error' });
    await expect(retryPurchaseAnswer('approval')).rejects.toThrow('REDIRECT /dashboard/assistant/purchases/approval?retry=failed');
  });
});
