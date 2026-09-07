// lib/autopilot/scan.ts — the server-side Autopilot pass, shared by the
// on-demand route (active family) and the cron runner (all families).
//
// Reads the family's real rows, builds the normalized snapshot, runs the pure
// engine, then reconciles `autopilot_suggestions`: respects prior resolutions,
// clears stale OPEN suggestions whose signal vanished, and auto-executes new
// high-confidence reminders (reversibly — it inserts a real `reminders` row).
import type { SupabaseClient } from '@supabase/supabase-js';
import { settleAll } from '@/lib/supabase/settle';
import type { Database } from '@/lib/database.types';
import { buildSuggestions, confidenceTier, type FamilySnapshot } from '@/lib/autopilot/engine';
import { computeMemberTraits, type MemberTraits, type MemberHistory } from '@/lib/autopilot/twin';
import { notify } from '@/lib/services/notifications';
import { systemScopeForFamily } from '@/lib/services/scope';
import type { ServiceScope } from '@/lib/services/types';

type DB = SupabaseClient<Database>;

export type AutopilotScanResult = { scanned: number; autoExecuted: number; cleared: number; notified: number };

const RESOLVED = new Set(['dismissed', 'snoozed', 'executed', 'approved', 'auto_executed']);

/** Get-or-create the family's active shopping list (mirrors lib/capture/save). */
async function getOrCreateGroceryListId(supabase: DB, familyId: string, userId: string | null): Promise<string | null> {
  const { data: existing, error: lookupError } = await supabase.from('grocery_lists').select('id')
    .eq('family_id', familyId).eq('is_archived', false)
    .order('created_at', { ascending: true }).limit(1).maybeSingle();
  if (lookupError) throw new Error('Autopilot could not read the family shopping list');
  if (existing) return existing.id;
  const { data: created, error: createError } = await supabase.from('grocery_lists')
    .insert({ family_id: familyId, name: 'Shopping List', created_by: userId }).select('id').maybeSingle();
  if (createError || !created?.id) throw new Error('Autopilot could not create the family shopping list');
  return created?.id ?? null;
}

