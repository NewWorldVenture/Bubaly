'use server';

// Server actions for the Family Playbook (north-star pillar #3). The "learning"
// runs here: we read real, family-scoped tables (meal plans, grocery list,
// explicit favorites, annual calendar traditions), run the pure inference in
// lib/playbook/learn.ts, and upsert candidate suggestions into
// family_playbook_suggestions. Confirming a suggestion writes a real
// family_facts row (the persistent Knowledge Base) and marks it accepted;
// dismissing hides it. All reads/writes go through the RLS-scoped server client.

import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { learnPlaybook, type PlaybookSignal } from '@/lib/playbook/learn';

type Result = { ok: boolean; error?: string; added?: number };

const DAY = 24 * 60 * 60 * 1000;
const MONTH_FMT: Intl.DateTimeFormatOptions = { month: 'long' };

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

/** Confirm a suggestion → write a real family_facts row + mark it accepted. */
export async function acceptSuggestionAction(input: { id: string }): Promise<Result> {
  const ctx = await requireUserContext();
  const id = String(input?.id || '').trim();
  if (!id) return { ok: false, error: 'Missing suggestion' };
  const sb = await createServer();

  const { data: s, error: readErr } = await sb.from('family_playbook_suggestions')
    .select('*').eq('id', id).maybeSingle();
  if (readErr) return { ok: false, error: readErr.message };
  if (!s) return { ok: false, error: 'Suggestion not found' };
  if (s.status === 'accepted') return { ok: true }; // idempotent

  const { data: fact, error: factErr } = await sb.from('family_facts').insert({
    family_id: s.family_id,
    member_id: s.member_id,
    category: s.category,
    label: s.label,
    value: s.value,
    notes: s.evidence ? `Learned by Bubaly — ${s.evidence}` : 'Learned by Bubaly',
    created_by: ctx.user.id,
  }).select('id').maybeSingle();
  if (factErr) return { ok: false, error: factErr.message };

  const { error: updErr } = await sb.from('family_playbook_suggestions')
    .update({ status: 'accepted', fact_id: fact?.id ?? null }).eq('id', id);
  if (updErr) return { ok: false, error: updErr.message };
  return { ok: true };
}

/** Dismiss a suggestion (kept, so it isn't re-suggested on the next refresh). */
export async function dismissSuggestionAction(input: { id: string }): Promise<Result> {
  await requireUserContext();
  const id = String(input?.id || '').trim();
  if (!id) return { ok: false, error: 'Missing suggestion' };
  const sb = await createServer();
  const { error } = await sb.from('family_playbook_suggestions').update({ status: 'dismissed' }).eq('id', id);
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
