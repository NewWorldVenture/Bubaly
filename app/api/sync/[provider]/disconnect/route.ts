import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { getRefreshToken } from '@/lib/sync/accounts';
import { getAdapter } from '@/lib/sync/registry';
import type { SyncProviderEnum } from '@/lib/database.types';
import { logSyncAudit } from '@/lib/sync/audit';

// Provider-generic disconnect (R9): revokes the grant at the provider (best
// effort) and deletes the account row (cascades tokens, connections, external
// mappings). Imported calendars/events are kept.
export async function POST(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const ctx = await requireUserContext();
  const { provider: raw } = await params;
  const provider = raw as SyncProviderEnum;
  const admin = createServiceClient();

  const adapter = getAdapter(provider);
  const { data: account } = await admin
    .from('sync_accounts')
    .select('id')
    .eq('family_id', ctx.active.familyId)
    .eq('provider', provider)
    .eq('user_id', ctx.user.id)
    .maybeSingle();

  // Revocation is best effort by design, and that is fine — what is not fine is
  // saying it happened when it did not. There are three ways to reach the end of
  // this block having revoked nothing: no adapter for the provider, no refresh
  // token to present, or revokeToken throwing into a swallowing catch. All three
  // used to land on the same "Account disconnected and access revoked." Deleting
  // our row does not withdraw a grant the provider is still holding, so a member
  // who wanted the grant gone is the one person who must not be told it is.
  let revoked = false;
  if (account) {
    if (adapter) {
      const refresh = await getRefreshToken(admin, account.id).catch(() => null);
      if (refresh) {
        revoked = await adapter.revokeToken(refresh).then(() => true).catch(() => false);
      }
    }
    // This delete IS the disconnect — the row is what keeps the account
    // connected and what every sync reads. Its result was discarded, and the
    // redirect below is unconditional, so a refused delete sent the member to a
    // page that says "Account disconnected and access revoked." while the
    // account was still connected and would sync again on the next run. Of
    // everything in this route it is the one write whose failure may not be
    // reported as success: the member's next move after being told access was
    // revoked is to stop thinking about it.
    const { error: deleteError } = await admin.from('sync_accounts').delete().eq('id', account.id);
    if (deleteError) {
      console.error('[sync] disconnect could not delete the account row', deleteError);
      return NextResponse.redirect(
        new URL(`/dashboard/sync/accounts/${raw}?error=disconnect_failed`, req.nextUrl.origin), 303);
    }
    // The account is gone by here, so a missing history row is a gap in the
    // record rather than a false claim. Reported, not fatal.
    await logSyncAudit(admin, {
      user_id: ctx.user.id, family_id: ctx.active.familyId, provider, action: 'disconnect',
    });
  }

  // 303 → the browser follows the POST with a GET.
  const outcome = revoked ? 'disconnected=1' : 'disconnected=kept';
  return NextResponse.redirect(new URL(`/dashboard/sync/accounts/${raw}?${outcome}`, req.nextUrl.origin), 303);
}