export async function runAutopilotScan(supabase: DB, familyId: string, userId: string | null): Promise<AutopilotScanResult> {
  // Built once, lazily: the scope read costs a query, and most scans produce no
  // notification at all. Null means the family could not be read, and the
  // notification is skipped rather than sent against a guessed timezone —
  // quiet hours evaluated in the wrong zone hold a notice at six in the evening
  // and let one through at two in the morning.
  let notifyScope: ServiceScope | null = null;
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const in30 = new Date(now.getTime() + 30 * 86400000).toISOString().slice(0, 10);
  const in2 = new Date(now.getTime() + 2 * 86400000).toISOString();

  const since60 = new Date(now.getTime() - 8 * 86400000).toISOString().slice(0, 10);
  const since90 = new Date(now.getTime() - 90 * 86400000).toISOString();
  const [
    renewalsResult, apptsResult, choreRowsResult,
    membersResult, groceriesResult, apptRemindersResult,
    eventsResult, subsResult, stressResult, medsResult,
    choreHistoryResult, twinProfilesResult, mealPlansResult, insuranceResult, wishlistResult, existingResult,
  ] = await settleAll([
    supabase.from('renewals').select('id, title, expires_at, status').eq('family_id', familyId).eq('status', 'active').lte('expires_at', in30).limit(100),
    supabase.from('appointments').select('id, title, starts_at, member_id').eq('family_id', familyId).gte('starts_at', `${today}T00:00:00Z`).lte('starts_at', in2).limit(50),
    supabase.from('chore_assignments').select('id, due_at, member_id, status, chores(title)').eq('family_id', familyId).in('status', ['todo', 'in_progress']).lt('due_at', `${today}T00:00:00Z`).limit(100),
    supabase.from('family_members').select('id, display_name, birthday').eq('family_id', familyId).eq('is_active', true).not('birthday', 'is', null).limit(50),
    supabase.from('grocery_items').select('id, name, created_at, is_checked').eq('family_id', familyId).eq('is_checked', false).limit(200),
    supabase.from('reminders').select('related_id').eq('family_id', familyId).eq('related_type', 'appointment').eq('is_done', false).limit(200),
    supabase.from('calendar_events').select('id, title, starts_at, ends_at, assignee_id, all_day, location').eq('family_id', familyId).gte('starts_at', `${today}T00:00:00Z`).lte('starts_at', in2).limit(100),
    supabase.from('subscriptions_tracked').select('id, name, cost_cents, cadence, next_charge, last_used, status').eq('family_id', familyId).in('status', ['active', 'trial']).limit(200),
    supabase.from('family_stress_signals').select('member_id, weight, occurred_on').eq('family_id', familyId).eq('status', 'active').gte('occurred_on', since60).limit(500),
    supabase.from('medications').select('id, name, member_id, refill_on, refill_reminder_days').eq('family_id', familyId).eq('is_active', true).not('refill_on', 'is', null).limit(200),
    // Digital Twin learning: 90d of chore outcomes per member.
    supabase.from('chore_assignments').select('member_id, status').eq('family_id', familyId).gte('created_at', since90).limit(2000),
    supabase.from('family_digital_twin_profiles').select('id, member_id, metadata').eq('family_id', familyId).limit(50),
    // Meal Agent / Family Memory: 90d of dinner history + the next few days' plans.
    supabase.from('meal_plans').select('plan_date, meal_type, meals(name)').eq('family_id', familyId).eq('meal_type', 'dinner').gte('plan_date', since90.slice(0, 10)).limit(500),
    supabase.from('family_insurance_policies').select('id, policy_type, insurer, renewal_date').eq('family_id', familyId).eq('is_active', true).not('renewal_date', 'is', null).lte('renewal_date', in30).limit(100),
    // Family Memory: unpurchased wish-list items → gift ideas for upcoming birthdays.
    supabase.from('wishlist_items').select('member_id, title, priority, is_purchased').eq('family_id', familyId).eq('is_purchased', false).limit(500),
    supabase.from('autopilot_suggestions').select('id, dedupe_key, status').eq('family_id', familyId).limit(500),
  ]);

  const readResults = [
    renewalsResult, apptsResult, choreRowsResult, membersResult, groceriesResult, apptRemindersResult,
    eventsResult, subsResult, stressResult, medsResult, choreHistoryResult, twinProfilesResult,
    mealPlansResult, insuranceResult, wishlistResult, existingResult,
  ];
  if (readResults.some((result) => result.error)) {
    throw new Error('Autopilot could not read the required family data');
  }

  const renewals = renewalsResult.data;
  const appts = apptsResult.data;
  const choreRows = choreRowsResult.data;
  const members = membersResult.data;
  const groceries = groceriesResult.data;
  const apptReminders = apptRemindersResult.data;
  const events = eventsResult.data;
  const subs = subsResult.data;
  const stress = stressResult.data;
  const meds = medsResult.data;
  const choreHistory = choreHistoryResult.data;
  const twinProfiles = twinProfilesResult.data;
  const mealPlans = mealPlansResult.data;
  const insurance = insuranceResult.data;
  const wishlist = wishlistResult.data;
  const existing = existingResult.data;

  const remindedAppt = new Set((apptReminders ?? []).map((r) => r.related_id).filter(Boolean) as string[]);

  // Family Memory: top unpurchased wish-list titles per member (high priority first).
  const prioRank: Record<string, number> = { high: 3, medium: 2, low: 1 };
  const giftsByMember = new Map<string, string[]>();
  for (const w of (wishlist ?? []).slice().sort((a, b) => (prioRank[b.priority] ?? 0) - (prioRank[a.priority] ?? 0))) {
    const arr = giftsByMember.get(w.member_id) ?? [];
    if (arr.length < 3) { arr.push(w.title); giftsByMember.set(w.member_id, arr); }
  }

  // Family Memory: rank dinners cooked over the last 90 days, and note which of
  // the next few days already have a dinner planned.
  const mealCounts = new Map<string, number>();
  const plannedDinnerDays: string[] = [];
  const horizonEnd = new Date(now.getTime() + 4 * 86400000).toISOString().slice(0, 10);
  for (const mp of mealPlans ?? []) {
    const name = (mp as unknown as { meals: { name: string } | null }).meals?.name;
    if (name) mealCounts.set(name, (mealCounts.get(name) ?? 0) + 1);
    if (mp.plan_date >= today && mp.plan_date <= horizonEnd) plannedDinnerDays.push(mp.plan_date);
  }
  const favoriteMeals = Array.from(mealCounts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  const snapshot: FamilySnapshot = {
    today,
    renewals: (renewals ?? []).map((r) => ({ id: r.id, label: r.title, expiresOn: r.expires_at })),
    appointments: (appts ?? []).map((a) => ({ id: a.id, title: a.title, startsAt: a.starts_at, memberId: a.member_id, hasReminder: remindedAppt.has(a.id) })),
    overdueChores: (choreRows ?? []).map((c) => ({
      id: c.id,
      title: (c as unknown as { chores: { title: string } | null }).chores?.title ?? 'Chore',
      dueAt: c.due_at, memberId: c.member_id,
    })),
    birthdays: (members ?? []).map((m) => ({ memberId: m.id, name: m.display_name, birthday: m.birthday as string, giftIdeas: giftsByMember.get(m.id) })),
    lingeringGroceries: (groceries ?? []).map((g) => ({ id: g.id, name: g.name, addedAt: g.created_at })),
    events: (events ?? []).map((e) => ({ id: e.id, title: e.title, startsAt: e.starts_at, endsAt: e.ends_at, memberId: e.assignee_id, allDay: e.all_day, location: e.location })),
    subscriptions: (subs ?? []).map((x) => ({ id: x.id, name: x.name, costCents: x.cost_cents, cadence: x.cadence, nextCharge: x.next_charge, lastUsed: x.last_used, status: x.status })),
    stressSignals: (stress ?? []).map((x) => ({ memberId: x.member_id, weight: Number(x.weight), occurredOn: x.occurred_on })),
    medications: (meds ?? []).map((x) => ({ id: x.id, name: x.name, memberId: x.member_id, refillOn: x.refill_on as string, reminderDays: x.refill_reminder_days })),
    favoriteMeals,
    plannedDinnerDays,
    insurance: (insurance ?? []).map((p) => ({ id: p.id, label: `${p.policy_type} insurance (${p.insurer})`, renewalOn: p.renewal_date as string })),
  };

  // Digital Twin: learn per-member reliability from chore history, persist it to
  // the twin profile, and use it to modulate this scan's confidence/urgency.
  const histByMember = new Map<string, { completed: number; total: number }>();
  for (const c of choreHistory ?? []) {
    if (!c.member_id) continue;
    const h = histByMember.get(c.member_id) ?? { completed: 0, total: 0 };
    h.total += 1;
    if (c.status === 'approved') h.completed += 1;
    histByMember.set(c.member_id, h);
  }
  const history: MemberHistory[] = Array.from(histByMember.entries()).map(([memberId, h]) => ({
    memberId, choresCompleted: h.completed, choresTotal: h.total,
  }));
  const traits = computeMemberTraits(history);
  const traitsByMember = new Map<string, MemberTraits>(traits.map((t) => [t.memberId, t]));

  // Persist learned traits into the twin (best-effort; merges, never clobbers).
  const profileByMember = new Map((twinProfiles ?? []).map((p) => [p.member_id, p]));
  for (const t of traits) {
    try {
      const existingProfile = profileByMember.get(t.memberId);
      if (existingProfile) {
        const merged = { ...(existingProfile.metadata as Record<string, unknown> ?? {}), autopilot_traits: t };
        const { error: updateError } = await supabase.from('family_digital_twin_profiles').update({ metadata: merged as never }).eq('id', existingProfile.id);
        if (updateError) console.error('[autopilot] trait update failed', updateError);
      } else {
        const { error: insertError } = await supabase.from('family_digital_twin_profiles').insert({
          family_id: familyId, member_id: t.memberId, metadata: { autopilot_traits: t } as never, created_by: userId,
        });
        if (insertError) console.error('[autopilot] trait insert failed', insertError);
      }
    } catch {
      // non-fatal: trait persistence is an enhancement, not required for the scan
    }
  }

  const drafts = buildSuggestions(snapshot, traitsByMember);
  const draftKeys = new Set(drafts.map((d) => d.dedupeKey));
  const existingByKey = new Map((existing ?? []).map((e) => [e.dedupe_key, e]));

  // 1) Clear stale OPEN suggestions whose signal disappeared this scan.
  const stale = (existing ?? []).filter((e) => e.status === 'open' && !draftKeys.has(e.dedupe_key)).map((e) => e.id);
  if (stale.length > 0) {
    const { error: staleError } = await supabase.from('autopilot_suggestions').delete().in('id', stale).eq('family_id', familyId);
    if (staleError) throw new Error('Autopilot could not clear stale suggestions');
  }

  // 2) Insert genuinely-new drafts; auto-execute the safe high-confidence ones.
  //    Ambient delivery: high-urgency or auto-handled items also become a
  //    `notifications` row so the existing push/email cron reaches the family
  //    without anyone opening the app.
  let autoExecuted = 0;
  let notified = 0;
  for (const d of drafts) {
    const prior = existingByKey.get(d.dedupeKey);
    if (prior) continue; // respect prior state (resolved or already-open); avoid churn

    const isAuto = confidenceTier(d.confidence) === 'auto';
    let status: 'open' | 'auto_executed' = 'open';
    let createdReminderId: string | null = null;
    let createdGroceryIds: string[] = [];

    if (isAuto && d.actionType === 'create_reminder') {
      const at = (d.payload.at as string) ?? `${today}T09:00:00Z`;
      const relatedType = d.sourceKind === 'appointments' ? 'appointment'
        : d.sourceKind === 'calendar_events' ? 'event' : 'renewal';
      const { data: reminder, error: remErr } = await supabase.from('reminders').insert({
        family_id: familyId,
        title: (d.payload.title as string) ?? d.title,
        remind_at: at,
        member_id: d.memberId,
        related_type: relatedType,
        related_id: d.sourceId,
        created_by: userId,
      }).select('id').single();
      if (!remErr && reminder?.id) {
        createdReminderId = reminder.id;
        status = 'auto_executed'; autoExecuted++;
      }
    }

    // Moment prep: add snacks/supplies to the family's active shopping list —
    // reversible (they're normal grocery_items the family can delete).
    if (isAuto && d.actionType === 'add_groceries') {
      const items = (d.payload.items as string[] | undefined) ?? [];
      if (items.length > 0) {
        const listId = await getOrCreateGroceryListId(supabase, familyId, userId);
        if (listId) {
          const { data: groceryRows, error: gErr } = await supabase.from('grocery_items').insert(
            items.map((name) => ({ family_id: familyId, list_id: listId, name, created_by: userId })),
          ).select('id');
          if (!gErr && groceryRows?.length === items.length) {
            createdGroceryIds = groceryRows.map((row) => row.id);
            status = 'auto_executed'; autoExecuted++;
          }
        }
      }
    }

    const { data: inserted, error: suggestionError } = await supabase.from('autopilot_suggestions').insert({
      family_id: familyId,
      member_id: d.memberId,
      kind: d.kind,
      title: d.title,
      detail: d.detail,
      confidence: d.confidence,
      urgency: d.urgency,
      status,
      action_type: d.actionType,
      action_label: d.actionLabel,
      payload: d.payload as never,
      source_kind: d.sourceKind,
      source_id: d.sourceId,
      dedupe_key: d.dedupeKey,
      expires_at: d.expiresAt,
      resolved_at: status === 'auto_executed' ? now.toISOString() : null,
      resolved_by: null,
      created_by: userId,
    }).select('id').single();

    if (suggestionError || !inserted?.id) {
      const cleanupErrors: unknown[] = [];
      if (createdReminderId) {
        const { error } = await supabase.from('reminders').delete().eq('id', createdReminderId).eq('family_id', familyId);
        if (error) cleanupErrors.push(error);
      }
      if (createdGroceryIds.length > 0) {
        const { error } = await supabase.from('grocery_items').delete().in('id', createdGroceryIds).eq('family_id', familyId);
        if (error) cleanupErrors.push(error);
      }
      if (cleanupErrors.length > 0) console.error('[autopilot] side-effect cleanup failed', cleanupErrors);
      throw new Error('Autopilot could not save the suggestion');
    }

    // Ambient push/email for the things worth interrupting for.
    //
    // Through the notifications SERVICE, not a raw insert. The raw insert
    // skipped quiet hours entirely, and this is the surface where that hurts
    // most: `autopilot-scan` runs at 06:30 UTC, which is 23:30 for a family on
    // US Pacific time. Bubaly's own unprompted suggestion was the thing most
    // likely to light up a phone at half past eleven at night — the §21 story,
    // arrived at from Bubaly's own initiative rather than a chore or a renewal.
    // The service also brings the duplicate guard (a re-run of the scan no
    // longer re-notifies) and skips managed profiles that have no login.
    //
    // NOT urgent: an autopilot suggestion is a courtesy. It is still delivered,
    // just at the hour the family said they were willing to hear from Bubaly.
    if (d.urgency >= 2 || status === 'auto_executed') {
      const scope = notifyScope ?? (notifyScope = await systemScopeForFamily(supabase, familyId));
      if (scope) {
        const sent = await notify(scope, {
          recipients: 'family',
          type: 'system',
          title: status === 'auto_executed' ? `Autopilot handled: ${d.title}` : d.title,
          body: d.detail,
          relatedType: 'autopilot_suggestions',
          relatedId: inserted.id,
        });
        if (sent.ok && sent.data.created > 0) notified++;
      }
    }
  }

  return { scanned: drafts.length, autoExecuted, cleared: stale.length, notified };
}
