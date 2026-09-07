import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { createServiceClient } from '@/lib/supabase/server';
import { settleAll } from '@/lib/supabase/settle';
import { resolveProvider } from '@/lib/ai/provider';
import { rateLimit, clientIp } from '@/lib/server/rate-limit';
import { rateLimitDb } from '@/lib/server/rate-limit-db';
import { buildGiftAssistPrompt, parseGiftSuggestions } from '@/lib/wallet/gift-ai';
import { MAX_PROVIDER_JSON_BYTES, readBoundedRequestJson } from '@/lib/server/bounded-request-body';

// POST /api/ai/gift — PUBLIC AI Gift Assistant for the gift-link page.
// Givers aren't signed in, so this is unauthenticated: it's rate-limited per IP
// and only ever reads a single gift link by its (already-secret) token. It
// returns warm message drafts + suggested amounts; it never writes anything.
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

  const { data: link } = await supabase
    .from('gift_links')
    .select('id, is_active, occasion, child_wallet_id, family_id')
    .eq('token', token)
    .maybeSingle();
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

  try {
    const { system, user } = buildGiftAssistPrompt({
      childName, occasion: link.occasion, relationship, goalTitle, goalSavedCents, goalTargetCents,
    });
    const provider = await resolveProvider();
    const completion = await provider.complete({ system, messages: [{ role: 'user', content: user }], tools: [], maxTokens: 500 });
    const suggestions = parseGiftSuggestions(completion.text || '');
    if (suggestions.messages.length === 0) {
      return NextResponse.json({ error: t('gift.couldNotThinkOfIdeas') }, { status: 502 });
    }
    return NextResponse.json(suggestions);
  } catch (err) {
    console.error('AI gift assistant error:', err);
    return NextResponse.json({ error: t('gift.couldNotGenerateIdeasRight') }, { status: 500 });
  }
}
