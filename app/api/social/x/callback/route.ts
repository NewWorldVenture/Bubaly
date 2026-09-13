import { NextRequest, NextResponse } from 'next/server';
import { getTranslations, getLocaleContext } from '@/lib/i18n/server';
import { XBoundaryError } from '@/lib/social/account-tokens';
import { finishXAuthorization, readXAuthorization, X_COOKIE, X_CALLBACK_PATH } from '@/lib/social/x-oauth';

export const runtime = 'nodejs';
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}

export async function GET(request: NextRequest) {
  const t = await getTranslations();
  let response: NextResponse;
  try {
    const params = request.nextUrl.searchParams;
    if (params.getAll('state').length !== 1 || params.getAll('code').length !== 1 || params.has('error')) throw new XBoundaryError('socialX.callbackInvalid');
    const flow = readXAuthorization(request.cookies.get(X_COOKIE)?.value, params.get('state'), request.url);
    await finishXAuthorization(flow, params.get('code')!);
    response = NextResponse.redirect(new URL('/dashboard/social/accounts', flow.redirectUri));
  } catch (error) {
    const message = escapeHtml(t(error instanceof XBoundaryError ? error.key : 'socialX.connectionFailed'));
    const back = escapeHtml(t('dashboardSocialAccountsConnect.backToAccounts'));
    const { locale } = await getLocaleContext();
    response = new NextResponse(`<!doctype html><html lang="${escapeHtml(locale.code)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${message}</title><style>html{font-family:system-ui,sans-serif;color-scheme:light dark}main{max-width:36rem;margin:12vh auto;padding:1.5rem}h1{font-size:1.5rem;line-height:1.4}a{display:inline-block;margin-top:1rem}</style></head><body><main><h1>${message}</h1><a href="/dashboard/social/accounts">${back}</a></main></body></html>`, {
      status: 400, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'", 'X-Content-Type-Options': 'nosniff' },
    });
  }
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.cookies.set(X_COOKIE, '', { httpOnly: true, sameSite: 'lax', secure: request.nextUrl.protocol === 'https:', path: X_CALLBACK_PATH, maxAge: 0 });
  return response;
}
