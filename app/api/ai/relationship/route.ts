import { NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { createServer } from '@/lib/supabase/server';
import { settleAll } from '@/lib/supabase/settle';
import { requireUserContext } from '@/lib/supabase/auth';
import { resolveProvider } from '@/lib/ai/provider';
import { withAiRequest } from '@/lib/ai/observability';
import { scopeFromUserContext } from '@/lib/services/scope';
import { isMissingRelationError } from '@/lib/supabase/errors';
import { logAudit } from '@/lib/server/audit';
import { enforceAIRateLimit } from '@/lib/server/ai-rate-limit';
import { upcomingDates, formatCountdown, milestoneLabel, type RelDate } from '@/lib/relationship/dates';
import {
  buildRelationshipDigestPrompt, parseRelationshipDigest, suggestGiftsFromWishlist,
  buildRelationshipGiftHistory, RELATIONSHIP_GIFT_HISTORY_LIMIT,
  type WishItemLite, type RelationshipDigestContext,
} from '@/lib/relationship/gifts';

// A family can generate this many AI digests per day. Generous for normal use,
// but a guard against runaway cost / abuse.
const RELATIONSHIP_AI_DAILY_LIMIT = 20;
const AI_AUDIT_ACTION = 'relationship_ai_digest';

// POST /api/ai/relationship — the Relationship Helper digest. Reads upcoming
// dates + partner preferences + wishlist + recorded gift outcomes, then asks the AI for
// warm, specific nudges and tailored gift ideas. Returns structured JSON.
export async function POST() {
  const t = await getTranslations();
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;
    const supabase = await createServer();
    const limited = await enforceAIRateLimit(supabase, `ai-relationship:${ctx.user.id}`, { limit: 10 });
    if (!limited.ok) return NextResponse.json(
      { error: t('relationship.tooManyRelationshipHelperRequests') },
      { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
    );

    // Per-day metering (per family), counted from the family audit log.
    const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
    const { count: usedToday } = await supabase
      .from('audit_logs').select('id', { count: 'exact', head: true })
      .eq('family_id', familyId).eq('action', AI_AUDIT_ACTION)
      .gte('created_at', startOfDay.toISOString());
    if ((usedToday ?? 0) >= RELATIONSHIP_AI_DAILY_LIMIT) {
      return NextResponse.json(
        { error: `You've reached today's suggestion limit (${RELATIONSHIP_AI_DAILY_LIMIT}/day). Try again tomorrow.` },
        { status: 429 },
      );
    }

    const [{ data: profile }, { data: dateRows, error: datesErr }] = await settleAll([
      supabase.from('relationship_profile')
        .select('partner_name, partner_member_id, interests, love_languages, gift_budget_cents')
        .eq('family_id', familyId).maybeSingle(),
      supabase.from('relationship_dates')
        .select('id, kind, title, event_date, recurs_annually, reminder_days_before, status')
        .eq('family_id', familyId).neq('status', 'cancelled').limit(200),
    ]);

    if (datesErr && isMissingRelationError(datesErr)) {
      return NextResponse.json({ error: t('relationship.theRelationshipHelperIsnT') }, { status: 503 });
    }

    const dates: RelDate[] = (dateRows ?? []).map((d) => ({
      id: d.id, kind: d.kind, title: d.title, eventDate: d.event_date,
      recursAnnually: d.recurs_annually, reminderDaysBefore: d.reminder_days_before, status: d.status,
    }));
    const upcoming = upcomingDates(dates, { withinDays: 90 }).slice(0, 8).map((u) => ({
      title: u.title, kind: u.kind, countdown: formatCountdown(u.days), milestone: milestoneLabel(u),
    }));

    const recipient = {
      familyId,
      partnerMemberId: profile?.partner_member_id ?? null,
      partnerName: profile?.partner_name ?? null,
    };
    let giftHistory = buildRelationshipGiftHistory(null, recipient);
    if (recipient.partnerMemberId || recipient.partnerName?.trim()) {
      // Same cookie-bound client and active-family scope as the existing UI.
      // One extra row detects incomplete coverage without an unbounded read.
      const { data: giftRows, error: giftError } = await supabase.from('relationship_gift_ideas')
        .select('id, family_id, for_member_id, for_name, title, status, source, wishlist_item_id')
        .eq('family_id', familyId).in('status', ['purchased', 'given'])
        .order('updated_at', { ascending: false }).order('id', { ascending: true })
        .limit(RELATIONSHIP_GIFT_HISTORY_LIMIT + 1);
      giftHistory = buildRelationshipGiftHistory(giftError ? null : giftRows, recipient);
    }

    // Partner's wishlist (if linked) → ranked gift candidates for grounding.
    let wishlist: { title: string; priceCents: number | null }[] = [];
    if (profile?.partner_member_id) {
      const { data: items } = await supabase.from('wishlist_items')
        .select('id, title, url, price, priority, is_purchased, claimed_by')
        .eq('family_id', familyId).eq('member_id', profile.partner_member_id).limit(50);
      wishlist = suggestGiftsFromWishlist((items ?? []) as WishItemLite[], {
        maxBudgetCents: profile.gift_budget_cents ?? null, giftHistory,
      })
        .map((c) => ({ title: c.title, priceCents: c.priceCents }));
    }

    const { system, user } = buildRelationshipDigestPrompt({
      partnerName: profile?.partner_name ?? null,
      upcoming,
      interests: profile?.interests ?? [],
      loveLanguages: profile?.love_languages ?? [],
      giftBudgetCents: profile?.gift_budget_cents ?? null,
      wishlist,
      giftHistory,
    });

    // No partner name on the row: who someone is buying a gift for is not
    // something the request ledger needs to carry.
    const digest = await withAiRequest(
      scopeFromUserContext(ctx, supabase),
      { feature: 'relationship.digest', text: 'Relationship suggestions' },
      async (obs) => {
        const provider = await resolveProvider();
        const completion = await provider.complete({ system, messages: [{ role: 'user', content: user }], tools: [], maxTokens: 700 });
        obs.used(completion.model ?? 'unknown', completion.usage);
        const parsed = parseRelationshipDigest(completion.text || '', giftHistory);
        if (!parsed.headline && parsed.prompts.length === 0 && parsed.giftIdeas.length === 0) {
          obs.failed(new Error('The model returned no headline, prompts or gift ideas.'));
          return null;
        }
        return parsed;
      },
    );
    if (!digest) {
      return NextResponse.json({ error: t('relationship.couldNotGenerateSuggestionsRight') }, { status: 502 });
    }
    // Best-effort metering record (never blocks the response).
    await logAudit(supabase, { familyId, actorId: ctx.user.id, action: AI_AUDIT_ACTION, resource: 'relationship' });
    const context: RelationshipDigestContext = {
      familyId, userId: ctx.user.id, memberId: ctx.active.member.id,
      partnerMemberId: recipient.partnerMemberId, partnerName: recipient.partnerName,
    };
    return NextResponse.json({ digest, context });
  } catch (err) {
    console.error('Relationship AI error:', err);
    return NextResponse.json({ error: t('relationship.somethingWentWrongGeneratingSuggestions') }, { status: 500 });
  }
}
