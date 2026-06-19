import { NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { getGoogleOAuthUrl } from '@/lib/google';

// Redirects user to Google's OAuth consent screen requesting Calendar read scope.
export async function GET() {
  const ctx = await requireUserContext();
  const state = Buffer.from(JSON.stringify({ userId: ctx.user.id, familyId: ctx.active.familyId })).toString('base64url');
  return NextResponse.redirect(getGoogleOAuthUrl(state));
}
