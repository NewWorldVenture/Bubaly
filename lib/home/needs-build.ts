// lib/home/needs-build.ts — assemble the unified "Needs you" list from each
// domain's already-fetched rows. PURE (no I/O) so it's shared by the Home
// dashboard AND the AI assistant's "what needs me?" tool, and unit-testable.

import type { NeedItem } from './needs-attention';
import {
  parentApprovalToNeed, renewalToNeed, documentExpiryToNeed,
  type ParentApprovalRow, type RenewalRow, type DocumentRow,
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
