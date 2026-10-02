import { NextRequest, NextResponse } from 'next/server';
import { assertFamilyAIAllowance, accessDeniedResponse } from '@/lib/server/ai-access';
import { getTranslations } from '@/lib/i18n/server';
import { createServiceClient } from '@/lib/supabase/server';
import { settleAll, describeReadError } from '@/lib/supabase/settle';
import { resolveProvider, isAIConfigured } from '@/lib/ai/provider';
import { rateLimit, clientIp } from '@/lib/server/rate-limit';
import { rateLimitDb } from '@/lib/server/rate-limit-db';
import { buildGiftAssistPrompt, parseGiftSuggestions } from '@/lib/wallet/gift-ai';
import { MAX_PROVIDER_JSON_BYTES, readBoundedRequestJson } from '@/lib/server/bounded-request-body';

// POST /api/ai/gift — PUBLIC AI Gift Assistant for the gift-link page.
// Givers aren't signed in, so this is unauthenticated: it's rate-limited per IP
// and only ever reads a single gift link by its (already-secret) token. It
// returns warm message drafts + suggested amounts. Its one write is the
// `ai_requests` row that counts the call against the family's allowance (F19).
export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const t = await getTranslations();
  // Tight limit: a public, model-backed endpoint. 5 requests/minute/IP.
  // AI-2: per-instance in-memory gate first (cheap), then a durable, cross-instance
  // limit via Postgres so the cap holds under horizontal scale.
  const ip = clientIp(req.headers);
  const limited = rateLimit(`ai-gift:${ip}`, { limit: 5, windowMs: 60_000 });
  const rejected = (retryAfter: number) => NextResponse.json(
    { error: t('gift.pleaseWaitAMomentBefore') },
    { status: 429, headers: { 'Retry-After': String(retryAfter) } },
  );
  if (!limited.ok) return rejected(limited.retryAfter);

  const supabase = createServiceClient();
  const durable = await rateLimitDb(supabase, `ai-gift:${ip}`, { limit: 5, windowMs: 60_000 });
  if (!durable.ok) return rejected(durable.retryAfter);

  const boundedBody = await readBoundedRequestJson(req, MAX_PROVIDER_JSON_BYTES);
  if (!boundedBody.ok) return NextResponse.json({ error: boundedBody.reason === 'too_large' ? 'Request body is too large.' : 'Bad request' }, { status: 400 });
  const body = (boundedBody.value ?? {}) as { token?: string; relationship?: string };
  const token = typeof body.token === 'string' ? body.token : '';
  if (!token) return NextResponse.json({ error: t('gift.missingGiftLink') }, { status: 400 });
  const relationship = typeof body.relationship === 'string' ? body.relationship.slice(0, 40).trim() || null : null;

  // No key: say so before any work, rather than let the provider's throw
  // reach the catch below as a generic failure.
  if (!(await isAIConfigured())) return NextResponse.json({ error: t('ai.theAiEngineIsnT'), code: 'not_configured' }, { status: 503 });
  // The twin of C1-S9-31, in the same feature: /pay/<handle> redirects here.
  // A refused read left `link` null and produced "This gift link is no longer
  // available" to someone outside the family trying to send money — a dead end
  // over what may be transient, with nothing suggesting a retry. Unchanged for
  // a link that is genuinely gone or deactivated. Audit C1-S9-40.
  const { data: link, error: linkError } = await supabase
    .from('gift_links')
    .select('id, is_active, occasion, child_wallet_id, family_id')
    .eq('token', token)
    .maybeSingle();
  if (linkError) {
    console.error('[ai/gift] gift link read failed', { error: describeReadError(linkError) });
    return NextResponse.json({ error: t('gift.giftDataIsTemporarilyUnavailable') }, { status: 503 });
  }
  if (!link || !link.is_active) return NextResponse.json({ error: t('gift.thisGiftLinkIsNo') }, { status: 404 });

  // Resolve the child's first name + their top active goal (kept minimal).
  let childName = 'the child';
  let goalTitle: string | null = null;
  let goalSavedCents: number | null = null;
  let goalTargetCents: number | null = null;

  if (link.child_wallet_id) {
    const [{ data: cw }, { data: goal }] = await settleAll([
      supabase.from('child_wallets').select('member_id').eq('id', link.child_wallet_id).maybeSingle(),
      supabase.from('wallet_goals')
        .select('title, saved_cents, target_cents')
        .eq('family_id', link.family_id).eq('child_wallet_id', link.child_wallet_id).eq('status', 'active')
        .order('target_cents', { ascending: false }).limit(1).maybeSingle(),
    ]);
    if (cw?.member_id) {
      const { data: m } = await supabase.from('family_members').select('display_name').eq('id', cw.member_id).maybeSingle();
      if (m?.display_name) childName = m.display_name.split(' ')[0] || m.display_name;
    }
    if (goal) { goalTitle = goal.title; goalSavedCents = goal.saved_cents; goalTargetCents = goal.target_cents; }
  }

  let requestId: string | null = null;
  try {
    const { system, user } = buildGiftAssistPrompt({
      childName, occasion: link.occasion, relationship, goalTitle, goalSavedCents, goalTargetCents,
    });
    // F19: the family whose link this is pays for the model call, so it counts
    // against that family's monthly allowance — checked, and then RECORDED
    // before the provider is called. The allowance is a count of this family's
    // `ai_requests` rows, so a check with no row behind it let a family at 9 of
    // 10 stay at 9 and call again without end. The giver is not signed in, so
    // the row names no requester; the family is the link's. If the row cannot
    // be written the call is refused: a request the allowance cannot see is
    // the unmetered call F19 closes.
    const allowance = await assertFamilyAIAllowance(supabase, link.family_id);
    if (!allowance.ok) return accessDeniedResponse(allowance);
    const { data: recorded, error: recordError } = await supabase
      .from('ai_requests')
      .insert({
        family_id: link.family_id,
        requested_by: null,
        requested_by_member_id: null,
        kind: 'feature',
        feature: 'gift',
        request_text: 'gift:suggestions',
        status: 'executing',
        started_at: new Date().toISOString(),
      })
      .select('id')
      .single();
    if (recordError || !recorded) {
      console.error('[ai/gift] could not record the request against the allowance', recordError);
      return NextResponse.json({ error: t('gift.couldNotGenerateIdeasRight') }, { status: 503 });
    }
    requestId = recorded.id as string;
    const provider = await resolveProvider();
    const completion = await provider.complete({ system, messages: [{ role: 'user', content: user }], tools: [], maxTokens: 500 });
    const suggestions = parseGiftSuggestions(completion.text || '');
    if (suggestions.messages.length === 0) {
      await settleRequest(supabase, requestId, 'failed', 'no suggestions parsed');
      return NextResponse.json({ error: t('gift.couldNotThinkOfIdeas') }, { status: 502 });
    }
    await settleRequest(supabase, requestId, 'completed', null);
    return NextResponse.json(suggestions);
  } catch (err) {
    console.error('AI gift assistant error:', err);
    if (requestId) await settleRequest(supabase, requestId, 'failed', 'provider error');
    return NextResponse.json({ error: t('gift.couldNotGenerateIdeasRight') }, { status: 500 });
  }
}

// Closing the row is bookkeeping: the request already counts from the moment it
// was opened, so a failure here is logged and never changes the answer.
async function settleRequest(
  supabase: ReturnType<typeof createServiceClient>,
  id: string,
  status: 'completed' | 'failed',
  error: string | null,
): Promise<void> {
  const { data, error: writeError } = await supabase
    .from('ai_requests')
    .update({ status, error, completed_at: new Date().toISOString() })
    .eq('id', id)
    .select('id');
  if (writeError || !data?.length) console.error('[ai/gift] could not close the request row', writeError ?? 'no row matched');
}
