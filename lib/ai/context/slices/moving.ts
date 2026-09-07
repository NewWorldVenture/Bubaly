// The move on file and what a move plan personalises from: the tracked
// subscriptions and recurring bills that need a new address, each child's
// school, each pet's vet. Names only — never an amount, an account number or
// a phone number — and manager-only, because half of it is the family's money.
//
// Loaded for `plan_move` alone (§27), and read back by the planner into the
// template context so `plan-move.ts` can write one task per real row instead
// of a generic "update your subscriptions".
import 'server-only';
import { fenceUntrusted } from '@/lib/ai/safety/untrusted';
import { getMove, listMoveSources } from '@/lib/services/moving';
import { ok } from '@/lib/services/types';
import { memberName, type SliceDefinition } from '../policy';
import { dayKeyLabel, joinNatural } from '../render';

export type MovingSliceData = {
  move: {
    id: string; title: string; moveDate: string; status: string; moveKind: string; hasKids: boolean; hasPets: boolean;
    daysToMove: number; taskCount: number; openCount: number; overdue: number;
    /** The template keys already generated, so a plan knows what the timeline already covers. */
    templateKeys: string[];
  } | null;
  subscriptions: { id: string; name: string }[];
  bills: { id: string; name: string; category: string | null }[];
  schoolClasses: { memberId: string; memberName: string | null; schoolName: string | null }[];
  pets: { id: string; name: string; vetName: string | null }[];
};

export const movingSlice: SliceDefinition = {
  name: 'moving',
  title: 'Move',
  async load(scope, env) {
    const [move, sources] = await Promise.all([getMove(scope), listMoveSources(scope)]);
    if (!move.ok) return move;
    if (!sources.ok) return sources;

    const data: MovingSliceData = {
      move: move.data ? {
        id: move.data.move.id, title: move.data.move.title, moveDate: move.data.move.move_date, status: move.data.move.status,
        moveKind: move.data.move.move_kind, hasKids: move.data.move.has_kids, hasPets: move.data.move.has_pets,
        daysToMove: move.data.summary.daysToMove, taskCount: move.data.summary.total, openCount: move.data.summary.total - move.data.summary.done,
        overdue: move.data.summary.overdue,
        templateKeys: move.data.tasks.map((t) => t.template_key).filter((k): k is string => Boolean(k)),
      } : null,
      subscriptions: sources.data.subscriptions,
      bills: sources.data.bills,
      schoolClasses: sources.data.schoolClasses.map((c) => ({ ...c, memberName: memberName(env, c.memberId) })),
      pets: sources.data.pets,
    };

    const lines: string[] = [];
    if (data.move) {
      const m = data.move;
      lines.push(`- Move on file: ${fenceUntrusted('move', m.title)} on ${dayKeyLabel(m.moveDate)} (${m.daysToMove >= 0 ? `in ${m.daysToMove} day${m.daysToMove === 1 ? '' : 's'}` : `${-m.daysToMove} days ago`}, ${m.status}, ${m.moveKind}${m.hasKids ? ', kids' : ''}${m.hasPets ? ', pets' : ''}) — ${m.taskCount} task${m.taskCount === 1 ? '' : 's'}, ${m.openCount} open${m.overdue ? `, ${m.overdue} overdue` : ''}`);
    } else {
      lines.push('- No move on file yet.');
    }
    if (data.subscriptions.length) lines.push(`- Subscriptions needing a new address: ${joinNatural(data.subscriptions.map((s) => fenceUntrusted('subscription', s.name)), 12)}`);
    if (data.bills.length) lines.push(`- Recurring bills needing a new address: ${joinNatural(data.bills.map((b) => fenceUntrusted('bill', b.name)), 12)}`);
    for (const c of data.schoolClasses) lines.push(`- School: ${c.memberName ?? 'a child'}${c.schoolName ? ` at ${fenceUntrusted('school', c.schoolName)}` : ''}`);
    for (const p of data.pets) lines.push(`- Pet: ${fenceUntrusted('pet', p.name)}${p.vetName ? ` (vet: ${fenceUntrusted('vet', p.vetName)})` : ''}`);

    return ok({ data, count: (data.move ? 1 : 0) + data.subscriptions.length + data.bills.length + data.schoolClasses.length + data.pets.length, lines });
  },
};
