import { NextResponse } from 'next/server';
import { createServer } from '@/lib/supabase/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { resolveProvider } from '@/lib/ai/provider';
import { isMissingRelationError } from '@/lib/supabase/errors';
import { logAudit } from '@/lib/server/audit';
import { upcomingDates, formatCountdown, milestoneLabel, type RelDate } from '@/lib/relationship/dates';
import {
  buildRelationshipDigestPrompt, parseRelationshipDigest, suggestGiftsFromWishlist,
  type WishItemLite,
} from '@/lib/relationship/gifts';

// A family can generate this many AI digests per day. Generous for normal use,
// but a guard against runaway cost / abuse.
const RELATIONSHIP_AI_DAILY_LIMIT = 20;
const AI_AUDIT_ACTION = 'relationship_ai_digest';

// POST /api/ai/relationship — the Relationship Helper digest. Reads upcoming
// dates + partner preferences + the partner's wishlist, then asks the AI for
// warm, specific nudges and tailored gift ideas. Returns structured JSON.
export async function POST() {
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;
    const supabase = await createServer();

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

    const [{ data: profile }, { data: dateRows, error: datesErr }] = await Promise.all([
      supabase.from('relationship_profile')
        .select('partner_name, partner_member_id, interests, love_languages, gift_budget_cents')
        .eq('family_id', familyId).maybeSingle(),
      supabase.from('relationship_dates')
        .select('id, kind, title, event_date, recurs_annually, reminder_days_before, status')
        .eq('family_id', familyId).neq('status', 'cancelled').limit(200),
    ]);

    if (datesErr && isMissingRelationError(datesErr)) {
      return NextResponse.json({ error: 'The Relationship Helper isn’t set up on this database yet.' }, { status: 503 });
    }

    const dates: RelDate[] = (dateRows ?? []).map((d) => ({
      id: d.id, kind: d.kind, title: d.title, eventDate: d.event_date,
      recursAnnually: d.recurs_annually, reminderDaysBefore: d.reminder_days_before, status: d.status,
    }));
    const upcoming = upcomingDates(dates, { withinDays: 90 }).slice(0, 8).map((u) => ({
      title: u.title, kind: u.kind, countdown: formatCountdown(u.days), milestone: milestoneLabel(u),
    }));

    // Partner's wishlist (if linked) → ranked gift candidates for grounding.
    let wishlist: { title: string; priceCents: number | null }[] = [];
    if (profile?.partner_member_id) {
      const { data: items } = await supabase.from('wishlist_items')
        .select('id, title, url, price, priority, is_purchased, claimed_by')
        .eq('family_id', familyId).eq('member_id', profile.partner_member_id).limit(50);
      wishlist = suggestGiftsFromWishlist((items ?? []) as WishItemLite[], { maxBudgetCents: profile.gift_budget_cents ?? null })
        .map((c) => ({ title: c.title, priceCents: c.priceCents }));
    }

    const { system, user } = buildRelationshipDigestPrompt({
      partnerName: profile?.partner_name ?? null,
      upcoming,
      interests: profile?.interests ?? [],
      loveLanguages: profile?.love_languages ?? [],
      giftBudgetCents: profile?.gift_budget_cents ?? null,
      wishlist,
    });

    const provider = await resolveProvider();
    const completion = await provider.complete({ system, messages: [{ role: 'user', content: user }], tools: [], maxTokens: 700 });
    const digest = parseRelationshipDigest(completion.text || '');
    if (!digest.headline && digest.prompts.length === 0 && digest.giftIdeas.length === 0) {
      return NextResponse.json({ error: 'Could not generate suggestions right now. Please try again.' }, { status: 502 });
    }
    // Best-effort metering record (never blocks the response).
    await logAudit(supabase, { familyId, actorId: ctx.user.id, action: AI_AUDIT_ACTION, resource: 'relationship' });
    return NextResponse.json({ digest });
  } catch (err) {
    console.error('Relationship AI error:', err);
    return NextResponse.json({ error: 'Something went wrong generating suggestions.' }, { status: 500 });
  }
}
