import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import DocumentLinkPage from '@/app/(app)/capture/link/page';
import { linkedDocumentSource } from '@/lib/services/paperwork/link';

const state = vi.hoisted(() => ({ access: vi.fn(), source: vi.fn(), assurance: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: async () => ({ user: { id: 'user-1' }, active: { familyId: 'family-1', member: { id: 'member-1' }, family: { timezone: 'UTC' }, role: 'parent' } }) }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => ({}) }));
vi.mock('@/lib/auth/require-aal2', () => ({ requireAal2: state.assurance }));
vi.mock('@/lib/services/paperwork/link-access', () => ({ authorizeDocumentLink: state.access }));
vi.mock('@/lib/services/paperwork/link', () => ({ linkedDocumentSource: state.source }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/components/capture/document-link-capture', () => ({ DocumentLinkCapture: () => null }));
beforeEach(() => { state.access.mockReset().mockResolvedValue({ ok: true }); state.source.mockReset().mockResolvedValue({ ok: true, data: { urls: ['https://school.org/form.pdf'] } }); state.assurance.mockReset().mockResolvedValue(undefined); });

describe('linked-document page read boundary', () => {
  it('opens a pasted/shared URL without reading a source message or fetching the document', async () => {
    const page = await DocumentLinkPage({ searchParams: Promise.resolve({ url: 'https://school.org/form.pdf' }) }) as ReactElement<{ children: ReactElement<Record<string, unknown>> }>;
    expect(page.props.children.props).toMatchObject({ initialUrl: 'https://school.org/form.pdf', expectedFamilyId: 'family-1', expectedUserId: 'user-1' });
    expect(linkedDocumentSource).not.toHaveBeenCalled();
    expect(state.access.mock.calls[0][2]).toBe(false);
  });
  it('shows only caller-authorized inbound candidates without preselecting/fetching them', async () => {
    const page = await DocumentLinkPage({ searchParams: Promise.resolve({ messageId: 'message-1' }) }) as ReactElement<{ children: ReactElement<Record<string, unknown>> }>;
    expect(state.access.mock.calls[0][2]).toBe(true);
    expect(page.props.children.props).toMatchObject({ initialUrl: '', messageId: 'message-1', candidates: ['https://school.org/form.pdf'] });
  });
  it('stops at MFA before source read or access-dependent rendering', async () => {
    state.assurance.mockRejectedValue(new Error('step-up redirect'));
    await expect(DocumentLinkPage({ searchParams: Promise.resolve({ messageId: 'message-1' }) })).rejects.toThrow('step-up redirect');
    expect(state.access).not.toHaveBeenCalled(); expect(state.source).not.toHaveBeenCalled();
  });
  it('renders a retryable failure instead of an empty source after a failed read', async () => {
    state.source.mockResolvedValue({ ok: false, retryable: true });
    const html = renderToStaticMarkup(await DocumentLinkPage({ searchParams: Promise.resolve({ messageId: 'message-1' }) }));
    expect(html).toContain('documentLink.source_unavailable'); expect(html).toContain('messageId=message-1');
    expect(html).not.toContain('documentLink.no_links');
  });
  it('does not reveal source candidates after access denial', async () => {
    state.access.mockResolvedValue({ ok: false, reason: 'access_denied', retryable: false });
    expect(renderToStaticMarkup(await DocumentLinkPage({ searchParams: Promise.resolve({ messageId: 'message-1' }) }))).toContain('documentLink.access_denied');
    expect(state.source).not.toHaveBeenCalled();
  });
  it('rejects repeated malformed URL/source query parameters before reads', async () => {
    const page = await DocumentLinkPage({ searchParams: Promise.resolve({ messageId: ['one', 'two'] } as unknown as { messageId: string }) });
    expect(renderToStaticMarkup(page)).toContain('documentLink.invalid_url');
    expect(state.access).not.toHaveBeenCalled(); expect(state.source).not.toHaveBeenCalled();
  });
});
