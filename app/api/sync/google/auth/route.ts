import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { googleAuthUrl } from '@/lib/sync/providers/google';

// Starts the app-level Google OAuth flow for two-way sync (calendar + tasks,
// offline access). Distinct from Supabase login: this obtains a persistent
// refresh token stored encrypted in sync_tokens. The redirect URI is derived
// from the request origin so it stays consistent through the token exchange —
// register exactly "<origin>/api/sync/google/callback" in the Google console.
export async function GET(req: NextRequest) {
  const ctx = await requireUserContext();
  const origin = req.nextUrl.origin;

  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return NextResponse.redirect(new URL('/dashboard/sync/accounts/google?error=not_configured', origin));
  }

  const redirectUri = `${origin}/api/sync/google/callback`;
  const state = Buffer.from(JSON.stringify({ userId: ctx.user.id, familyId: ctx.active.familyId })).toString('base64url');
  return NextResponse.redirect(googleAuthUrl(redirectUri, state));
}
