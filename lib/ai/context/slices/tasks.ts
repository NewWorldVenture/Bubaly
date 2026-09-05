// Open to-dos and chores, who carries them, and how fair the split is.
// `computeWorkload` (lib/workload/balance.ts) is the same mental-load engine
// the dashboard uses, so the planner's "Maya is already at 60% of the load"
// and the Workload page agree on the number.
import 'server-only';
import { fenceUntrusted } from '@/lib/ai/safety/untrusted';
import { listOpenChores, searchTodos } from '@/lib/services/tasks';
import { fail, ok, SERVICE_CODES } from '@/lib/services/types';
import { describeDbError } from '@/lib/supabase/errors';
import { computeWorkload, type WorkloadChoreAssignment } from '@/lib/workload/balance';
import { memberName, type SliceDefinition } from '../policy';
import { dayKeyLabel, when } from '../render';

const MAX_TODOS = 40;
const MAX_CHORES = 60;
const MAX_SUGGESTIONS = 3;

export type TasksSliceData = {
  todos: { id: string; title: string; dueDate: string | null; assignee: string | null; priority: string }[];
  chores: { id: string; title: string; member: string | null; dueAt: string | null; status: string; estMinutes: number | null }[];
  workload: {
    fairness: number;
    headline: string;
    loads: { name: string; role: string; sharePct: number; choreCount: number; taskCount: number; overloaded: boolean }[];
    suggestions: { choreTitle: string; fromName: string; toName: string; minutes: number; reason: string }[];
  };
};

export const tasksSlice: SliceDefinition = {
  name: 'tasks',
  title: 'Tasks and chores',
  async load(scope, env) {
    const [todos, assignments] = await Promise.all([
      searchTodos(scope, { done: false, limit: MAX_TODOS }),
      listOpenChores(scope, { limit: MAX_CHORES }),
    ]);
    if (!todos.ok) return todos;
    if (!assignments.ok) return assignments;

    // Assignments carry only the chore id; the titles come from `chores`, read
    // once for the ids on the board rather than per assignment.
    const choreIds = [...new Set(assignments.data.map((a) => a.chore_id))];
    const choreRows = choreIds.length
      ? await scope.db.from('chores').select('id, title, est_minutes, points').eq('family_id', scope.familyId).in('id', choreIds)
      : { data: [], error: null };
    if (choreRows.error) {
      console.error('[ai-context:tasks] chores read failed', choreRows.error);
      return fail(describeDbError(choreRows.error, 'Could not load the chore board.'), { code: SERVICE_CODES.db });
    }
    const chores = new Map((choreRows.data ?? []).map((c) => [c.id, c]));

    const workloadAssignments: WorkloadChoreAssignment[] = assignments.data.map((a) => {
      const chore = chores.get(a.chore_id);
      return {
        id: a.id, choreId: a.chore_id, memberId: a.member_id, status: a.status,
        choreTitle: chore?.title ?? 'Chore', estMinutes: chore?.est_minutes ?? null, points: chore?.points ?? 0,
      };
    });
    const report = computeWorkload(
      env.members.map((m) => ({ id: m.id, name: m.displayName, role: m.role })),
      workloadAssignments,
      todos.data.map((t) => ({ assignedToId: t.assigned_to_id, isDone: t.is_done })),
      [],
    );

    const data: TasksSliceData = {
      todos: todos.data.map((t) => ({ id: t.id, title: t.title, dueDate: t.due_date, assignee: memberName(env, t.assigned_to_id), priority: t.priority })),
      chores: assignments.data.map((a) => ({
        id: a.id, title: chores.get(a.chore_id)?.title ?? 'Chore', member: memberName(env, a.member_id), dueAt: a.due_at, status: a.status,
        estMinutes: chores.get(a.chore_id)?.est_minutes ?? null,
      })),
      workload: {
        fairness: report.fairness,
        headline: report.headline,
        loads: report.loads.map((l) => ({
          name: memberName(env, l.memberId) ?? l.name, role: l.role, sharePct: l.sharePct, choreCount: l.choreCount, taskCount: l.taskCount, overloaded: l.overloaded,
        })),
        suggestions: report.suggestions.slice(0, MAX_SUGGESTIONS).map((s) => ({
          choreTitle: s.choreTitle, fromName: memberName(env, s.fromMemberId) ?? s.fromName, toName: memberName(env, s.toMemberId) ?? s.toName, minutes: s.minutes, reason: s.reason,
        })),
      },
    };

    const lines: string[] = [];
    lines.push(`- ${data.todos.length} open to-do${data.todos.length === 1 ? '' : 's'}, ${data.chores.length} open chore${data.chores.length === 1 ? '' : 's'}`);
    const overdue = data.todos.filter((t) => t.dueDate && t.dueDate < env.todayKey);
    for (const t of data.todos) {
      const bits = [`- To-do: ${fenceUntrusted('todo', t.title)}`];
      if (t.dueDate) bits.push(overdue.includes(t) ? `OVERDUE since ${dayKeyLabel(t.dueDate)}` : `due ${dayKeyLabel(t.dueDate)}`);
      if (t.assignee) bits.push(`(${t.assignee})`);
      if (t.priority === 'high' || t.priority === 'urgent') bits.push(`[${t.priority}]`);
      lines.push(bits.join(' '));
    }
    for (const c of data.chores) {
      const bits = [`- Chore: ${fenceUntrusted('chore', c.title)}`];
      if (c.member) bits.push(`for ${c.member}`);
      if (c.dueAt) bits.push(`due ${when(c.dueAt, env.tz, env.now)}`);
      if (c.status === 'submitted') bits.push('(awaiting approval)');
      lines.push(bits.join(' '));
    }
    if (data.workload.loads.length > 1) {
      const shares = data.workload.loads.filter((l) => l.sharePct > 0).map((l) => `${l.name} ${l.sharePct}%${l.overloaded ? ' (overloaded)' : ''}`);
      if (shares.length) lines.push(`- Load split (fairness ${data.workload.fairness}/100): ${shares.join(', ')}`);
      for (const s of data.workload.suggestions) {
        lines.push(`- Rebalance idea: move ${fenceUntrusted('chore', s.choreTitle)} from ${s.fromName} to ${s.toName} (${s.minutes} min)`);
      }
    }

    return ok({ data, count: data.todos.length + data.chores.length, lines });
  },
};
