import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ambient = vi.hoisted(() => vi.fn(() => { throw new Error('Admission cannot initialize ambient authentication'); }));
vi.mock('@/lib/supabase/server', () => ({ createServer: ambient, createServiceClient: ambient }));
import { GET } from '@/app/auth/callback/route';

beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Admission cannot call a provider'); })); });
afterEach(() => { vi.unstubAllGlobals(); });

// A stale/cancelled sign-in must consult the browser's current owner at guarded
// completion, not refresh the owner captured when an old GET request started.
describe('failed-link admission preserves the browser-owned fallback', () => {
  it.each([
    ['', '/home'], ['?error=access_denied', '/home'], ['?code=expired', '/home'],
    ['?code=spent&next=%2Fdashboard%2Fcalendar', '/dashboard/calendar'],
    ['?error=denied&next=%2Fonboarding%3FreviewPlan%3Dplus_annual', '/onboarding?reviewPlan=plus_annual'],
  ])('retains destination for %s without reading or refreshing ambient credentials', async (query, next) => {
    const request = new Request(`https://app.example.invalid/auth/callback${query}`, {
      headers: { cookie: 'sb-fixture-auth-token=older-session; sb-fixture-auth-token-code-verifier=pending; bubaly-recovery-handoff=older-grant' },
    });
    const before = request.headers.get('cookie');
    const response = await GET(request);
    const location = new URL(response.headers.get('location')!);
    expect(location.pathname).toBe('/auth/complete'); expect(location.searchParams.get('next')).toBe(next);
    expect(response.headers.get('set-cookie')).toBeNull(); expect(response.cookies.getAll()).toEqual([]);
    expect(request.headers.get('cookie')).toBe(before); expect(ambient).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it('does not decide that a visitor is signed out from an old request with no cookies', async () => {
    const response = await GET(new Request('https://app.example.invalid/auth/callback?error=denied'));
    const location = new URL(response.headers.get('location')!);
    expect(location.pathname).toBe('/auth/complete'); expect(location.searchParams.get('error')).toBe('auth');
    expect(ambient).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
});
