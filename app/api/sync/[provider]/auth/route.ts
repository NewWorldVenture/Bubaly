import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { getAdapter } from '@/lib/sync/registry';
import type { SyncProviderEnum } from '@/lib/database.types';

// Provider-generic OAuth start (R9): resolves the adapter from the registry and
// redirects to its consent screen — Microsoft works today, future adapters plug
// in with zero route changes. (Google keeps its original static routes; Next
// prefers static segments, so /api/sync/google/auth is unaffected.)
// Register "<origin>/api/sync/<provider>/callback" in the provider's console.
export async function GET(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const ctx = await requireUserContext();
  const origin = req.nextUrl.origin;
  const { provider: raw } = await params;
  const provider = raw as SyncProviderEnum;

  const adapter = getAdapter(provider);
  if (!adapter) {
    return NextResponse.redirect(new URL(`/dashboard/sync/accounts/${raw}?error=not_configured`, origin));
  }
  if (!adapter.isConfigured()) {
    return NextResponse.redirect(new URL(`/dashboard/sync/accounts/${raw}?error=not_configured`, origin));
  }

  // Env override (e.g. MICROSOFT_SYNC_REDIRECT_URI) wins — needed when the app
  // sits behind a proxy/custom domain; otherwise derive from the request origin.
  const redirectUri = process.env[`${provider.toUpperCase()}_SYNC_REDIRECT_URI`]
    || `${origin}/api/sync/${provider}/callback`;
  // State binds the flow to the signed-in user; the callback re-checks it against
  // the live session, so a pasted/forged state can't attach tokens to someone else.
  const state = Buffer.from(JSON.stringify({ userId: ctx.user.id, familyId: ctx.active.familyId })).toString('base64url');
  return NextResponse.redirect(adapter.authUrl(redirectUri, state));
}
