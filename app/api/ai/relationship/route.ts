import { NextResponse } from 'next/server';
import { refuseClosedOrTrialEnded } from '@/lib/server/account-standing';
import { getTranslations } from '@/lib/i18n/server';
import { createServer, createServiceClient } from '@/lib/supabase/server';
import { settleAll, describeReadError } from '@/lib/supabase/settle';
import { requireUserContext } from '@/lib/supabase/auth';
import { resolveProvider, isAIConfigured, describeAIError } from '@/lib/ai/provider';
import { withAiRequest } from '@/lib/ai/observability';
import { scopeFromUserContext, dayKeyInTz, todayKeyFor, zonedDayBoundsMs } from '@/lib/services/scope';
import { isMissingRelationError } from '@/lib/supabase/errors';
import { logAudit } from '@/lib/server/audit';
import { enforceAIRateLimit } from '@/lib/server/ai-rate-limit';
import { refuseIfLocked } from '@/lib/server/route-feature-gate';
import { accessDeniedResponse, assertAIAllowance } from '@/lib/server/ai-access';
import { upcomingDates, formatCountdown, milestoneLabel, type RelDate } from '@/lib/relationship/dates';
import {
  buildRelationshipDigestPrompt, parseRelationshipDigest, suggestGiftsFromWishlist,
  buildRelationshipGiftHistory, RELATIONSHIP_GIFT_HISTORY_LIMIT,
  type WishItemLite, type RelationshipDigestContext, type RelationshipGiftHistory,
} from '@/lib/relationship/gifts';

// A family can generate this many AI digests per day. Generous for normal use,
// but a guard against runaway cost / abuse.
const RELATIONSHIP_AI_DAILY_LIMIT = 20;
const AI_AUDIT_ACTION = 'relationship_ai_digest';
/** The `feature` the digest's request row is filed under (withAiRequest below): what the daily cap counts. */
const AI_REQUEST_FEATURE = 'relationship.digest';

