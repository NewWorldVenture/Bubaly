import Link from 'next/link';
import {
  Sparkles, Calendar, ArrowRight, Bell, ChevronRight, Sun, Clock, MessageSquare, Plane, PhoneCall,
} from 'lucide-react';
import { createServer } from '@/lib/supabase/server';
import { settleAll } from '@/lib/supabase/settle';
import type { UserContext } from '@/lib/supabase/auth';
import { isSuperAdmin } from '@/lib/supabase/auth';
import { isManager } from '@/lib/constants/roles';
import { Avatar } from '@/components/ui/avatar';
import { cn } from '@/lib/utils/cn';
import { fmtTime } from '@/lib/utils/format';
import { Rocket, Gauge, ShieldCheck } from 'lucide-react';
import { successProbability } from '@/lib/autopilot/engine';
import { resolveFamilyPlanLevel } from '@/lib/server/plan';
import { tierForPlanLevel, FIXED_FEATURES } from '@/lib/dashboard/registry';
import { resolvePrimary, availableFeatures, lockedFeatures } from '@/lib/dashboard/layout';
import { normalizeSettings, canCustomizeDashboard, effectiveSavedKeys } from '@/lib/dashboard/permissions';
import { DashboardQuickActions } from '@/components/dashboard/quick-actions';
import { AskBubaly } from '@/components/concierge/ask-bubaly';
import { NeedsAttention } from '@/components/concierge/needs-attention';
import { WorkingOn } from '@/components/concierge/working-on';
import { CompletedByBubaly } from '@/components/concierge/completed-by-bubaly';
import { loadCompletedByBubaly } from '@/lib/home/completed';
import {
  buildToday, workingRunsFrom, WORKING_RUN_STATES,
  type TodayChoreRow, type TodayEventRow, type TodayReminderRow, type TodayTodoRow,
  type WorkingRunRow, type WorkingStepRow,
} from '@/lib/home/today';
import { listPending } from '@/lib/services/approvals';
import { dayKeyInTz, scopeFromUserContext, zonedDayBoundsMs } from '@/lib/services/scope';
import { Heart } from 'lucide-react';
import { upcomingRelationship, formatCountdown, milestoneLabel, type RelKind } from '@/lib/relationship/dates';
import { reminderAttention } from '@/lib/dashboard/reminder-attention';
import { mergeUpcoming } from '@/lib/dashboard/upcoming';
import { topNeeds, summarizeNeeds, needsHeadline } from '@/lib/home/needs-attention';
import { type ParentApprovalRow, type RenewalRow, type DocumentRow, type AwaitingRunRow, type RecommendationRow } from '@/lib/home/needs-sources';
import { buildHomeNeeds } from '@/lib/home/needs-build';
import { detectConflicts, type ConflictEvent } from '@/lib/home/conflicts';
import { buildHomeBrief } from '@/lib/home/home-brief';
import type { DinnerIdea, DinnerEffort } from '@/lib/onboarding/dinner-ideas';
import { CircleCheck, Circle, Utensils } from 'lucide-react';
import { buildInsightCandidates, rankInsights, type InsightKind, type InsightSources } from '@/lib/home/insight-of-day';
import { InsightHero } from '@/components/dashboard/insight-hero';
import { getTranslations } from '@/lib/i18n/server';

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function todayLabel() {
  return new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

export async function AiHomeDashboard({ ctx }: { ctx: UserContext }) {
  const t = await getTranslations();
  const familyId = ctx.active.familyId;
  const me = ctx.active.member;
  const myMemberId = me.id;
  const manager = isManager(ctx.active.role);
  const supabase = await createServer();

  const now = new Date();
  // The family's own day, not the server's (§16 Today): the window and the
  // day key resolve in the family timezone.
  const tz = ctx.active.family.timezone || 'UTC';
  const todayKey = dayKeyInTz(now, tz);
  const dayBounds = zonedDayBoundsMs(todayKey, tz);
  const todayStart = new Date(dayBounds.start);
  const todayEnd = new Date(dayBounds.end);

  // Not a { data, error } read, so it sits beside the batch rather than inside
  // it. A failure costs the plan tier — defaulting to the free tier — instead
  // of rejecting every other read in the batch alongside it.
  const famPlanLevel = await resolveFamilyPlanLevel(supabase, familyId).catch((cause) => {
    console.warn('[dashboard-home] plan level read failed — assuming free', cause);
    return 0 as Awaited<ReturnType<typeof resolveFamilyPlanLevel>>;
  });

  const [
    { count: pendingChores },
    { data: todayEvents },
    { count: groceryCount },
    { count: overdueMedsCount },
    { count: pendingApprovals },
    { count: openTodos },
    { data: members },
    { data: upcomingEvents },
    { data: autopilotOpen },
    { count: autopilotHandledCount },
    { count: unreadCommsCount },
    { data: activeConcierge },
    { count: unreadCallsCount },
    { data: layoutRows },
    { data: relDateRows },
    { data: dueReminderRows },
    { data: weekReminderRows },
    { data: approvalRows },
    { data: renewalRows },
    { data: conflictEventRows },
    { data: documentRows },
    { data: homeworkRows },
    { count: plannedDinnerCount },
  ] = await settleAll([
    supabase.from('chore_assignments').select('id', { count: 'exact', head: true })
      .eq('family_id', familyId).eq('member_id', myMemberId).in('status', ['todo', 'in_progress']),
    supabase.from('calendar_events')
      .select('id, title, starts_at, all_day, location')
      .eq('family_id', familyId)
      .or(`assignee_id.eq.${myMemberId},assignee_id.is.null`)
      .gte('starts_at', todayStart.toISOString()).lt('starts_at', todayEnd.toISOString())
      .order('starts_at').limit(5),
    supabase.from('grocery_items').select('id', { count: 'exact', head: true })
      .eq('family_id', familyId).eq('is_checked', false),
    supabase.from('medications').select('id', { count: 'exact', head: true })
      .eq('family_id', familyId).eq('is_active', true).limit(1),
    manager
      ? supabase.from('chore_assignments').select('id', { count: 'exact', head: true })
          .eq('family_id', familyId).eq('status', 'submitted')
      : Promise.resolve({ count: 0 }),
    supabase.from('todo_items').select('id', { count: 'exact', head: true })
      .eq('family_id', familyId).eq('is_done', false),
    supabase.from('family_members').select('id, display_name, color, role')
      .eq('family_id', familyId).eq('is_active', true).order('created_at').limit(6),
    supabase.from('calendar_events')
      .select('id, title, starts_at, all_day')
      .eq('family_id', familyId)
      .or(`assignee_id.eq.${myMemberId},assignee_id.is.null`)
      .gte('starts_at', todayEnd.toISOString())
      .lte('starts_at', new Date(Date.now() + 7 * 86400000).toISOString())
      .order('starts_at').limit(5),
    supabase.from('autopilot_suggestions')
      .select('id, title, detail, kind, urgency, confidence')
      .eq('family_id', familyId).eq('status', 'open')
      .order('urgency', { ascending: false }).order('confidence', { ascending: false }).limit(20),
    supabase.from('autopilot_suggestions').select('id', { count: 'exact', head: true })
      .eq('family_id', familyId).in('status', ['auto_executed', 'executed', 'approved']),
    supabase.from('family_communications').select('id', { count: 'exact', head: true })
      .eq('family_id', familyId).eq('status', 'unread'),
    supabase.from('concierge_plans').select('id, title, kind, status')
      .eq('family_id', familyId).in('status', ['planning', 'booked', 'confirmed'])
      .order('created_at', { ascending: false }).limit(2),
    supabase.from('call_logs').select('id', { count: 'exact', head: true })
      .eq('family_id', familyId).eq('is_read', false),
    supabase.from('dashboard_layouts').select('feature_keys, scope, user_id')
      .eq('family_id', familyId).is('deleted_at', null).in('scope', ['user', 'family']),
    supabase.from('relationship_dates').select('id, kind, title, event_date, recurs_annually, reminder_days_before, status')
      .eq('family_id', familyId).neq('status', 'cancelled').limit(100),
    supabase.from('family_reminders').select('id, title, remind_at, status, member_id, priority')
      .eq('family_id', familyId).eq('status', 'active').not('remind_at', 'is', null)
      .or(`member_id.eq.${myMemberId},member_id.is.null`)
      .lte('remind_at', todayEnd.toISOString()).order('remind_at', { ascending: true }).limit(100),
    supabase.from('family_reminders').select('id, title, remind_at')
      .eq('family_id', familyId).eq('status', 'active').not('remind_at', 'is', null)
      .or(`member_id.eq.${myMemberId},member_id.is.null`)
      .gt('remind_at', todayEnd.toISOString())
      .lte('remind_at', new Date(Date.now() + 7 * 86400000).toISOString())
      .order('remind_at').limit(10),
    // Money decisions waiting on a parent (wallet/cards/allowance) — managers only.
    manager
      ? supabase.from('parent_approvals').select('id, kind, amount_cents, created_at')
          .eq('family_id', familyId).eq('status', 'pending').order('created_at', { ascending: false }).limit(20)
      : Promise.resolve({ data: [] }),
    // Renewals approaching/expired so they surface on Home, not just in their module.
    supabase.from('renewals').select('id, title, expires_at, reminder_days, status, created_at')
      .eq('family_id', familyId).in('status', ['active', 'expired'])
      .lte('expires_at', new Date(Date.now() + 45 * 86400000).toISOString()).limit(50),
    // Upcoming assigned events (next 14d) → detect personal double-bookings.
    supabase.from('calendar_events').select('id, title, starts_at, ends_at, all_day, assignee_id')
      .eq('family_id', familyId).not('assignee_id', 'is', null)
      .gte('starts_at', todayStart.toISOString())
      .lte('starts_at', new Date(Date.now() + 14 * 86400000).toISOString())
      .order('starts_at').limit(200),
    // Stored documents expiring within ~30 days (passports, licenses, insurance…).
    supabase.from('documents').select('id, title, expires_at')
      .eq('family_id', familyId).not('expires_at', 'is', null)
      .lte('expires_at', new Date(Date.now() + 30 * 86400000).toISOString()).limit(50),
    // T4 sources: assignments due TOMORROW that haven't been acknowledged.
    supabase.from('homework_assignments').select('title, member_id')
      .eq('family_id', familyId).eq('status', 'assigned')
      .gte('due_at', todayEnd.toISOString())
      .lt('due_at', new Date(todayEnd.getTime() + 86400000).toISOString()).limit(20),
    // T4 sources: dinners planned in the next 7 days (→ how many nights are unplanned).
    supabase.from('meal_plans').select('id', { count: 'exact', head: true })
      .eq('family_id', familyId).eq('meal_type', 'dinner')
      .gte('plan_date', todayStart.toISOString().slice(0, 10))
      .lte('plan_date', new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10)),
  ]);

  // §16 Command Center reads: what Bubaly is doing, what it finished, what it
  // is asking. Family-scoped; every error is captured and logged, and a failed
  // read renders as empty rather than as a false "all clear" — except the
  // approvals inbox, whose failure is logged loudly because "nothing needs
  // you" is a claim.
  // listPending returns a ServiceResult, not a Postgrest response, so it is
  // awaited beside the batch rather than inside it — settleAll's fallback is
  // the { data, error } shape and would not fit it.
  const aiApprovalsRes = await listPending(scopeFromUserContext(ctx, supabase)).catch((cause) => {
    console.warn('[dashboard-home] pending AI approvals read threw', cause);
    return { ok: false as const, error: String(cause) };
  });
  // "Completed by Bubaly" (M6): one fail-closed loader that reads the ledger for
  // the tool that acted and the plan's reason. A ServiceResult, not a Postgrest
  // response, so it is awaited BESIDE the batch — settleAll substitutes the
  // { data, error } shape for a rejection, which has no `ok` to branch on.
  const completedRes = await loadCompletedByBubaly(supabase, familyId, { now, limit: 6 }).catch((cause) => {
    console.error('[dashboard-home] completed-by-Bubaly read threw', cause);
    return { ok: false as const, error: String(cause) };
  });
  const [activeRunsRes, recsRes, todosDueRes, choresDueRes] = await settleAll([
    supabase.from('family_automation_runs').select('id, summary, state, plan_id, updated_at, created_at')
      .eq('family_id', familyId).in('state', [...WORKING_RUN_STATES]).order('updated_at', { ascending: false }).limit(8),
    supabase.from('family_ai_recommendations').select('id, title, body, priority, cta_href, created_at')
      .eq('family_id', familyId).eq('status', 'pending').order('created_at', { ascending: false }).limit(5),
    supabase.from('todo_items').select('id, title, due_date, priority, assigned_to_id')
      .eq('family_id', familyId).eq('is_done', false).lte('due_date', todayKey).order('due_date', { ascending: true }).limit(20),
    supabase.from('chore_assignments').select('id, chore_id, member_id, status, due_at')
      .eq('family_id', familyId).in('status', ['todo', 'in_progress']).lt('due_at', todayEnd.toISOString()).order('due_at', { ascending: true }).limit(20),
  ]);
  for (const [label, res] of [
    ['active runs', activeRunsRes],
    ['recommendations', recsRes], ['todos due', todosDueRes], ['chores due', choresDueRes],
  ] as const) {
    if (res.error) console.error(`[dashboard-home] ${label} read failed`, res.error);
  }
  if (!aiApprovalsRes.ok) console.error('[dashboard-home] pending AI approvals read failed', aiApprovalsRes.error);

  const activeRuns = (activeRunsRes.data ?? []) as WorkingRunRow[];
  const activePlanIds = activeRuns.map((r) => r.plan_id).filter((x): x is string => !!x);
  const choresDue = (choresDueRes.data ?? []) as TodayChoreRow[];
  const choreIds = [...new Set(choresDue.map((c) => c.chore_id))];
  const [{ data: activeStepRows, error: activeStepError }, { data: choreDefs, error: choreDefsError }] = await settleAll([
    activePlanIds.length
      ? supabase.from('ai_plan_steps').select('plan_id, status').eq('family_id', familyId).in('plan_id', activePlanIds)
      : Promise.resolve({ data: [] as WorkingStepRow[], error: null }),
    choreIds.length
      ? supabase.from('chores').select('id, title').eq('family_id', familyId).in('id', choreIds)
      : Promise.resolve({ data: [] as { id: string; title: string }[], error: null }),
  ]);
  if (activeStepError) console.error('[dashboard-home] active run steps read failed', activeStepError);
  if (choreDefsError) console.error('[dashboard-home] chore titles read failed', choreDefsError);
  const workingRuns = workingRunsFrom(activeRuns, (activeStepRows ?? []) as WorkingStepRow[]);
  const completedItems = completedRes.ok ? completedRes.data : [];
  const completedError = completedRes.ok ? null : completedRes.error;
  const aiApprovals = aiApprovalsRes.ok ? aiApprovalsRes.data : [];
  const recommendations = (recsRes.data ?? []) as (RecommendationRow & { body: string | null })[];

  // Soonest relationship date inside its reminder window (gentle proactive nudge).
  const relReminder = upcomingRelationship(
    ((relDateRows ?? []) as { id: string; kind: RelKind; title: string; event_date: string; recurs_annually: boolean; reminder_days_before: number; status: string }[])
      .map((d) => ({ id: d.id, kind: d.kind, title: d.title, eventDate: d.event_date, recursAnnually: d.recurs_annually, reminderDaysBefore: d.reminder_days_before, status: d.status })),
  )[0];

  const openSuggestions = (autopilotOpen ?? []) as { id: string; title: string; detail: string | null; kind: string; urgency: number; confidence: number }[];
  const concierge = (activeConcierge ?? []) as { id: string; title: string; kind: string; status: string }[];
  const autopilotProbability = successProbability(openSuggestions.map((s) => ({ urgency: s.urgency as 1 | 2 | 3, confidence: s.confidence } as never)));
  const autopilotHandled = autopilotHandledCount ?? 0;
  const topSuggestions = openSuggestions.slice(0, 3);
  const showAutopilot = openSuggestions.length > 0 || autopilotHandled > 0;

  // ── Customizable, tier-aware quick actions ──
  const { data: dashSettingsRow } = await supabase
    .from('family_dashboard_settings').select('allow_child_customization, lock_to_family_default').eq('family_id', familyId).maybeSingle();
  const dashSettings = normalizeSettings(dashSettingsRow ? { allowChildCustomization: dashSettingsRow.allow_child_customization, lockToFamilyDefault: dashSettingsRow.lock_to_family_default } : null);
  // Super-admins are fully unlocked everywhere — no plan gating on Quick Access
  // (every tile available, nothing locked, no "Unlock more"), matching the nav
  // which already treats super-admins as having access to everything.
  const superAdmin = await isSuperAdmin();
  const dashTier = superAdmin ? 'plus' : tierForPlanLevel(famPlanLevel);
  const layouts = (layoutRows ?? []) as { feature_keys: string[]; scope: string; user_id: string | null }[];
  const myLayout = layouts.find((l) => l.scope === 'user' && l.user_id === ctx.user.id);
  const familyLayout = layouts.find((l) => l.scope === 'family');
  const savedKeys = effectiveSavedKeys(myLayout?.feature_keys ?? null, familyLayout?.feature_keys ?? null, dashSettings);
  const primaryButtons = resolvePrimary(savedKeys, dashTier);
  const primaryKeys = primaryButtons.map((f) => f.key);
  const availableButtons = availableFeatures(dashTier);
  const lockedButtons = lockedFeatures(dashTier);
  const canCustomize = canCustomizeDashboard(manager, dashSettings);

  const { overdue: overdueReminders, dueToday: dueTodayReminders } = reminderAttention(
    (dueReminderRows ?? []) as { remind_at: string | null; status: string }[], now,
  );

  // Personal double-bookings: detect per-assignee overlaps; a manager sees the
  // whole family's, everyone else just their own.
  const memberNameById = new Map((members ?? []).map((m) => [m.id, m.display_name]));
  const homeConflicts = detectConflicts((conflictEventRows ?? []) as ConflictEvent[])
    .filter((c) => manager || c.assigneeId === myMemberId)
    .map((c) => ({ id: c.eventIds[0], assigneeName: memberNameById.get(c.assigneeId) ?? null, count: c.eventIds.length, startsAt: c.startsAt }));

  const homeNeeds = buildHomeNeeds({
    approvals: (approvalRows ?? []) as ParentApprovalRow[],
    renewals: (renewalRows ?? []) as RenewalRow[],
    documents: (documentRows ?? []) as DocumentRow[],
    conflicts: homeConflicts,
    pendingApprovals: pendingApprovals ?? 0,
    overdueMeds: (overdueMedsCount ?? 0) > 0,
    overdueReminders,
    dueTodayReminders,
    pendingChores: pendingChores ?? 0,
    lowGrocery: (groceryCount ?? 0) > 0,
    openTodos: openTodos ?? 0,
    now,
    aiApprovals: aiApprovals.map((a) => ({ id: a.id, title: a.title, runId: a.runId, priority: a.priority ?? null, requestedAt: a.requestedAt, expiresAt: a.expiresAt })),
    awaitingRuns: activeRuns as AwaitingRunRow[],
    recommendations,
  });
  const needs = topNeeds(homeNeeds, 5);
  const needsHeader = needsHeadline(summarizeNeeds(homeNeeds));

  const name = me.display_name ?? ctx.user.email?.split('@')[0] ?? 'there';
  const today = buildToday({
    events: (todayEvents ?? []) as TodayEventRow[],
    todos: (todosDueRes.data ?? []) as TodayTodoRow[],
    chores: choresDue,
    reminders: (dueReminderRows ?? []) as TodayReminderRow[],
    choreTitles: Object.fromEntries((choreDefs ?? []).map((c) => [c.id, c.title])),
    todayKey, tz, now,
  });
  const hasEvents = today.schedule.length > 0 || today.tasks.length > 0;

  // "Coming Up" merges this week's calendar events and timed reminders.
  const upcomingItems = mergeUpcoming(
    (upcomingEvents ?? []) as { id: string; title: string; starts_at: string; all_day: boolean }[],
    (weekReminderRows ?? []) as { id: string; title: string; remind_at: string | null }[],
    5,
  );
  const hasUpcoming = upcomingItems.length > 0;

  // ── T3: outcome-first home. When the page would otherwise be empty (nothing
  // needs you, nothing today), compute an OUTCOME — how ready the week is, the
  // next best getting-started steps, and dinner ideas — instead of a bland
  // "all caught up" void. Reuses the onboarding first-brief engine so home + the
  // first-run screen tell the same story.
  const showOutcome = needs.shown.length === 0 && !hasEvents;
  let homeBrief: ReturnType<typeof buildHomeBrief> | null = null;
  if (showOutcome) {
    const { data: dinnerRows } = await supabase
      .from('meal_ideas').select('title, cuisine, effort, prep_minutes, description').eq('is_active', true).limit(200);
    const dinnerCandidates: DinnerIdea[] = (dinnerRows ?? []).map((r) => ({
      title: r.title, cuisine: r.cuisine, effort: r.effort as DinnerEffort, prepMinutes: r.prep_minutes, description: r.description ?? null,
    }));
    homeBrief = buildHomeBrief({
      upcomingEvents: ((upcomingEvents ?? []) as { title: string; starts_at: string; all_day: boolean }[])
        .map((e) => ({ title: e.title, start: e.starts_at, allDay: e.all_day })),
      dinnerCandidates,
      choresPending: pendingChores ?? 0,
      openTodos: openTodos ?? 0,
      groceryOpen: groceryCount ?? 0,
      memberCount: (members ?? []).length,
    }, now);

    // Persisted snapshots are paused; render the freshly computed outcome.
  }

  // ── T4: the one proactive "insight of the day". Build candidate insights from
  // the family's live signals, rank by impact, and surface exactly ONE above the
  // fold. Candidates are persisted to daily_insights so a dismissal sticks and the
  // next-best insight takes its place. All best-effort — never blocks the render.
  let insightRow: { id: string; kind: string; title: string; detail: string; href: string; impact: number; alternatives: number } | null = null;
  try {
    const dayIso = new Date(todayStart.getTime() + 86400000).toISOString().slice(0, 10);
    const daysUntil = (iso: string) => Math.ceil((new Date(iso).getTime() - now.getTime()) / 86400000);
    const sources: InsightSources = {
      conflictsSoon: homeConflicts.map((c) => ({
        title: c.assigneeName ? `${c.assigneeName}’s day` : 'Two events',
        when: c.startsAt.slice(0, 10) === todayStart.toISOString().slice(0, 10) ? 'Today'
          : c.startsAt.slice(0, 10) === dayIso ? 'Tomorrow' : 'This week',
      })),
      homeworkDueTomorrow: ((homeworkRows ?? []) as { title: string; member_id: string | null }[])
        .map((h) => ({ title: h.title, who: h.member_id ? (memberNameById.get(h.member_id) ?? '')?.split(' ')[0] ?? null : null })),
      pendingApprovals: ((approvalRows ?? []) as ParentApprovalRow[]).length + (pendingApprovals ?? 0),
      overdueReminders: overdueReminders,
      renewalsSoon: ((renewalRows ?? []) as RenewalRow[])
        .map((r) => ({ title: r.title, days: daysUntil(r.expires_at) })).filter((r) => r.days >= 0),
      documentsSoon: ((documentRows ?? []) as DocumentRow[])
        .filter((d) => d.expires_at).map((d) => ({ title: d.title, days: daysUntil(d.expires_at as string) })).filter((d) => d.days >= 0),
      unplannedDinners: Math.max(0, 7 - Math.min(7, plannedDinnerCount ?? 0)),
      lowGrocery: groceryCount ?? 0,
      autopilotTop: openSuggestions[0] ? { title: openSuggestions[0].title, confidence: openSuggestions[0].confidence } : null,
    };
    const candidates = buildInsightCandidates(sources);
    if (candidates.length > 0) {
      const today = todayStart.toISOString().slice(0, 10);
      // Which kinds has the family already dismissed today? Never re-surface those.
      const { data: existingIns } = await supabase.from('daily_insights')
        .select('kind, status').eq('family_id', familyId).eq('as_of_date', today);
      const blocked = new Set(((existingIns ?? []) as { kind: string; status: string }[]).filter((r) => r.status !== 'active').map((r) => r.kind));
      const toUpsert = candidates.filter((c) => !blocked.has(c.kind));
      if (toUpsert.length > 0) {
        await supabase.from('daily_insights').upsert(
          toUpsert.map((c) => ({
            family_id: familyId, as_of_date: today, kind: c.kind,
            title: c.title, detail: c.detail, href: c.href, impact: c.impact,
            status: 'active', created_by: ctx.user.id,
          })),
          { onConflict: 'family_id,as_of_date,kind' },
        );
      }
      // Re-read active rows so the DB id (needed to dismiss) + persisted dismissals win.
      const { data: activeRows } = await supabase.from('daily_insights')
        .select('id, kind, title, detail, href, impact')
        .eq('family_id', familyId).eq('as_of_date', today).eq('status', 'active');
      const ranked = rankInsights(((activeRows ?? []) as { id: string; kind: string; title: string; detail: string | null; href: string | null; impact: number }[])
        .map((r) => ({ id: r.id, kind: r.kind as InsightKind, title: r.title, detail: r.detail ?? '', href: r.href ?? '/dashboard', impact: r.impact })));
      const top = ranked[0];
      if (top) insightRow = { id: top.id, kind: top.kind, title: top.title, detail: top.detail, href: top.href, impact: top.impact, alternatives: Math.max(0, ranked.length - 1) };
    }
  } catch { /* daily_insights not migrated yet — skip the hero */ }

  return (
    <div className="space-y-6 pb-32">
      {/* Greeting header */}
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm text-muted">{todayLabel()}</p>
          <h1 className="mt-0.5 text-2xl font-bold sm:text-3xl">{greeting()}, {name.split(' ')[0]}.</h1>
        </div>
        <Link href="/dashboard/assistant" className="flex items-center gap-1.5 rounded-full bg-brand/10 px-3 py-1.5 text-xs font-semibold text-brand-text hover:bg-brand/20 transition">
          <Sparkles className="h-3.5 w-3.5" /> {t('aiHomeDashboard.askAi')}
        </Link>
      </div>

      {/* §16: one natural-language entry — a request becomes a run with a page. */}
      <AskBubaly variant="hero" />

      {/* T4: the one proactive insight of the day, above the fold */}
      {insightRow && <InsightHero insight={insightRow} />}

      {/* Relationship reminder — gentle proactive nudge for an upcoming date */}
      {relReminder && (
        <Link href="/dashboard/relationship"
          className="flex items-center gap-3 rounded-2xl border border-rose-500/30 bg-rose-500/5 px-4 py-3 transition hover:bg-rose-500/10">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-rose-500/15 text-rose-300"><Heart className="h-5 w-5" /></div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">{relReminder.title} {formatCountdown(relReminder.days).toLowerCase()}</p>
            <p className="truncate text-xs text-muted">{milestoneLabel(relReminder) ?? 'Plan something special'} {t('aiHomeDashboard.tapForGiftIdeas')}</p>
          </div>
          <Sparkles className="h-4 w-4 shrink-0 text-rose-300" />
        </Link>
      )}

      {/* Family members strip */}
      {(members ?? []).length > 1 && (
        <div className="flex items-center gap-2 overflow-x-auto pb-1 no-scrollbar">
          {(members ?? []).map((m) => (
            <div key={m.id} className="flex shrink-0 flex-col items-center gap-1">
              <Avatar name={m.display_name ?? '?'} color={m.color ?? undefined} size={40} className="rounded-full" />
              <span className="text-[10px] text-muted max-w-[48px] truncate text-center">{(m.display_name ?? '?').split(' ')[0]}</span>
            </div>
          ))}
        </div>
      )}

      {/* Family Autopilot — Control Tower summary */}
      {showAutopilot && (
        <Link href="/dashboard/autopilot"
          className="block rounded-2xl border border-brand/20 bg-gradient-to-br from-brand/10 to-violet-500/5 p-5 transition hover:border-brand/40">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <div className="grid h-9 w-9 place-items-center rounded-xl bg-brand/15">
                <Rocket className="h-5 w-5 text-brand-text" />
              </div>
              <div>
                <p className="text-sm font-bold">{t('aiHomeDashboard.familyAutopilot')}</p>
                <p className="text-xs text-muted">{t('aiHomeDashboard.bubalyIsWatchingOverToday')}</p>
              </div>
            </div>
            <ArrowRight className="h-4 w-4 text-brand-text" />
          </div>

          <div className="mt-4 flex items-center gap-5">
            <div className="flex items-center gap-2">
              <Gauge className={cn('h-4 w-4', autopilotProbability >= 85 ? 'text-emerald-400' : autopilotProbability >= 60 ? 'text-amber-400' : 'text-rose-400')} />
              <span className="text-lg font-black">{autopilotProbability}%</span>
              <span className="text-[11px] text-muted">{t('aiHomeDashboard.onTrack')}</span>
            </div>
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-emerald-400" />
              <span className="text-lg font-black">{autopilotHandled}</span>
              <span className="text-[11px] text-muted">handled</span>
            </div>
            {openSuggestions.length > 0 && (
              <div className="flex items-center gap-2">
                <Bell className="h-4 w-4 text-amber-400" />
                <span className="text-lg font-black">{openSuggestions.length}</span>
                <span className="text-[11px] text-muted">{t('aiHomeDashboard.toReview')}</span>
              </div>
            )}
          </div>

          {topSuggestions.length > 0 && (
            <div className="mt-4 space-y-1.5 border-t border-border/40 pt-3">
              {topSuggestions.map((s) => (
                <div key={s.id} className="flex items-center gap-2 text-xs">
                  <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', s.urgency === 3 ? 'bg-rose-400' : s.urgency === 2 ? 'bg-amber-400' : 'bg-muted')} />
                  <span className="truncate text-fg/90">{s.title}</span>
                </div>
              ))}
            </div>
          )}
        </Link>
      )}

      {/* Front Desk + Communications + Concierge widgets */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Link href="/dashboard/front-desk"
          className="flex items-center gap-3 rounded-2xl border border-border bg-surface/40 p-4 transition hover:bg-elevated hover:border-brand/20">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-green-500/10">
            <PhoneCall className="h-5 w-5 text-green-400" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold">{t('aiHomeDashboard.frontDesk')}</p>
            <p className="truncate text-xs text-muted">
              {(unreadCallsCount ?? 0) > 0 ? `${unreadCallsCount} new call${unreadCallsCount === 1 ? '' : 's'}` : 'All calls handled'}
            </p>
          </div>
          {(unreadCallsCount ?? 0) > 0 && (
            <span className="ml-auto flex h-5 w-5 items-center justify-center rounded-full bg-green-500 text-[10px] font-bold text-white shrink-0">
              {unreadCallsCount}
            </span>
          )}
        </Link>
        <Link href="/dashboard/inbox"
          className="flex items-center gap-3 rounded-2xl border border-border bg-surface/40 p-4 transition hover:bg-elevated hover:border-brand/20">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-blue-500/10">
            <MessageSquare className="h-5 w-5 text-blue-400" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold">{t('aiHomeDashboard.inbox')}</p>
            <p className="text-xs text-muted">
              {(unreadCommsCount ?? 0) > 0 ? `${unreadCommsCount} unread` : 'No new messages'}
            </p>
          </div>
          {(unreadCommsCount ?? 0) > 0 && (
            <span className="ml-auto flex h-5 w-5 items-center justify-center rounded-full bg-blue-500 text-[10px] font-bold text-white shrink-0">
              {unreadCommsCount}
            </span>
          )}
        </Link>
        <Link href="/dashboard/concierge"
          className="flex items-center gap-3 rounded-2xl border border-border bg-surface/40 p-4 transition hover:bg-elevated hover:border-brand/20">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-violet-500/10">
            <Plane className="h-5 w-5 text-violet-400" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold">{t('aiHomeDashboard.concierge')}</p>
            <p className="truncate text-xs text-muted">
              {concierge.length > 0 ? concierge[0].title : 'Plan something fun'}
            </p>
          </div>
        </Link>
      </div>

      {/* §16 Needs Your Attention — one ranked queue, decisions made in place */}
      <NeedsAttention
        items={needs.shown}
        more={needs.more}
        headline={needsHeader}
        approvals={Object.fromEntries(aiApprovals.map((a) => [a.id, a]))}
        moneyApprovalKinds={Object.fromEntries(((approvalRows ?? []) as ParentApprovalRow[]).map((a) => [a.id, a.kind]))}
        recommendationBodies={Object.fromEntries(recommendations.map((r) => [r.id, r.body]))}
        canDecide={manager}
      />

      {/* §16 Bubaly Is Working On — live from Realtime after the first paint */}
      <WorkingOn familyId={familyId} initial={workingRuns} historyHref="/dashboard/concierge/runs" />

      {/* §16 Today — the unified schedule plus what is owed by today */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Sun className="h-4 w-4 text-amber-400" aria-hidden />
            <h2 className="text-sm font-semibold text-muted uppercase tracking-wide">{t('aiHomeDashboard.today')}</h2>
          </div>
          <Link href="/dashboard/calendar" className="text-xs font-semibold text-brand-text hover:underline">{t('aiHomeDashboard.viewAll')}</Link>
        </div>
        {!hasEvents && (
          <p className="rounded-2xl border border-dashed border-border px-4 py-5 text-center text-sm text-muted">{t('aiHomeDashboard.aClearDayNothingScheduledAnd')}</p>
        )}
        {today.schedule.length > 0 && (
          <ul className="space-y-2" aria-label={t('aiHomeDashboard.todaysSchedule')}>
            {today.schedule.map((item) => (
              <li key={item.key}>
                <Link href={item.href} className="flex min-h-[44px] items-center gap-3 rounded-2xl border border-border bg-surface/40 px-4 py-3 transition hover:bg-elevated focus-ring">
                  <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-blue-500/10">
                    {item.kind === 'reminder' ? <Bell className="h-4 w-4 text-sky-400" aria-hidden /> : <Clock className="h-4 w-4 text-blue-400" aria-hidden />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">{item.title}</p>
                    <p className="text-xs text-muted">{item.allDay ? 'All day' : fmtTime(item.at)}</p>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {today.tasks.length > 0 && (
          <ul className="space-y-1.5" aria-label={t('aiHomeDashboard.dueToday')}>
            {today.tasks.map((item) => {
              const overdue = item.bucket === 'overdue';
              return (
                <li key={item.key}>
                  <Link href={item.href} className="flex min-h-[44px] items-center gap-3 rounded-xl border border-border/60 bg-surface/20 px-4 py-2.5 transition hover:bg-elevated focus-ring">
                    <span className={cn('h-4 w-4 shrink-0 rounded-full border-2', overdue ? 'border-rose-400/70' : 'border-emerald-400/60')} aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-sm">{item.title}</span>
                    <span className={cn('shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold', overdue ? 'bg-rose-500/15 text-rose-400' : 'bg-amber-500/15 text-amber-400')}>{item.reason}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Upcoming this week */}
      {hasUpcoming && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Calendar className="h-4 w-4 text-blue-400" />
              <h2 className="text-sm font-semibold text-muted uppercase tracking-wide">{t('aiHomeDashboard.comingUp')}</h2>
            </div>
            <Link href="/dashboard/calendar" className="text-xs font-semibold text-brand-text hover:underline">{t('aiHomeDashboard.calendar')}</Link>
          </div>
          <div className="space-y-1.5">
            {upcomingItems.map((item) => (
              <Link key={item.key} href={item.kind === 'reminder' ? '/dashboard/reminders' : '/dashboard/calendar'}
                className="flex items-center gap-3 rounded-xl border border-border/60 bg-surface/20 px-4 py-2.5 transition hover:bg-elevated">
                {item.kind === 'reminder'
                  ? <Bell className="h-4 w-4 shrink-0 text-sky-400" />
                  : <Calendar className="h-4 w-4 shrink-0 text-muted" />}
                <span className="flex-1 truncate text-sm">{item.title}</span>
                <span className="text-xs text-muted">
                  {item.allDay
                    ? new Date(item.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                    : new Date(item.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                </span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* §16 Completed By Bubaly — recent outcomes, partial ones labelled honestly */}
      <CompletedByBubaly items={completedItems} error={completedError} historyHref="/dashboard/concierge/runs?state=done" retryHref="/dashboard" />

      {/* Customizable, tier-aware quick actions */}
      <DashboardQuickActions
        fixed={FIXED_FEATURES}
        primaryKeys={primaryKeys}
        available={availableButtons}
        locked={lockedButtons}
        canCustomize={canCustomize}
        canManage={manager}
        settings={dashSettings}
      />

      {/* T3: Outcome-first home — a real "here's your week + next steps + dinners"
          instead of an empty "all caught up" card. */}
      {showOutcome && homeBrief && (
        <div className="space-y-4">
          <div className="rounded-2xl border border-brand/25 bg-gradient-to-br from-brand/10 to-violet-500/5 p-5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="flex items-center gap-2 text-sm font-bold"><Sparkles className="h-4 w-4 text-brand-text" /> {homeBrief.isSparse ? 'Your first wins' : 'Your week'}</p>
                <p className="mt-1 text-sm text-fg/85">{homeBrief.headline}</p>
              </div>
              <div className="shrink-0 text-right">
                <p className="text-2xl font-black leading-none">{homeBrief.readinessPct}%</p>
                <p className="text-[10px] uppercase tracking-wide text-muted">ready</p>
              </div>
            </div>
            <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-border">
              <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${homeBrief.readinessPct}%` }} />
            </div>
            {homeBrief.timeSavedMinutes > 0 && (
              <p className="mt-2 text-xs text-muted">{t('aiHomeDashboard.estimatedPlanningTimeNMinThisWeek', { minutes: homeBrief.timeSavedMinutes })}</p>
            )}
          </div>

          {/* Next best steps — real outcomes, unfinished first */}
          <div className="space-y-2">
            {homeBrief.steps.slice(0, 4).map((s) => (
              <Link key={s.id} href={s.href}
                className={cn('flex items-center gap-3 rounded-2xl border p-4 transition hover:bg-elevated',
                  s.done ? 'border-border/60 bg-surface/20' : 'border-border bg-surface/40')}>
                {s.done
                  ? <CircleCheck className="h-5 w-5 shrink-0 text-emerald-400" />
                  : <Circle className="h-5 w-5 shrink-0 text-brand-text" />}
                <div className="min-w-0 flex-1">
                  <p className={cn('truncate text-sm font-semibold', s.done && 'text-muted line-through')}>{s.label}</p>
                  <p className="truncate text-xs text-muted">{s.detail}</p>
                </div>
                {!s.done && <ChevronRight className="h-4 w-4 shrink-0 text-brand-text" />}
              </Link>
            ))}
          </div>

          {/* Dinner ideas — value even on a blank week */}
          {homeBrief.dinnerIdeas.length > 0 && (
            <div className="rounded-2xl border border-border bg-surface/40 p-4">
              <div className="mb-2 flex items-center justify-between">
                <p className="flex items-center gap-2 text-sm font-semibold"><Utensils className="h-4 w-4 text-brand-text" /> {t('aiHomeDashboard.dinnerIdeasForThisWeek')}</p>
                <Link href="/dashboard/meals" className="text-xs font-semibold text-brand-text hover:underline">{t('aiHomeDashboard.planMeals')}</Link>
              </div>
              <ul className="space-y-1.5 text-sm">
                {homeBrief.dinnerIdeas.map((d) => (
                  <li key={d.title} className="flex items-baseline justify-between gap-3">
                    <span className="truncate"><span className="font-medium">{d.title}</span> <span className="text-muted">· {d.cuisine}</span></span>
                    <span className="shrink-0 text-xs text-muted">{d.prepMinutes} min</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* AI nudge */}
      <Link href="/dashboard/assistant"
        className="flex items-center gap-4 rounded-2xl border border-brand/20 bg-gradient-to-r from-brand/10 to-violet-500/10 p-5 transition hover:border-brand/40">
        <div className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-brand/20">
          <Sparkles className="h-6 w-6 text-brand-text" />
        </div>
        <div className="flex-1">
          <p className="font-semibold">{t('aiHomeDashboard.askYourAiChiefOfStaff')}</p>
          <p className="mt-0.5 text-xs text-muted">{t('aiHomeDashboard.planMealsResolveScheduleConflictsDraft')}</p>
        </div>
        <ArrowRight className="h-5 w-5 shrink-0 text-brand-text" />
      </Link>
    </div>
  );
}
