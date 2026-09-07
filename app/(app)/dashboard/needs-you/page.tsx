// /dashboard/needs-you — M5 "Needs Your Decision": every decision waiting on a
// person, uncapped.
//
// Home ranks the same queue but shows five and rolls the rest into "+N more";
// this page is where that link lands. It reads the same sources Home does
// (Bubaly's approvals, runs parked on a person, level-1 recommendations, money
// approvals, chore sign-offs, overdue reminders) plus the three M5 sources
// that never reached the queue before — memories Bubaly inferred but nobody
// confirmed, messages to the family's own number/address that want a reply,
// and open sign / pay / RSVP actions on paperwork — through the one pure
// builder (`buildHomeNeeds`) and the one ranking (`rankNeedsAttention`).
//
// Read boundary: "nothing needs you" is a claim, so every read here fails
// closed. A single failed source renders a retryable error state rather than
// a shorter, reassuring list.
import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { isManager } from '@/lib/constants/roles';
import { PageHeader } from '@/components/app/page-header';
import { ErrorState } from '@/components/ui/states';
import { NeedsAttention } from '@/components/concierge/needs-attention';
import { buildHomeNeeds } from '@/lib/home/needs-build';
import { needsHeadline, rankNeedsAttention, summarizeNeeds } from '@/lib/home/needs-attention';
import {
  REPLY_INTENTS,
  type AwaitingRunRow, type FactSuggestionRow, type InboxMessageRow, type PaperworkRow, type ParentApprovalRow, type RecommendationRow,
} from '@/lib/home/needs-sources';
import { listPending } from '@/lib/services/approvals';
import { listMemories } from '@/lib/services/memory';
import { scopeFromUserContext } from '@/lib/services/scope';

export const metadata: Metadata = { title: 'Needs your decision' };
export const dynamic = 'force-dynamic';

export default async function NeedsYouPage() {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();
  const scope = scopeFromUserContext(ctx, supabase);
  const now = new Date();
  const manager = isManager(ctx.active.role);

  const [
    aiApprovalsRes, memoriesRes, awaitingRunsRes, recsRes, moneyApprovalsRes, choreSignoffRes, overdueRemindersRes, inboxRes, paperworkRes,
  ] = await Promise.all([
    listPending(scope),
    // The memory service applies the same visibility rule the knowledge page
    // does (sensitive categories are for managers), so a child's queue never
    // carries a medical inference to confirm.
    listMemories(scope),
    supabase.from('family_automation_runs').select('id, summary, state, updated_at, created_at')
      .eq('family_id', familyId).in('state', ['awaiting_approval', 'awaiting_context']).order('updated_at', { ascending: false }).limit(50),
    supabase.from('family_ai_recommendations').select('id, title, body, priority, cta_href, created_at')
      .eq('family_id', familyId).eq('status', 'pending').order('created_at', { ascending: false }).limit(50),
    manager
      ? supabase.from('parent_approvals').select('id, kind, amount_cents, created_at')
          .eq('family_id', familyId).eq('status', 'pending').order('created_at', { ascending: false }).limit(50)
      : Promise.resolve({ data: [] as ParentApprovalRow[], error: null }),
    manager
      ? supabase.from('chore_assignments').select('id', { count: 'exact', head: true }).eq('family_id', familyId).eq('status', 'submitted')
      : Promise.resolve({ count: 0, error: null }),
    supabase.from('family_reminders').select('id', { count: 'exact', head: true })
      .eq('family_id', familyId).eq('status', 'active').not('remind_at', 'is', null).lt('remind_at', now.toISOString()),
    supabase.from('family_inbox_messages').select('id, direction, from_addr, subject, ai_summary, body, ai_intent, status, occurred_at')
      .eq('family_id', familyId).eq('status', 'new').eq('direction', 'inbound').in('ai_intent', [...REPLY_INTENTS])
      .order('occurred_at', { ascending: false }).limit(50),
    supabase.from('paperwork_items').select('id, title, status, urgency, due_on, actions, created_at')
      .eq('family_id', familyId).in('status', ['needs_action', 'in_progress']).order('created_at', { ascending: false }).limit(100),
  ]);

  const failures: { label: string; error: unknown }[] = [];
  if (!aiApprovalsRes.ok) failures.push({ label: 'pending AI approvals', error: aiApprovalsRes.error });
  if (!memoriesRes.ok) failures.push({ label: 'memory suggestions', error: memoriesRes.error });
  for (const [label, res] of [
    ['awaiting runs', awaitingRunsRes], ['recommendations', recsRes], ['money approvals', moneyApprovalsRes],
    ['chore sign-offs', choreSignoffRes], ['overdue reminders', overdueRemindersRes], ['inbox messages', inboxRes], ['paperwork', paperworkRes],
  ] as const) {
    if (res.error) failures.push({ label, error: res.error });
  }
  if (failures.length) {
    for (const f of failures) console.error(`[needs-you] ${f.label} read failed`, f.error);
    return (
      <div className="module-page">
        <PageHeader title={t('needsYou.needsYourDecision')} description={t('needsYou.everythingWaitingOnAPerson')} />
        <ErrorState message={t('needsYou.couldNotLoadWhatNeeds')} />
      </div>
    );
  }

  const aiApprovals = aiApprovalsRes.ok ? aiApprovalsRes.data : [];
  const recommendations = (recsRes.data ?? []) as (RecommendationRow & { body: string | null })[];
  const moneyApprovals = (moneyApprovalsRes.data ?? []) as ParentApprovalRow[];
  const factSuggestions: FactSuggestionRow[] = memoriesRes.ok
    ? memoriesRes.data.pending.map((s) => ({ id: s.id, label: s.label, value: s.value, expires_at: s.expires_at, created_at: s.created_at }))
    : [];

  const all = buildHomeNeeds({
    approvals: moneyApprovals,
    renewals: [], documents: [], conflicts: [],
    pendingApprovals: choreSignoffRes.count ?? 0,
    overdueMeds: false,
    overdueReminders: overdueRemindersRes.count ?? 0,
    dueTodayReminders: 0,
    pendingChores: 0, lowGrocery: false, openTodos: 0,
    now,
    aiApprovals: aiApprovals.map((a) => ({ id: a.id, title: a.title, runId: a.runId, priority: a.priority ?? null, requestedAt: a.requestedAt, expiresAt: a.expiresAt })),
    awaitingRuns: (awaitingRunsRes.data ?? []) as AwaitingRunRow[],
    recommendations,
    factSuggestions,
    inboxMessages: (inboxRes.data ?? []) as InboxMessageRow[],
    paperwork: (paperworkRes.data ?? []) as PaperworkRow[],
  });
  const items = rankNeedsAttention(all);

  return (
    <div className="module-page">
      <PageHeader title={t('needsYou.needsYourDecision')} description={t('needsYou.everythingWaitingOnAPerson')} />
      <NeedsAttention
        items={items}
        more={0}
        headline={needsHeadline(summarizeNeeds(all))}
        approvals={Object.fromEntries(aiApprovals.map((a) => [a.id, a]))}
        moneyApprovalKinds={Object.fromEntries(moneyApprovals.map((a) => [a.id, a.kind]))}
        recommendationBodies={Object.fromEntries(recommendations.map((r) => [r.id, r.body]))}
        canDecide={manager}
      />
    </div>
  );
}
