// lib/home/needs-build.ts — assemble the unified "Needs you" list from each
// domain's already-fetched rows. PURE (no I/O) so it's shared by the Home
// dashboard AND the AI assistant's "what needs me?" tool, and unit-testable.

import type { NeedItem } from './needs-attention';
import {
  parentApprovalToNeed, renewalToNeed, documentExpiryToNeed,
  aiApprovalToNeed, awaitingRunToNeed, recommendationToNeed,
  factSuggestionToNeed, inboxMessageToNeed, paperworkActionsToNeeds,
  type ParentApprovalRow, type RenewalRow, type DocumentRow,
  type AiApprovalRow, type AwaitingRunRow, type RecommendationRow,
  type FactSuggestionRow, type InboxMessageRow, type PaperworkRow,
} from './needs-sources';

export type HomeNeedsInput = {
  approvals: ParentApprovalRow[];
  renewals: RenewalRow[];
  documents: DocumentRow[];
  conflicts: { id: string; assigneeName: string | null; count: number; startsAt: string }[];
  pendingApprovals: number;
  overdueMeds: boolean;
  overdueReminders: number;
  dueTodayReminders: number;
  pendingChores: number;
  lowGrocery: boolean;
  openTodos: number;
  now: Date;
  /** Pending `approval_requests` Bubaly opened (§12) — optional so older callers keep working. */
  aiApprovals?: AiApprovalRow[];
  /** Runs parked in `awaiting_approval` / `awaiting_context`. */
  awaitingRuns?: AwaitingRunRow[];
  /** Pending `family_ai_recommendations` (§11 level 1). */
  recommendations?: RecommendationRow[];
  /** `family_playbook_suggestions` still 'suggested' — memories Bubaly inferred and nobody confirmed (M5). */
  factSuggestions?: FactSuggestionRow[];
  /** `family_inbox_messages` rows; the mapper keeps only unread inbound ones that want a human reply (M5). */
  inboxMessages?: InboxMessageRow[];
  /** Open `paperwork_items`; each unmaterialised sign / pay / RSVP action becomes its own item (M5). */
  paperwork?: PaperworkRow[];
};

/**
 * Union every cross-domain item actually waiting on the family into one
 * `NeedItem[]` (unranked — callers rank via rankNeedsAttention/topNeeds). The
 * non-trivial domains go through tested mappers; count-based signals are pushed
 * inline.
 */
export function buildHomeNeeds(data: HomeNeedsInput): NeedItem[] {
  const items: NeedItem[] = [];
  const nowIso = data.now.toISOString();
  const plural = (n: number) => (n > 1 ? 's' : '');

  for (const a of data.approvals) items.push(parentApprovalToNeed(a));

  // An approval that gates a run and the run parked on it are ONE decision:
  // the approval card is the actionable half (Approve / Edit / Decline resumes
  // the run), so the run's own "waiting for your OK" line is dropped rather
  // than shown twice.
  const gatedRunIds = new Set<string>();
  for (const a of data.aiApprovals ?? []) {
    items.push(aiApprovalToNeed(a));
    if (a.runId) gatedRunIds.add(a.runId);
  }
  for (const r of data.awaitingRuns ?? []) {
    if (r.state === 'awaiting_approval' && gatedRunIds.has(r.id)) continue;
    const n = awaitingRunToNeed(r);
    if (n) items.push(n);
  }
  for (const r of data.recommendations ?? []) items.push(recommendationToNeed(r));
  // M5: the three sources that never reached the queue before. Each mapper
  // returns null / [] for a row that needs nobody (lapsed suggestion, read or
  // outbound message, materialised action), so the reader can pass rows as
  // they come off the table.
  for (const r of data.factSuggestions ?? []) { const n = factSuggestionToNeed(r, data.now); if (n) items.push(n); }
  for (const r of data.inboxMessages ?? []) { const n = inboxMessageToNeed(r); if (n) items.push(n); }
  for (const r of data.paperwork ?? []) items.push(...paperworkActionsToNeeds(r, data.now));
  for (const r of data.renewals) { const n = renewalToNeed(r, data.now); if (n) items.push(n); }
  for (const d of data.documents) { const n = documentExpiryToNeed(d, data.now); if (n) items.push(n); }
  for (const c of data.conflicts)
    items.push({
      id: `conflict:${c.id}`, kind: 'calendar_conflict',
      title: c.assigneeName ? `${c.assigneeName}: ${c.count} events overlap` : `${c.count} events overlap`,
      href: '/dashboard/calendar', urgency: 'urgent', createdAt: c.startsAt,
    });

  if (data.pendingApprovals > 0)
    items.push({ id: 'chore-signoff', kind: 'chore_signoff', title: `${data.pendingApprovals} chore${plural(data.pendingApprovals)} awaiting approval`, href: '/dashboard/chores', urgency: 'urgent', createdAt: nowIso });
  if (data.overdueMeds)
    items.push({ id: 'meds', kind: 'meds', title: 'Medication due today', href: '/dashboard/medications', urgency: 'urgent', createdAt: nowIso });
  if (data.overdueReminders > 0)
    items.push({ id: 'reminders-overdue', kind: 'reminder_overdue', title: `${data.overdueReminders} reminder${plural(data.overdueReminders)} overdue`, href: '/dashboard/reminders', urgency: 'urgent', createdAt: nowIso });
  else if (data.dueTodayReminders > 0)
    items.push({ id: 'reminders-today', kind: 'reminder_today', title: `${data.dueTodayReminders} reminder${plural(data.dueTodayReminders)} due today`, href: '/dashboard/reminders', urgency: 'normal', createdAt: nowIso });
  if (data.pendingChores > 0)
    items.push({ id: 'chores-todo', kind: 'chores_todo', title: `${data.pendingChores} task${plural(data.pendingChores)} to do today`, href: '/dashboard/chores', urgency: 'normal', createdAt: nowIso });
  if (data.lowGrocery)
    items.push({ id: 'grocery', kind: 'grocery', title: 'Grocery list needs updating', href: '/dashboard/grocery', urgency: 'normal', createdAt: nowIso });
  if (data.openTodos > 0)
    items.push({ id: 'todos', kind: 'todos', title: `${data.openTodos} to-do item${plural(data.openTodos)} open`, href: '/dashboard/todos', urgency: 'normal', createdAt: nowIso });

  return items;
}
