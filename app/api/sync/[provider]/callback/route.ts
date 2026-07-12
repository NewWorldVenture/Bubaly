import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { getAdapter } from '@/lib/sync/registry';
import { connectAccount } from '@/lib/sync/accounts';
import { hasEncryptionKey } from '@/lib/sync/crypto';
import type { SyncProviderEnum } from '@/lib/database.types';

// Provider-generic OAuth callback (R9): exchanges the code via the registry
// adapter, resolves the account identity, and stores everything (tokens
// AES-256-GCM encrypted) via connectAccount. Fails closed without SYNC_TOKEN_KEY.
export async function GET(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const url = new URL(req.url);
  const origin = req.nextUrl.origin;
  const { provider: raw } = await params;
  const provider = raw as SyncProviderEnum;
  const back = (q: string) => NextResponse.redirect(new URL(`/dashboard/sync/accounts/${raw}?${q}`, origin));

  const code = url.searchParams.get('code');
  const stateRaw = url.searchParams.get('state');
  const oauthError = url.searchParams.get('error');

  const adapter = getAdapter(provider);
  if (!adapter || !adapter.isConfigured()) return back('error=not_configured');
  if (oauthError || !code || !stateRaw) return back('error=denied');
  if (!hasEncryptionKey()) return back('error=no_encryption_key');

  try {
    const ctx = await requireUserContext();
    const state = JSON.parse(Buffer.from(stateRaw, 'base64url').toString()) as { userId: string; familyId: string };
    if (state.userId !== ctx.user.id) return back('error=state_mismatch');

    // Must match the auth leg exactly: same env override, same origin fallback.
    const redirectUri = process.env[`${provider.toUpperCase()}_SYNC_REDIRECT_URI`]
      || `${origin}/api/sync/${provider}/callback`;
    const tokens = await adapter.exchangeCode(code, redirectUri);
    const identity = await adapter.getAccountIdentity(tokens.accessToken).catch(() => null);

    const admin = createServiceClient();
    await connectAccount(admin, {
      userId: ctx.user.id,
      familyId: ctx.active.familyId,
      provider,
      externalId: identity ?? ctx.user.id,
      displayName: identity,
      scope: tokens.scope ?? null,
      tokens,
    });
    await admin.from('sync_audit_logs').insert({
      user_id: ctx.user.id, family_id: ctx.active.familyId, provider, action: 'connect',
      detail: { identity },
    });

    return back('connected=1');
  } catch (err) {
    console.error(`${provider} sync callback error:`, err);
    return back('error=connect_failed');
  }
}