// POST /api/ai/relationship — the Relationship Helper digest. Reads upcoming
// dates + partner preferences + wishlist + recorded gift outcomes, then asks the AI for
// warm, specific nudges and tailored gift ideas. Returns structured JSON.
export async function POST() {
  const t = await getTranslations();
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;
    const supabase = await createServer();
    // A closed or trial-ended family is refused before any work: see lib/server/account-standing.ts.
    const refused = await refuseClosedOrTrialEnded(supabase, familyId);
    if (refused) return refused;
    // With no key the provider threw "not configured" and the catch below
    // answered a generic 500; the other AI routes say so with a 503 first.
    if (!(await isAIConfigured())) return NextResponse.json({ error: t('ai.theAiEngineIsnT'), code: 'not_configured' }, { status: 503 });
    // The page is behind the layout's paywall and this endpoint was not: a
    // family whose trial ended unpaid could still buy model calls here.
    const locked = await refuseIfLocked(supabase, familyId);
    if (locked) return locked;
    const limited = await enforceAIRateLimit(supabase, `ai-relationship:${ctx.user.id}`, { limit: 10 });
    if (!limited.ok) return NextResponse.json(
      { error: t('relationship.tooManyRelationshipHelperRequests') },
      { status: 429, headers: { 'Retry-After': String(limited.retryAfter) } },
    );

    // Per-day metering (per family), counted from the server's own record of
    // each digest. The family's midnight, not the host's. This bound is the daily AI
    // quota window: on a UTC host `setHours(0,0,0,0)` rolls over at 17:00 in
    // California and 11:00 in Sydney, so a household's allowance reset in the
    // middle of their afternoon and calls made after it were counted against
    // tomorrow. Same defect and same fix as the kitchen display
    // (app/(app)/display/page.tsx:122).
    const startOfDay = new Date(zonedDayBoundsMs(dayKeyInTz(new Date(), ctx.active.family.timezone || 'UTC'), ctx.active.family.timezone || 'UTC').start);
    // Counted with the service client, scoped to this family and this helper.
    // Through a teen's, a child's, a caregiver's or a guest's own client the
    // meter's rows were hidden (audit_logs reads for a manager only, 0118's
    // `audit_select`) and the count came back 0 with no error, so the family's
    // daily cap never applied to them.
    //
    // The rows are the `ai_requests` rows withAiRequest files below, of kind
    // 'feature' and settled 'completed' when a digest came back. The meter
    // counted `audit_logs` rows with this action from ANY actor, and any member
    // may append to that trail as themselves with any action and any
    // created_at (audit_insert, 0380), so a child or a guest could plant twenty
    // and the parents were refused for the day (household-roles
    // N5-R1-RELATIONSHIP-METER-FORGEABLE). A member may file only a 'concierge'
    // request, 'queued' (0255's ai_requests_insert), and nothing lets a member
    // update one, so no row a member writes is counted — nor one whose author's
    // login is later deleted, as a null-actor audit row would be (on delete set null).
    const { count: usedToday, error: meterError } = await createServiceClient()
      .from('ai_requests').select('id', { count: 'exact', head: true })
      .eq('family_id', familyId).eq('kind', 'feature').eq('feature', AI_REQUEST_FEATURE).eq('status', 'completed')
      .gte('created_at', startOfDay.toISOString());
    // An unreadable meter is not "none used": that answer lifted the daily
    // limit, and every call behind it is a paid model call.
    if (meterError || usedToday === null) {
      console.error('[ai-relationship] usage meter read failed', meterError);
      return NextResponse.json({ error: t('relationship.theRelationshipHelperIsnT') }, { status: 503 });
    }
    if (usedToday >= RELATIONSHIP_AI_DAILY_LIMIT) {
      return NextResponse.json(
        { error: t('relationship.suggestionDailyLimitReached', { limit: RELATIONSHIP_AI_DAILY_LIMIT }) },
        { status: 429 },
      );
    }
    // The digest files an `ai_requests` row (withAiRequest below), so the Free
    // plan's monthly AI allowance applies here as on every other helper: the
    // twenty a day above was this helper's only limit, and a Free family past
    // its ten got an eleventh call and an eleventh row. The allowance alone:
    // whether the helper is available is the paywall above, as the page has no
    // tier of its own.
    const access = await assertAIAllowance(ctx, { db: supabase });
    if (!access.ok) return accessDeniedResponse(access);

    const [{ data: profile, error: profileErr }, { data: dateRows, error: datesErr }] = await settleAll([
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

    // The dates guard above was INVERTED with respect to risk: it caught the one
    // error that means "this feature is not installed yet" and let every real
    // one through to `dateRows ?? []`. An empty list is not a neutral default
    // here — `upcomingDates` then finds nothing, and a helper whose entire job
    // is "do not forget the anniversary" tells someone their next ninety days
    // are clear. The profile read had no guard at all, and it supplies the
    // partner's name, interests, love languages and gift budget; losing it
    // yields a confidently generic digest wearing the shape of a personal one.
    // Audit C1-S9-37.
    if (datesErr || profileErr) {
      console.error('[ai/relationship] read failed', {
        familyId,
        dates: datesErr ? describeReadError(datesErr) : null,
        profile: profileErr ? describeReadError(profileErr) : null,
      });
      return NextResponse.json({ error: t('ai.recommendationsAreTemporarilyUnavailable') }, { status: 503 });
    }

    const dates: RelDate[] = (dateRows ?? []).map((d) => ({
      id: d.id, kind: d.kind, title: d.title, eventDate: d.event_date,
      recursAnnually: d.recurs_annually, reminderDaysBefore: d.reminder_days_before, status: d.status,
    }));
    // The family's day. This passed no anchor at all, so it fell through to the
    // server's clock and told the AI an anniversary was "Today" the evening
    // before — which it then wrote gift and date-night suggestions around.
    const upcoming = upcomingDates(dates, todayKeyFor(ctx), { withinDays: 90 }).slice(0, 8).map((u) => ({
      title: u.title, kind: u.kind, countdown: formatCountdown(u.days), milestone: milestoneLabel(u),
    }));

    const recipient = {
      familyId,
      partnerMemberId: profile?.partner_member_id ?? null,
      partnerName: profile?.partner_name ?? null,
    };
    // The partner the gifts are FOR is not told what has been bought for them,
    // nor handed their own wishes ranked with the claimed and bought ones taken
    // out — the module hides both from them, and so does this.
    const viewerIsRecipient = !!recipient.partnerMemberId && recipient.partnerMemberId === ctx.active.member?.id;
    let giftHistory: RelationshipGiftHistory | undefined = viewerIsRecipient ? undefined : buildRelationshipGiftHistory(null, recipient);
    if (!viewerIsRecipient && (recipient.partnerMemberId || recipient.partnerName?.trim())) {
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
    if (profile?.partner_member_id && !viewerIsRecipient) {
      // The wishlist IS the grounding for the gift suggestions below. A refused
      // read used to produce an empty one, and the digest went out recommending
      // gifts while silently ignoring everything the partner actually asked for
      // — indistinguishable, to the reader, from a partner who has asked for
      // nothing. Audit C1-S9-37.
      const { data: items, error: itemsError } = await supabase.from('wishlist_items')
        .select('id, title, url, price, priority, is_purchased, claimed_by')
        .eq('family_id', familyId).eq('member_id', profile.partner_member_id).limit(50);
      if (itemsError) {
        console.error('[ai/relationship] wishlist read failed', { familyId, error: describeReadError(itemsError) });
        return NextResponse.json({ error: t('ai.recommendationsAreTemporarilyUnavailable') }, { status: 503 });
      }
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
    // The household trail's record of the digest, best-effort (never blocks the
    // response). It is not the meter: the request row above is.
    await logAudit(supabase, { familyId, actorId: ctx.user.id, action: AI_AUDIT_ACTION, resource: 'relationship' });
    const context: RelationshipDigestContext = {
      familyId, userId: ctx.user.id, memberId: ctx.active.member.id,
      partnerMemberId: recipient.partnerMemberId, partnerName: recipient.partnerName,
    };
    return NextResponse.json({ digest, context });
  } catch (err) {
    console.error('Relationship AI error:', err);
    // An engine with no key, no credit or no connection is unavailable, as
    // every other AI route answers it — not a server fault behind a 500.
    if (describeAIError(err).code !== 'unknown') {
      return NextResponse.json({ error: t('ai.recommendationsAreTemporarilyUnavailable') }, { status: 503 });
    }
    return NextResponse.json({ error: t('relationship.somethingWentWrongGeneratingSuggestions') }, { status: 500 });
  }
}
