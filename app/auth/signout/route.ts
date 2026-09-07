import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createServer } from '@/lib/supabase/server';
import { isAuthCookieName } from '@/lib/auth/session';

/**
 * Sign out — the ONLY thing that ends a session. Everything else in the auth
 * path is built to keep a session alive, so this is the single place a user's
 * sign-in is deliberately thrown away.
 *
 * Scoped to this device by default. `signOut()` defaults to `global`, which
 * revokes every refresh token the user has anywhere — so signing out on the
 * laptop would silently sign them out on their phone, which is precisely the
 * surprise logout this flow exists to avoid. Post `scope=global` to opt into
 * signing out everywhere (for a lost device).
 */
export async function POST(request: Request) {
  const scope = await readScope(request);
  const supabase = await createServer();
  await supabase.auth.signOut({ scope });

  const res = NextResponse.redirect(new URL('/login', new URL(request.url).origin), { status: 303 });

  // Expire the auth cookies on the redirect itself. supabase-js clears them
  // through the cookie store, and Next carries those mutations onto the
  // response — but a session that outlives an explicit sign-out is the one
  // failure this route must never have, so state it on the response too.
  const jar = await cookies();
  for (const cookie of jar.getAll()) {
    if (isAuthCookieName(cookie.name)) res.cookies.set(cookie.name, '', { path: '/', maxAge: 0 });
  }
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
