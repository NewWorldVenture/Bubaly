import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { exchangeCode, getGoogleUserEmail, googleSyncRedirectUri } from '@/lib/sync/providers/google';
import { connectAccount } from '@/lib/sync/accounts';
import { hasEncryptionKey } from '@/lib/sync/crypto';

// Google redirects here after consent. Exchanges the code for tokens, fetches the
// account email, and stores everything (tokens AES-256-GCM encrypted) via
// connectAccount. Fails closed if SYNC_TOKEN_KEY is missing.
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const origin = req.nextUrl.origin;
  const code = url.searchParams.get('code');
  const stateRaw = url.searchParams.get('state');
  const oauthError = url.searchParams.get('error');
  const back = (q: string) => NextResponse.redirect(new URL(`/dashboard/sync/accounts/google?${q}`, origin));

  if (oauthError || !code || !stateRaw) return back('error=denied');
  if (!hasEncryptionKey()) return back('error=no_encryption_key');

  try {
    const ctx = await requireUserContext();
    const state = JSON.parse(Buffer.from(stateRaw, 'base64url').toString()) as { userId: string; familyId: string };
    if (state.userId !== ctx.user.id) return back('error=state_mismatch');

    const redirectUri = googleSyncRedirectUri(origin);
    const tokens = await exchangeCode(code, redirectUri);
    const email = await getGoogleUserEmail(tokens.accessToken);

    const admin = createServiceClient();
    await connectAccount(admin, {
      userId: ctx.user.id,
      familyId: ctx.active.familyId,
      provider: 'google',
      externalId: email ?? ctx.user.id,
      displayName: email,
      scope: tokens.scope ?? null,
      tokens,
    });
    await admin.from('sync_audit_logs').insert({
      user_id: ctx.user.id, family_id: ctx.active.familyId, provider: 'google', action: 'connect',
      detail: { email },
    });

    return back('connected=1');
  } catch (err) {
    console.error('Google sync callback error:', err);
    return back('error=connect_failed');
  }
}
