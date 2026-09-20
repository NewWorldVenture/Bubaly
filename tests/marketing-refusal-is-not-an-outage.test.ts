import { NextRequest } from 'next/server';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// F-E09. `requireMarketingAdmin` throws to refuse, so a route meets that
// refusal in the same catch block as every genuine fault — and the two routes
// that handled it told the cases apart by searching the message for 'sign in',
// 'permission' or 'Forbidden'. The AI route searched for 'Forbidden', a word
// that function has never said, so a non-admin was answered:
//
//     500  { error: 'Could not generate. Check that the OpenAI API key is set.' }
//
// No access was granted either way. What was wrong is that nothing downstream
// could tell a permissions refusal from an outage: the operator is sent to look
// at an API key that is fine, while the real event — someone who should not be
// there, asking — does not appear as one.
//
// These cases drive the real handlers, so they fail against the old string
// matching rather than against a description of it.

const getUser = vi.fn();
const isSuperAdmin = vi.fn();

vi.mock('@/lib/supabase/auth', () => ({
  getUser: (...a: unknown[]) => getUser(...a),
  isSuperAdmin: (...a: unknown[]) => isSuperAdmin(...a),
  getUserContext: vi.fn(),
}));
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({ from: () => ({ insert: async () => ({ error: null }) }) }),
  createServer: async () => ({}),
}));

function post(url: string, body: unknown = {}): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// Both handlers call getTranslations() before anything else, and the first
// call in a process loads the catalogues. That is startup cost, not part of
// what is under test, so it is paid once here rather than inside the first
// case's timeout.
beforeAll(async () => {
  const { getTranslations } = await import('@/lib/i18n/server');
  await getTranslations();
}, 30_000);

beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('the marketing AI route, refusing a caller', () => {
  it('answers 403 to someone signed in without permission — not 500', async () => {
    getUser.mockResolvedValue({ id: 'u1', email: 'someone@example.test' });
    isSuperAdmin.mockResolvedValue(false);
    const { POST } = await import('@/app/api/admin/marketing/ai/route');
    const res = await POST(post('https://example.test/api/admin/marketing/ai', { task: 'analyze' }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('Forbidden');
    // The specific lie this replaces: a refusal must not blame the provider.
    expect(JSON.stringify(body)).not.toContain('OpenAI');
  });

  it('answers 401 to someone not signed in at all', async () => {
    getUser.mockResolvedValue(null);
    isSuperAdmin.mockResolvedValue(false);
    const { POST } = await import('@/app/api/admin/marketing/ai/route');
    const res = await POST(post('https://example.test/api/admin/marketing/ai', { task: 'analyze' }));
    expect(res.status).toBe(401);
  });

  it('does not log a refusal as an application error', async () => {
    // A refusal logged at error level is the other half of the same confusion:
    // it raises an alert about a subsystem that is working.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    getUser.mockResolvedValue({ id: 'u1', email: 'someone@example.test' });
    isSuperAdmin.mockResolvedValue(false);
    const { POST } = await import('@/app/api/admin/marketing/ai/route');
    await POST(post('https://example.test/api/admin/marketing/ai', { task: 'analyze' }));
    expect(error.mock.calls.map((c) => String(c[0])).join('\n')).not.toContain('Marketing AI error');
  });
});

describe('the sibling email-send route', () => {
  it('answers 403 on POST without permission', async () => {
    getUser.mockResolvedValue({ id: 'u1', email: 'someone@example.test' });
    isSuperAdmin.mockResolvedValue(false);
    const { POST } = await import('@/app/api/admin/marketing/email/send/route');
    const res = await POST(post('https://example.test/api/admin/marketing/email/send', { id: 'c1' }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('Forbidden');
  });

  it('answers 403 on the recipient preview too, rather than 502', async () => {
    getUser.mockResolvedValue({ id: 'u1', email: 'someone@example.test' });
    isSuperAdmin.mockResolvedValue(false);
    const mod = await import('@/app/api/admin/marketing/email/send/route');
    const res = await mod.GET(new NextRequest('https://example.test/api/admin/marketing/email/send?id=c1'));
    expect(res.status).toBe(403);
  });
});

describe('the refusal carries its own identity', () => {
  it('is a distinguishable type, not a sentence to be searched', async () => {
    const { MarketingAuthorizationError, isMarketingAuthorizationError } =
      await import('@/lib/marketing/admin');
    expect(isMarketingAuthorizationError(new MarketingAuthorizationError('forbidden', 'nope'))).toBe(true);
    expect(isMarketingAuthorizationError(new Error('You do not have permission to manage marketing settings.'))).toBe(false);
    // A provider fault that happens to contain the old keywords must not be
    // mistaken for a refusal — that is the failure mode in reverse.
    expect(isMarketingAuthorizationError(new Error('Provider rejected: sign in to your OpenAI account'))).toBe(false);
  });

  it('is thrown with the reason that maps to the status', async () => {
    const { requireMarketingAdmin, isMarketingAuthorizationError } = await import('@/lib/marketing/admin');
    getUser.mockResolvedValue(null);
    await expect(requireMarketingAdmin()).rejects.toSatisfy(
      (e: unknown) => isMarketingAuthorizationError(e) && e.reason === 'unauthenticated');
    getUser.mockResolvedValue({ id: 'u1', email: 'a@b.test' });
    isSuperAdmin.mockResolvedValue(false);
    await expect(requireMarketingAdmin()).rejects.toSatisfy(
      (e: unknown) => isMarketingAuthorizationError(e) && e.reason === 'forbidden');
  });
});
