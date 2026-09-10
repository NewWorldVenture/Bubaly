import { NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { getAdapter } from '@/lib/sync/registry';
import { runProviderSync } from '@/lib/sync/engine/generic';
import type { Json, SyncProviderEnum } from '@/lib/database.types';
import { enforceRequestRateLimit } from '@/lib/server/request-rate-limit';
import { readBoundedRequestText } from '@/lib/server/bounded-request-body';

const MAX_SYNC_REQUEST_BYTES = 4_096;

// Provider-agnostic two-way sync (R9). Runs a sync for the current user's connected
// account of ANY registered provider by resolving the adapter from the registry and
// driving the generic engine. New providers plug in with no route changes.
export async function POST(req: Request) {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const admin = createServiceClient();

  const rawBody = await readBoundedRequestText(req, MAX_SYNC_REQUEST_BYTES);
  if (!rawBody.ok) {
    return NextResponse.json(
      { error: rawBody.reason === 'too_large' ? 'Request body too large.' : 'Unable to read request body.' },
      { status: rawBody.reason === 'too_large' ? 413 : 400 },
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody.text);
  } catch {
    return NextResponse.json({ error: t('run.invalidRequestBody') }, { status: 400 });
  }
  const providerValue = body && typeof body === 'object' && !Array.isArray(body)
    ? (body as { provider?: unknown }).provider
    : undefined;
  const provider = typeof providerValue === 'string' && providerValue.length <= 32
    ? providerValue as SyncProviderEnum
    : undefined;
  if (!provider) return NextResponse.json({ error: t('run.missingOrInvalidProvider') }, { status: 400 });

  const adapter = getAdapter(provider);
  if (!adapter) return NextResponse.json({ error: t('run.unsupportedSyncProvider') }, { status: 400 });
  if (!adapter.isConfigured()) {
    return NextResponse.json({ error: `${adapter.label} sync isn’t configured yet.` }, { status: 503 });
  }

  const { data: account, error: accountError } = await admin
    .from('sync_accounts')
    .select('id, user_id, family_id, external_id')
    .eq('family_id', ctx.active.familyId)
    .eq('provider', provider)
    .eq('user_id', ctx.user.id)
    .maybeSingle();

  if (accountError) {
    console.error('[sync] account read failed', accountError);
    return NextResponse.json({ error: t('sync.syncFailed') }, { status: 503 });
  }
  if (!account) return NextResponse.json({ error: `${adapter.label} is not connected for this account.` }, { status: 400 });

  const limited = await enforceRequestRateLimit(admin, `sync:${ctx.active.familyId}:${ctx.user.id}:${provider}`, { limit: 10 });
  if (!limited.ok) return NextResponse.json(
    { error: t('run.tooManySyncRequestsPlease') },
    { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
  );

  const result = await runProviderSync(admin, account, adapter);

  await admin.from('sync_audit_logs').insert({
    user_id: ctx.user.id, family_id: ctx.active.familyId, provider, action: 'sync',
    detail: result as unknown as Json,
  });

  return NextResponse.json(result, { status: result.error ? 502 : 200 });
}
