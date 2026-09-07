'use server';

// Server actions for the Family Playbook (north-star pillar #3). The "learning"
// runs here: we read real, family-scoped tables (meal plans, grocery list,
// explicit favorites, annual calendar traditions), run the pure inference in
// lib/playbook/learn.ts, and upsert candidate suggestions into
// family_playbook_suggestions. Confirming a suggestion writes a real
// family_facts row (the persistent Knowledge Base) and marks it accepted;
// dismissing hides it. All reads/writes go through the RLS-scoped server client.

import { confirmFact } from '@/lib/services/memory';
import { getTranslations } from '@/lib/i18n/server';
import { scopeFromUserContext } from '@/lib/services/scope';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { learnPlaybook, type PlaybookSignal } from '@/lib/playbook/learn';

type Result = { ok: boolean; error?: string; added?: number };

const DAY = 24 * 60 * 60 * 1000;
const MONTH_FMT: Intl.DateTimeFormatOptions = { month: 'long' };

/** VacationKind → a human "travel style" phrase ('other' is intentionally omitted). */
const TRAVEL_KIND_STYLE: Record<string, string> = {
  road_trip: 'Road trips', flight: 'Flying trips', cruise: 'Cruises',
  theme_park: 'Theme-park getaways', international: 'International travel',
  domestic: 'Domestic trips', staycation: 'Staycations', camping: 'Camping trips',
};

/** Season name from a YYYY-MM-DD date (northern-hemisphere buckets). */
function travelSeason(date: string): string {
  const m = new Date(date).getMonth(); // 0-11
  if (m <= 1 || m === 11) return 'Winter';
  if (m <= 4) return 'Spring';
  if (m <= 7) return 'Summer';
  return 'Fall';
}

/**
 * Mine the household for durable patterns and (idempotently) stock the
 * suggestions inbox. Never resurrects a dismissed/accepted suggestion — new
 * signatures insert as 'suggested', existing ones are left untouched.
 */
