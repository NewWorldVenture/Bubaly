import { NextResponse } from 'next/server';
import { encodeSignOutBridge, prepareSignOutBridge, SIGNOUT_BRIDGE_COOKIE, SIGNOUT_BRIDGE_PATH } from '@/lib/auth/signout-bridge';
import { isSecureRequest } from '@/lib/auth/session';

/**
 * Compatibility for form POSTs made before hydration. Browser controls clear
 * their intended session locally. This route never writes authentication
 * cookies: a delayed response cannot delete a newer login.
 *
 * Scoped to this device by default. `signOut()` defaults to `global`, which
 * revokes every refresh token the user has anywhere — so signing out on the
 * laptop would silently sign them out on their phone, which is precisely the
 * surprise logout this flow exists to avoid. Post `scope=global` to opt into
 * signing out everywhere (for a lost device).
 */
export async function POST(request: Request) {
  const url = new URL(request.url);
  const origin = request.headers.get('origin');
  if ((origin !== null && origin !== url.origin) || request.headers.get('sec-fetch-site') === 'cross-site') {
    return new NextResponse(null, { status: 403, headers: { 'Cache-Control': 'no-store' } });
  }
  const scope = await readScope(request);
  const bridge = await prepareSignOutBridge(scope);
  const res = NextResponse.redirect(new URL(`${SIGNOUT_BRIDGE_PATH}?intent=${bridge.nonce}`, url.origin), { status: 303 });
  res.headers.set('Cache-Control', 'no-store');
  res.headers.set('Referrer-Policy', 'no-referrer');
  res.cookies.set(SIGNOUT_BRIDGE_COOKIE, encodeSignOutBridge(bridge), {
    httpOnly: true, sameSite: 'strict', path: SIGNOUT_BRIDGE_PATH, maxAge: 60,
    secure: isSecureRequest({ forwardedProto: request.headers.get('x-forwarded-proto'), url: request.url }),
  });
  return res;
}

/** `scope=global` in the posted form opts into signing out on every device. */
async function readScope(request: Request): Promise<'local' | 'global'> {
  try {
    const form = await request.clone().formData();
    return form.get('scope') === 'global' ? 'global' : 'local';
  } catch {
    return 'local'; // no body, or not a form post
  }
}
