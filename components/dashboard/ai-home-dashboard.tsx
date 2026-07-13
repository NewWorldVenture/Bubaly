import Link from 'next/link';
import {
  Sparkles, Calendar, CheckSquare, ShoppingCart, HeartPulse,
  ArrowRight, Bell, ChevronRight, Home, Pill, GraduationCap,
  Trophy, Sun, Clock, Users, MessageSquare, Plane, PhoneCall, AlarmClock, RefreshCw, CalendarClock, FileClock,
} from 'lucide-react';
import { createServer } from '@/lib/supabase/server';
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
import { HomeAskBar } from '@/components/dashboard/home-ask-bar';
import { Heart } from 'lucide-react';
import { upcomingRelationship, formatCountdown, milestoneLabel, type RelKind } from '@/lib/relationship/dates';
import { reminderAttention } from '@/lib/dashboard/reminder-attention';
import { mergeUpcoming } from '@/lib/dashboard/upcoming';
import { topNeeds, summarizeNeeds, needsHeadline, type NeedItem } from '@/lib/home/needs-attention';
import { type ParentApprovalRow, type RenewalRow, type DocumentRow } from '@/lib/home/needs-sources';
import { buildHomeNeeds } from '@/lib/home/needs-build';
import { detectConflicts, type ConflictEvent } from '@/lib/home/conflicts';
import { HomeApprovalActions } from '@/components/dashboard/home-approval-actions';
import { buildHomeBrief, homeBriefSummary } from '@/lib/home/home-brief';
import type { DinnerIdea, DinnerEffort } from '@/lib/onboarding/dinner-ideas';
import { CircleCheck, Circle, Utensils } from 'lucide-react';
import { buildInsightCandidates, rankInsights, type InsightKind, type InsightSources } from '@/lib/home/insight-of-day';
import { InsightHero } from '@/components/dashboard/insight-hero';

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function todayLabel() {
  return new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

// Render metadata (icon + accent + CTA + fallback subtitle) per NeedItem.kind.
type NeedRenderMeta = { icon: React.ComponentType<{ className?: string }>; iconBg: string; cta: string; subtitle: string };
const NEED_META: Record<string, NeedRenderMeta> = {
  approval: { icon: ShieldCheck, iconBg: 'bg-amber-500/15 text-amber-400', cta: 'Review', subtitle: 'A family member is waiting on your approval.' },
  calendar_conflict: { icon: CalendarClock, iconBg: 'bg-rose-500/15 text-rose-400', cta: 'Resolve', subtitle: 'Two events are double-booked.' },
  renewal: { icon: RefreshCw, iconBg: 'bg-orange-500/15 text-orange-400', cta: 'Renew', subtitle: 'Renew it before it lapses.' },
  document: { icon: FileClock, iconBg: 'bg-orange-500/15 text-orange-400', cta: 'View', subtitle: 'A document is expiring soon.' },
  chore_signoff: { icon: CheckSquare, iconBg: 'bg-amber-500/15 text-amber-400', cta: 'Review', subtitle: 'Chores are waiting for your sign-off.' },
  reminder_overdue: { icon: AlarmClock, iconBg: 'bg-rose-500/15 text-rose-400', cta: 'Catch up', subtitle: 'These were due earlier.' },
  meds: { icon: Pill, iconBg: 'bg-rose-500/15 text-rose-400', cta: 'View', subtitle: 'Check the medication schedule.' },
  reminder_today: { icon: Bell, iconBg: 'bg-sky-500/15 text-sky-400', cta: 'View', subtitle: 'Coming up today.' },
  chores_todo: { icon: CheckSquare, iconBg: 'bg-violet-500/15 text-violet-400', cta: 'View', subtitle: 'Keep the momentum going.' },
  grocery: { icon: ShoppingCart, iconBg: 'bg-emerald-500/15 text-emerald-400', cta: 'Update', subtitle: 'Items may be running low.' },
  todos: { icon: CheckSquare, iconBg: 'bg-teal-500/15 text-teal-400', cta: 'View', subtitle: 'Personal items waiting for you.' },
};
const DEFAULT_NEED_META: NeedRenderMeta = { icon: Bell, iconBg: 'bg-brand/15 text-brand-text', cta: 'View', subtitle: '' };

export async function AiHomeDashboard({ ctx }: { ctx: UserContext }) {
  const familyId = ctx.active.familyId;
  const me = ctx.active.member;
  const myMemberId = me.id;
  const manager = isManager(ctx.active.role);
  const supabase = await createServer();

  const now = new Date();
  const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date(todayStart); todayEnd.setDate(todayEnd.getDate() + 1);

  const [
    { count: pendingChores },
    { data: todayEvents },
    { count: groceryCount },
    { count: overdueMedsCount },
    { count: pendingApprovals },
    { count: openTodos },
    { data: members },
    { data: upcomingEvents },
    { data: recentActivity },
    { data: autopilotOpen },
    { count: autopilotHandledCount },
    { count: unreadCommsCount },
    { data: activeConcierge },
    { count: unreadCallsCount },
    { data: layoutRows },
    famPlanLevel,
    { data: relDateRows },
    { data: dueReminderRows },
    { data: weekReminderRows },
    { data: approvalRows },
    { data: renewalRows },
    { data: conflictEventRows },
    { data: documentRows },
    { data: homeworkRows },
    { count: plannedDinnerCount },
  ] = await Promise.all([
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
    supabase.from('audit_logs').select('id, action, entity_type, created_at')
      .eq('family_id', familyId).order('created_at', { ascending: false }).limit(5),
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
    resolveFamilyPlanLevel(supabase, familyId),
    supabase.from('relationship_dates').select('id, kind, title, event_date, recurs_annually, reminder_days_before, status')
      .eq('family_id', familyId).neq('status', 'cancelled').limit(100),
    supabase.from('family_reminders').select('id, remind_at, status')
      .eq('family_id', familyId).eq('status', 'active').not('remind_at', 'is', null)
      .or(`member_id.eq.${myMemberId},member_id.is.null`)
      .lte('remind_at', todayEnd.toISOString()).limit(100),
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
  });
  const needs = topNeeds(homeNeeds, 5);
  const needsHeader = needsHeadline(summarizeNeeds(homeNeeds));
  // Map each approval need back to its row so the card can offer one-tap approve.
  const approvalKindByNeedId = new Map<string, string>(
    ((approvalRows ?? []) as ParentApprovalRow[]).map((a) => [`approval:${a.id}`, a.kind]),
  );

  const name = me.display_name ?? ctx.user.email?.split('@')[0] ?? 'there';
  const hasEvents = (todayEvents ?? []).length > 0;

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

    // Persist today's snapshot (idempotent, one row/family/day) — the durable
    // "never empty" record + TTFV signal. Best-effort: never block the render.
    try {
      await supabase.from('home_briefs').upsert({
        family_id: familyId,
        as_of_date: todayStart.toISOString().slice(0, 10),
        is_sparse: homeBrief.isSparse,
        readiness_pct: homeBrief.readinessPct,
        week_count: homeBrief.weekCount,
        conflict_count: homeBrief.conflictCount,
        dinner_count: homeBrief.dinnerIdeas.length,
        time_saved_minutes: homeBrief.timeSavedMinutes,
        headline: homeBrief.headline,
        brief: homeBriefSummary(homeBrief) as never,
        created_by: ctx.user.id,
      }, { onConflict: 'family_id,as_of_date' });
    } catch { /* best-effort snapshot */ }
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
          <Sparkles className="h-3.5 w-3.5" /> Ask AI
        </Link>
      </div>

      {/* Ask-anything bar → deep-links to the assistant (auto-sends) */}
      <HomeAskBar />

      {/* T4: the one proactive insight of the day, above the fold */}
      {insightRow && <InsightHero insight={insightRow} />}

      {/* Relationship reminder — gentle proactive nudge for an upcoming date */}
      {relReminder && (
        <Link href="/dashboard/relationship"
          className="flex items-center gap-3 rounded-2xl border border-rose-500/30 bg-rose-500/5 px-4 py-3 transition hover:bg-rose-500/10">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-rose-500/15 text-rose-300"><Heart className="h-5 w-5" /></div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">{relReminder.title} {formatCountdown(relReminder.days).toLowerCase()}</p>
            <p className="truncate text-xs text-muted">{milestoneLabel(relReminder) ?? 'Plan something special'} · tap for gift ideas</p>
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
                <p className="text-sm font-bold">Family Autopilot</p>
                <p className="text-xs text-muted">Bubaly is watching over today</p>
              </div>
            </div>
            <ArrowRight className="h-4 w-4 text-brand-text" />
          </div>

          <div className="mt-4 flex items-center gap-5">
            <div className="flex items-center gap-2">
              <Gauge className={cn('h-4 w-4', autopilotProbability >= 85 ? 'text-emerald-400' : autopilotProbability >= 60 ? 'text-amber-400' : 'text-rose-400')} />
              <span className="text-lg font-black">{autopilotProbability}%</span>
              <span className="text-[11px] text-muted">on track</span>
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
                <span className="text-[11px] text-muted">to review</span>
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
            <p className="text-sm font-semibold">Front Desk</p>
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
            <p className="text-sm font-semibold">Inbox</p>
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
            <p className="text-sm font-semibold">Concierge</p>
            <p className="truncate text-xs text-muted">
              {concierge.length > 0 ? concierge[0].title : 'Plan something fun'}
            </p>
          </div>
        </Link>
      </div>

      {/* Needs you — the single, ranked cross-domain decision queue */}
      {needs.shown.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-brand-text" />
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Needs you</h2>
          </div>
          <p className="-mt-1 text-sm text-fg/80">{needsHeader}</p>
          <div className="space-y-2.5">
            {needs.shown.map((item) => {
              const meta = NEED_META[item.kind] ?? DEFAULT_NEED_META;
              const Icon = meta.icon;
              const urgent = item.urgency === 'urgent' || item.urgency === 'emergency';
              const approvalKind = item.kind === 'approval' ? approvalKindByNeedId.get(item.id) : undefined;
              const cardClass = cn(
                'flex items-center gap-4 rounded-2xl border p-4 transition',
                urgent ? 'border-amber-500/20 bg-amber-500/5' : 'border-border bg-surface/40',
              );
              const body = (
                <>
                  <div className={cn('grid h-11 w-11 shrink-0 place-items-center rounded-xl', meta.iconBg)}>
                    <Icon className="h-5 w-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">{item.title}</p>
                    {meta.subtitle && <p className="mt-0.5 truncate text-xs text-muted">{meta.subtitle}</p>}
                  </div>
                </>
              );
              // Approvals get one-tap Approve/Decline inline (buttons can't nest in
              // an <a>, so the card is a div with the title linking out).
              if (approvalKind !== undefined) {
                return (
                  <div key={item.id} className={cardClass}>
                    <Link href={item.href} className="flex min-w-0 flex-1 items-center gap-4 hover:opacity-90">{body}</Link>
                    <HomeApprovalActions approvalId={item.id.slice('approval:'.length)} kind={approvalKind} />
                  </div>
                );
              }
              return (
                <Link key={item.id} href={item.href} className={cn(cardClass, 'hover:bg-elevated')}>
                  {body}
                  <div className="flex shrink-0 items-center gap-1 text-xs font-semibold text-brand-text">
                    {meta.cta} <ChevronRight className="h-3.5 w-3.5" />
                  </div>
                </Link>
              );
            })}
          </div>
          {needs.more > 0 && (
            <p className="text-xs text-muted">+{needs.more} more {needs.more === 1 ? 'item' : 'items'} need you.</p>
          )}
        </div>
      )}

      {/* Today's schedule */}
      {hasEvents && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Sun className="h-4 w-4 text-amber-400" />
              <h2 className="text-sm font-semibold text-muted uppercase tracking-wide">Today</h2>
            </div>
            <Link href="/dashboard/calendar" className="text-xs font-semibold text-brand-text hover:underline">View all</Link>
          </div>
          <div className="space-y-2">
            {(todayEvents ?? []).map((ev) => (
              <div key={ev.id} className="flex items-center gap-3 rounded-2xl border border-border bg-surface/40 px-4 py-3">
                <div className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-blue-500/10">
                  <Clock className="h-4 w-4 text-blue-400" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{ev.title}</p>
                  <p className="text-xs text-muted">{ev.all_day ? 'All day' : fmtTime(ev.starts_at)}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Upcoming this week */}
      {hasUpcoming && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Calendar className="h-4 w-4 text-blue-400" />
              <h2 className="text-sm font-semibold text-muted uppercase tracking-wide">Coming Up</h2>
            </div>
            <Link href="/dashboard/calendar" className="text-xs font-semibold text-brand-text hover:underline">Calendar</Link>
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
              <p className="mt-2 text-xs text-muted">Bubaly’s already saved you ~{homeBrief.timeSavedMinutes} min of planning this week.</p>
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
                <p className="flex items-center gap-2 text-sm font-semibold"><Utensils className="h-4 w-4 text-brand-text" /> Dinner ideas for this week</p>
                <Link href="/dashboard/meals" className="text-xs font-semibold text-brand-text hover:underline">Plan meals</Link>
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
          <p className="font-semibold">Ask your AI Chief of Staff</p>
          <p className="mt-0.5 text-xs text-muted">Plan meals, resolve schedule conflicts, draft messages…</p>
        </div>
        <ArrowRight className="h-5 w-5 shrink-0 text-brand-text" />
      </Link>
    </div>
  );
}
