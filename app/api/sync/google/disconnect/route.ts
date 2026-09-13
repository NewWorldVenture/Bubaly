import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { getRefreshToken } from '@/lib/sync/accounts';
import { revokeToken } from '@/lib/sync/providers/google';
import { logSyncAudit } from '@/lib/sync/audit';

// Revokes the Google grant and removes the connected account (cascades tokens,
// connections, and external mappings). Imported calendars/events are kept.
export async function POST(req: NextRequest) {
  const ctx = await requireUserContext();
  const admin = createServiceClient();

  const { data: account } = await admin
    .from('sync_accounts')
    .select('id')
    .eq('family_id', ctx.active.familyId)
    .eq('provider', 'google')
    .eq('user_id', ctx.user.id)
    .maybeSingle();

  if (account) {
    const refresh = await getRefreshToken(admin, account.id).catch(() => null);
    if (refresh) await revokeToken(refresh);
    // Same as the provider-generic route: this delete is the disconnect, and
    // the redirect below lands on "Account disconnected and access revoked."
    // A discarded error made that sentence unconditional.
    const { error: deleteError } = await admin.from('sync_accounts').delete().eq('id', account.id);
    if (deleteError) {
      console.error('[sync] google disconnect could not delete the account row', deleteError);
      return NextResponse.redirect(
        new URL('/dashboard/sync/accounts/google?error=disconnect_failed', req.nextUrl.origin));
    }
    await logSyncAudit(admin, {
      user_id: ctx.user.id, family_id: ctx.active.familyId, provider: 'google', action: 'disconnect',
    });
  }

  return NextResponse.redirect(new URL('/dashboard/sync/accounts/google?disconnected=1', req.nextUrl.origin));
}
