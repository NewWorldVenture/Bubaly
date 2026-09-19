import { NextResponse } from 'next/server';
import { resolveAuthSelection } from '@/lib/billing/review-selection';

/** Admission only. The browser owns the later exchange and session adoption. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const selection = resolveAuthSelection(url.searchParams, 'next');
  const query = new URLSearchParams({ next: selection.next ?? '/home' });
  const codes = url.searchParams.getAll('code');
  const code = codes[0];
  if (codes.length === 1 && typeof code === 'string' && code.length > 0 && code.length <= 4096
    && !/[\s\x00-\x1f\x7f]/.test(code) && !url.searchParams.has('error') && !url.searchParams.has('error_code')) {
    query.set('code', code);
  } else query.set('error', 'auth');
  const response = NextResponse.redirect(new URL(`/auth/complete?${query}`, url.origin));
  response.headers.set('Cache-Control', 'private, no-store');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}
