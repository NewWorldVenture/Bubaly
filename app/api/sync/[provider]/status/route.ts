import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { getAdapter } from '@/lib/sync/registry';
import type { SyncProviderEnum } from '@/lib/database.types';

// Provider-generic connection status (R9), so a surface can render the right
// control without knowing anything about the provider.
//
// Two booleans, because the UI needs both and they fail in different ways:
//
//   configured — the server holds this provider's OAuth client credentials.
//                False means no button anywhere can complete a connection; the
//                owner has to register the app first. `/auth` already redirects
//                such a click to the provider's setup page rather than erroring,
//                so reporting it here is what lets the caller SAY so up front
//                instead of sending the user through a redirect to find out.
//   connected  — this user, in this family, already holds an account row.
//
// Never throws for the caller: an unknown provider or a failed read answers
// `{ configured: false, connected: false }` with the reason attached. A status
// probe that 500s would be worse than one that says "not connected" — the
// control it drives is a link, and the link is safe in every state.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider: raw } = await params;
  const provider = raw as SyncProviderEnum;

  const adapter = getAdapter(provider);
  if (!adapter) {
    return NextResponse.json({ configured: false, connected: false, reason: 'unknown_provider' });
  }

  const configured = adapter.isConfigured();

  // Session resolved on its own, so `no_session` stays accurate. Folded into
  // the outer try, a service-client failure would have been reported as a
  // missing session — a diagnostic that sends the next reader to the wrong place.
  let ctx;
  try {
    ctx = await requireUserContext();
  } catch {
    // Signed out, or no active family yet. Not an error worth surfacing: the
    // caller renders "connect", and the auth route sends them to sign in.
    return NextResponse.json({ configured, connected: false, reason: 'no_session' });
  }

  try {
    const admin = createServiceClient();
    const { data, error } = await admin
      .from('sync_accounts')
      .select('id')
      .eq('family_id', ctx.active.familyId)
      .eq('provider', provider)
      .eq('user_id', ctx.user.id)
      .maybeSingle();
    if (error) {
      console.error('[sync-status] account read failed', provider, error);
      return NextResponse.json({ configured, connected: false, reason: 'read_failed' });
    }
    return NextResponse.json({ configured, connected: !!data });
  } catch (cause) {
    // The client could not even be constructed (missing service key, bad URL).
    console.error('[sync-status] status probe unavailable', provider, cause);
    return NextResponse.json({ configured, connected: false, reason: 'unavailable' });
  }
}
