import { NextResponse } from 'next/server';
import { createServer, createServiceClient } from '@/lib/supabase/server';
import { isSuperAdminEmail } from '@/lib/constants/super-admins';
import { stitchVisitorIdentity } from '@/lib/marketing/identity';
import { safeInternalRedirect } from '@/lib/auth/redirect';
import { landingPathForRole } from '@/lib/auth/landing';

const VID_COOKIE = 'bubaly_vid';
const VID_MAX_AGE = 400 * 24 * 60 * 60;

// Handles the redirect after email confirmation / magic link / OAuth.
// Exchanges the code for a session, then sends the user into the app.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const next = safeInternalRedirect(url.searchParams.get('next'), '/home');

  if (code) {
    const supabase = await createServer();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      // Super admins land on the admin console; everyone else on the dashboard.
      // Check the env/code allowlist as well as the DB RPC, so this works even
      // before migration 0008 is applied.
      const { data: { user }, error: userError } = await supabase.auth.getUser();
      if (userError || !user) {
        if (userError) console.error('[auth-callback] authenticated user lookup failed', userError);
        return NextResponse.redirect(new URL('/login?error=auth', url.origin));
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
        if (membershipError) {
          console.error('[auth-callback] membership lookup failed', membershipError);
          return NextResponse.redirect(new URL('/login?error=auth', url.origin));
        }
        if (membership.length === 0) destination = '/onboarding';
        // M28: someone who is a GUEST everywhere they belong (the role an
        // extended-family invite uses) lands on the Grandparent Portal instead
        // of the full concierge Home. Only when every membership is a guest one
        // — a grandparent who is also an adult in their own household still
        // gets /home. A landing default only: the sidebar is unchanged and
        // /home stays reachable.
        else if (membership.every((m) => m.role === 'guest')) {
          destination = landingPathForRole('guest');
        }
      }

      const res = NextResponse.redirect(new URL(destination, url.origin));
      // On a shared-device fork, hand the new person a clean anonymous id.
      if (forkId) res.cookies.set(VID_COOKIE, forkId, { path: '/', maxAge: VID_MAX_AGE, sameSite: 'lax' });
      return res;
    }
  }
  return NextResponse.redirect(new URL('/login?error=auth', url.origin));
}
