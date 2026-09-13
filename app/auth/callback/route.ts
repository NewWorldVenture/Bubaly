import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import { createServer, createServiceClient } from '@/lib/supabase/server';
import { isSuperAdminEmail } from '@/lib/constants/super-admins';
import { stitchVisitorIdentity } from '@/lib/marketing/identity';
import { safeInternalRedirect } from '@/lib/auth/redirect';
import { authScreenHref, resolveAuthSelection } from '@/lib/billing/review-selection';
import { hasAuthCookies, isRetryableAuthError } from '@/lib/auth/session';
import { landingPathForRole } from '@/lib/auth/landing';
import { createRecoveryGrant, RECOVERY_HANDOFF_COOKIE } from '@/lib/auth/recovery-server';
import { createRecoveryCookieExchange } from '@/lib/auth/recovery-cookies';

const VID_COOKIE = 'bubaly_vid';
const VID_MAX_AGE = 400 * 24 * 60 * 60;

// Handles the redirect after email confirmation / magic link / OAuth.
// Exchanges the code for a session, then sends the user into the app.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const selection = resolveAuthSelection(url.searchParams, 'next');
  const next = selection.next ?? '/home';
  const retryHref = authScreenHref('/login', selection, true);

  // Recovery needs evidence from this explicit exchange, never a preexisting
  // signed-in account. Ordinary sign-in callbacks retain their session fallback.
  if (url.searchParams.get('next') === '/auth/recovery') {
    const cookieOptions = { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' as const, path: '/auth' };
    const recoveryRedirect = (query: string) => {
      const response = NextResponse.redirect(new URL(`/auth/recovery?${query}`, url.origin));
      response.headers.set('Cache-Control', 'no-store');
      response.headers.set('Referrer-Policy', 'no-referrer');
      return response;
    };
    let exchange: Awaited<ReturnType<typeof createRecoveryCookieExchange>> | undefined;
    try {
      if (!code || code.length > 4096 || url.searchParams.getAll('code').length !== 1 || url.searchParams.has('error')) throw new Error('Invalid recovery code');
      exchange = await createRecoveryCookieExchange();
      const { data, error } = await exchange.client.auth.exchangeCodeForSession(code);
      if (error || typeof data?.session?.access_token !== 'string' || !data.session.access_token) throw new Error('Recovery exchange unavailable');
      const { grant, identity } = await createRecoveryGrant(data.session.access_token);
      const maxAge = Math.min(300, Math.floor((identity.expiresAt - Date.now()) / 1000));
      if (maxAge <= 0) throw new Error('Recovery grant expired');
      const response = recoveryRedirect(`handoff=${createHash('sha256').update(grant).digest('hex')}`);
      exchange.applyTo(response);
      response.cookies.set(RECOVERY_HANDOFF_COOKIE, grant, { ...cookieOptions, maxAge });
      return response;
    } catch {
      const response = recoveryRedirect('error=invalid');
      response.cookies.set(RECOVERY_HANDOFF_COOKIE, '', { ...cookieOptions, maxAge: 0 });
      return response;
    } finally {
      await exchange?.dispose();
    }
  }

  if (code) {
    const supabase = await createServer();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) console.error('[auth-callback] code exchange failed', error);
    if (!error) {
      // Super admins land on the admin console; everyone else on the dashboard.
      // Check the env/code allowlist as well as the DB RPC, so this works even
      // before migration 0008 is applied.
      const { data: { user }, error: userError } = await supabase.auth.getUser();
      if (userError) console.error('[auth-callback] authenticated user lookup failed', userError);

      // The code exchange above already wrote the session cookies, so at this
      // point the visitor IS signed in. A transient failure to read them back
      // must not undo that: bouncing to /login shows the login page to someone
      // who just signed in successfully, which is the surprise logout this
      // whole path exists to prevent.
      //
      // What the failed read costs is only the ROUTING decisions below — the
      // super-admin console and the new-account onboarding detour — so those
      // are skipped and the visitor goes to the ordinary destination. Nothing
      // is granted by that: /admin re-checks super-admin in its own layout and
      // every authenticated page re-resolves the user through
      // `requireUserContext`. A definitive "there is no user" still ends here.
      if (!user) {
        if (userError && isRetryableAuthError(userError)) {
          return NextResponse.redirect(new URL(next, url.origin));
        }
        return NextResponse.redirect(new URL(retryHref, url.origin));
      }
      const { data: dbAdmin, error: adminLookupError } = await supabase.rpc('is_super_admin');
      if (adminLookupError) console.error('[auth-callback] super-admin lookup failed', adminLookupError);
      const isAdmin = isSuperAdminEmail(user.email) || dbAdmin === true;

      // Identity stitch (best-effort): attribute the anonymous visitor spine to
      // this now-known user. Covers the OAuth / magic-link / email-confirm paths;
      // the password paths stitch from the login/signup forms.
      let forkId: string | null = null;
      const anonymousId = request.headers.get('cookie')?.match(/(?:^|; )bubaly_vid=([^;]*)/)?.[1];
      if (user?.email && anonymousId) {
        try {
          const { decision } = await stitchVisitorIdentity(createServiceClient(), {
            anonymousId: decodeURIComponent(anonymousId), email: user.email, userId: user.id,
          });
          if (decision === 'fork') forkId = globalThis.crypto?.randomUUID?.() ?? `v-${Date.now().toString(36)}`;
        } catch { /* never block the redirect */ }
      }

      // Brand-new accounts (no family yet) go through the lightweight profile +
      // PIN onboarding journey first; returning users go straight in. Only when
      // the caller didn't request a specific deep link (next === '/home').
      let destination = isAdmin && next === '/home' ? '/admin' : next;
      if (next === '/home' && user && !isAdmin) {
        const { data: membership, error: membershipError } = await supabase
          .from('family_members').select('family_id, role')
          .eq('user_id', user.id).eq('is_active', true);
        // A failed read is not "this account has no family". It must not send
        // the user to onboarding (which would provision a second family), and
        // it must not send them to /login either — they are signed in. Leave
        // the destination alone; `requireUserContext` resolves or provisions
        // the family when they land.
        if (membershipError) {
          console.error('[auth-callback] membership lookup failed', membershipError);
        } else if (membership.length === 0) {
          destination = '/onboarding';
        // M28: someone who is a GUEST everywhere they belong (the role an
        // extended-family invite uses) lands on the Grandparent Portal instead
        // of the full concierge Home. Only when every membership is a guest one
        // — a grandparent who is also an adult in their own household still
        // gets /home. A landing default only: the sidebar is unchanged and
        // /home stays reachable.
        } else if (membership.every((m) => m.role === 'guest')) {
          destination = landingPathForRole('guest');
        }
      }

      const res = NextResponse.redirect(new URL(destination, url.origin));
      // On a shared-device fork, hand the new person a clean anonymous id.
      if (forkId) res.cookies.set(VID_COOKIE, forkId, { path: '/', maxAge: VID_MAX_AGE, sameSite: 'lax' });
      return res;
    }
  }
  // Nothing above ever signed anyone OUT. Landing here means a sign-in did not
  // HAPPEN — no code at all (a bookmark, a back-navigation, `?error=access_denied`
  // from a provider the user cancelled at), or a code that is expired, already
  // spent, or replayed from an old email.
  //
  // A sign-in that did not happen must not end the session the visitor already
  // has. Tapping a stale magic link while signed in used to answer with a login
  // page that contradicted their own cookies, which is the same "logged out for
  // doing something ordinary" this route exists to prevent. So ask first, and
  // send a visitor who IS signed in where they were going.
  const supabase = await createServer();
  const { data: { user }, error: lookupError } = await supabase.auth.getUser();
  if (user) return NextResponse.redirect(new URL(next, url.origin));
  // Same rule the middleware applies: an unreachable auth server reports the
  // same empty user a signed-out visitor does, so a stored session plus a
  // transient failure is not evidence of a logout.
  if (isRetryableAuthError(lookupError) && hasAuthCookies(cookieNames(request))) {
    console.warn('[auth-callback] auth lookup failed transiently; keeping the session', lookupError);
    return NextResponse.redirect(new URL(next, url.origin));
  }
  // #482 carries the visitor's plan selection onto the auth screen, so send
  // them to that href rather than a bare /login once we know they are NOT
  // signed in.
  return NextResponse.redirect(new URL(retryHref, url.origin));
}

/** Cookie names on the incoming request, for the has-a-session check above. */
function cookieNames(request: Request): string[] {
  return (request.headers.get('cookie') ?? '')
    .split(';')
    .map((part) => part.split('=')[0]?.trim() ?? '')
    .filter(Boolean);
}