export async function refreshPlaybookAction(): Promise<Result> {
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const sb = await createServer();
  const since = new Date(Date.now() - 180 * DAY).toISOString();
  const since3y = new Date(Date.now() - 3 * 365 * DAY).toISOString();

  const signals: PlaybookSignal[] = [];

  // 1) Favorite dinners — meals that appear on the plan repeatedly.
  const { data: plans } = await sb.from('meal_plans')
    .select('meal_id').eq('family_id', familyId).gte('plan_date', since.slice(0, 10)).limit(2000);
  const mealCounts = new Map<string, number>();
  for (const p of plans ?? []) if (p.meal_id) mealCounts.set(p.meal_id, (mealCounts.get(p.meal_id) ?? 0) + 1);
  if (mealCounts.size) {
    const { data: meals } = await sb.from('meals')
      .select('id,name').eq('family_id', familyId).in('id', [...mealCounts.keys()]);
    for (const m of meals ?? []) {
      const count = mealCounts.get(m.id) ?? 0;
      if (m.name) signals.push({ type: 'meal', name: m.name, count });
    }
  }

  // 2) Grocery staples — items added to the list again and again.
  const { data: groceries } = await sb.from('grocery_items')
    .select('name').eq('family_id', familyId).gte('created_at', since).limit(4000);
  const groceryCounts = new Map<string, { name: string; count: number }>();
  for (const g of groceries ?? []) {
    const key = (g.name ?? '').trim().toLowerCase();
    if (!key) continue;
    const cur = groceryCounts.get(key) ?? { name: g.name!, count: 0 };
    cur.count += 1; groceryCounts.set(key, cur);
  }
  for (const { name, count } of groceryCounts.values()) signals.push({ type: 'grocery', name, count });

  // 3) Explicit family favorites (already curated by the family).
  const { data: favs } = await sb.from('family_favorites')
    .select('kind,name,member_id,rating').eq('family_id', familyId).limit(500);
  for (const f of favs ?? []) {
    if (f.name) signals.push({ type: 'favorite', kind: f.kind ?? 'thing', name: f.name, memberId: f.member_id, rating: f.rating });
  }

  // 4) Annual traditions — same-titled events recurring across multiple years.
  const { data: events } = await sb.from('calendar_events')
    .select('title,starts_at,recurrence').eq('family_id', familyId).gte('starts_at', since3y).limit(4000);
  const byTitle = new Map<string, { title: string; years: Set<number>; earliest: string; yearly: boolean }>();
  for (const e of events ?? []) {
    const key = (e.title ?? '').trim().toLowerCase();
    if (!key || !e.starts_at) continue;
    const yr = new Date(e.starts_at).getFullYear();
    const cur = byTitle.get(key) ?? { title: e.title!, years: new Set<number>(), earliest: e.starts_at, yearly: false };
    cur.years.add(yr);
    if (e.starts_at < cur.earliest) cur.earliest = e.starts_at;
    if (e.recurrence === 'yearly') cur.yearly = true;
    byTitle.set(key, cur);
  }
  for (const t of byTitle.values()) {
    const years = t.yearly ? Math.max(2, t.years.size) : t.years.size;
    if (years < 2) continue;
    const when = new Date(t.earliest).toLocaleDateString('en-US', MONTH_FMT);
    signals.push({ type: 'tradition', title: t.title, when, years });
  }

  // 5) Travel style — recurring trip kind + season across the family's vacations.
  const { data: trips } = await sb.from('vacations')
    .select('kind,start_date').eq('family_id', familyId).limit(500);
  const styleCounts = new Map<string, number>();
  const bump = (style: string) => styleCounts.set(style, (styleCounts.get(style) ?? 0) + 1);
  for (const v of trips ?? []) {
    const kindStyle = TRAVEL_KIND_STYLE[v.kind as string];
    if (kindStyle) bump(kindStyle);
    if (v.start_date) bump(`${travelSeason(v.start_date)} trips`);
  }
  for (const [style, count] of styleCounts) signals.push({ type: 'travel', style, count });

  const suggestions = learnPlaybook(signals);
  if (!suggestions.length) return { ok: true, added: 0 };

  const rows = suggestions.map((s) => ({
    family_id: familyId,
    member_id: s.memberId,
    category: s.category,
    label: s.label,
    value: s.value,
    evidence: s.evidence,
    confidence: s.confidence,
    signature: s.signature,
    status: 'suggested',
    created_by: ctx.user.id,
  }));

  // ignoreDuplicates: never overwrite an existing suggestion (esp. accepted/dismissed).
  const { error } = await sb.from('family_playbook_suggestions')
    .upsert(rows, { onConflict: 'family_id,signature', ignoreDuplicates: true });
  if (error) return { ok: false, error: error.message };
  return { ok: true, added: rows.length };
}

/**
 * Confirm a suggestion → write a real family_facts row + mark it accepted.
 *
 * This used to be a second implementation of `confirmFact`, and the two had
 * drifted in three ways that all mattered: it wrote the provenance marker as a
 * hardcoded string rather than the shared constant (so 0265's `source` column
 * would have defaulted to 'user' here and a fact accepted from THIS page would
 * have been invisible to "clear what Bubaly learned"); it had no manager
 * check, while the settings panel's accept requires one; and neither its read
 * nor its update carried `.eq('family_id', …)`, leaning entirely on RLS —
 * which 0123/0126 grant to every member for all four verbs.
 *
 * One accept, one set of rules. The service owns them.
 */
export async function acceptSuggestionAction(input: { id: string }): Promise<Result> {
  const tr = await getTranslations();
  const ctx = await requireUserContext();
  const id = String(input?.id || '').trim();
  if (!id) return { ok: false, error: tr('playbookActions.missingSuggestion') };
  const scope = scopeFromUserContext(ctx, await createServer());
  const res = await confirmFact(scope, id);
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

/** Dismiss a suggestion (kept, so it isn't re-suggested on the next refresh). */
export async function dismissSuggestionAction(input: { id: string }): Promise<Result> {
  const tr = await getTranslations();
  await requireUserContext();
  const id = String(input?.id || '').trim();
  if (!id) return { ok: false, error: tr('playbookActions.missingSuggestion') };
  const sb = await createServer();
  const { error } = await sb.from('family_playbook_suggestions').update({ status: 'dismissed' }).eq('id', id);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
