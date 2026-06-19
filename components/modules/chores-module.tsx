'use client';

import { useMemo, useState } from 'react';
import { CheckSquare, Plus, Trophy, Check, X, Clock, Trash2 } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { useToast } from '@/components/ui/toast';
import { isManager } from '@/lib/constants/roles';
import { PageHeader } from '@/components/app/page-header';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Avatar } from '@/components/ui/avatar';
import { Modal } from '@/components/ui/modal';
import { Input, Field, Select } from '@/components/ui/input';
import { LoadingBlock, EmptyState, ErrorState } from '@/components/ui/states';
import { fmtRelative } from '@/lib/utils/format';
import type { Tables } from '@/lib/database.types';

type Chore = Tables<'chores'>;
type Assignment = Tables<'chore_assignments'> & { chore: Chore | null };

const PRIORITY_TONE = { low: 'neutral', medium: 'brand', high: 'danger' } as const;

export function ChoresModule() {
  const { familyId, userId, role, members, selfMember } = useApp();
  const { success, error: toastError } = useToast();
  const manager = isManager(role);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const { data, loading, error, refresh } = useRealtimeQuery<Assignment>({
    table: 'chore_assignments',
    familyId,
    deps: [familyId],
    fetcher: async (supabase) => {
      const { data: assigns, error } = await supabase
        .from('chore_assignments').select('*').eq('family_id', familyId)
        .order('created_at', { ascending: false });
      if (error) return { data: null, error };
      const ids = [...new Set(assigns.map((a) => a.chore_id))];
      const { data: chores } = ids.length
        ? await supabase.from('chores').select('*').in('id', ids)
        : { data: [] as Chore[] };
      const byId = new Map((chores ?? []).map((c) => [c.id, c]));
      return { data: assigns.map((a) => ({ ...a, chore: byId.get(a.chore_id) ?? null })), error: null };
    },
  });

  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  const todo = data.filter((a) => a.status === 'todo' || a.status === 'in_progress' || a.status === 'rejected');
  const submitted = data.filter((a) => a.status === 'submitted');
  const approved = data.filter((a) => a.status === 'approved');

  const leaderboard = useMemo(() => {
    const totals = new Map<string, number>();
    for (const a of approved) totals.set(a.member_id, (totals.get(a.member_id) ?? 0) + (a.points_awarded ?? 0));
    return [...totals.entries()]
      .map(([id, points]) => ({ member: memberById.get(id), points }))
      .filter((x) => x.member)
      .sort((a, b) => b.points - a.points);
  }, [approved, memberById]);

  async function submitAssignment(a: Assignment) {
    setBusy(a.id);
    const supabase = createClient();
    const { error } = await supabase.from('chore_assignments')
      .update({ status: 'submitted', submitted_at: new Date().toISOString() }).eq('id', a.id);
    setBusy(null);
    if (error) return toastError(error.message);
    success('Marked complete — pending approval');
    void refresh();
  }

  async function approve(a: Assignment) {
    setBusy(a.id);
    const supabase = createClient();
    const { error } = await supabase.from('chore_assignments').update({
      status: 'approved', approved_at: new Date().toISOString(),
      approved_by: selfMember?.id ?? null, points_awarded: a.chore?.points ?? 0,
    }).eq('id', a.id);
    setBusy(null);
    if (error) return toastError(error.message);
    success(`Approved · +${a.chore?.points ?? 0} points`);
    void refresh();
  }

  async function reject(a: Assignment) {
    setBusy(a.id);
    const supabase = createClient();
    const { error } = await supabase.from('chore_assignments').update({ status: 'rejected' }).eq('id', a.id);
    setBusy(null);
    if (error) return toastError(error.message);
    void refresh();
  }

  async function removeChore(a: Assignment) {
    if (!a.chore) return;
    setBusy(a.id);
    const supabase = createClient();
    const { error } = await supabase.from('chores').delete().eq('id', a.chore.id);
    setBusy(null);
    if (error) return toastError(error.message);
    success('Chore deleted');
    void refresh();
  }

  function renderCard(a: Assignment, actions: React.ReactNode) {
    const m = memberById.get(a.member_id);
    return (
      <li key={a.id} className="flex items-center gap-3 rounded-xl border border-border bg-surface/40 px-3 py-3">
        {m && <Avatar name={m.display_name} color={m.color} size={36} />}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{a.chore?.title ?? 'Chore'}</p>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
            <span>{m?.display_name}</span>
            {a.chore && <Badge tone={PRIORITY_TONE[a.chore.priority]}>{a.chore.priority}</Badge>}
            <Badge tone="accent">{a.chore?.points ?? 0} pts</Badge>
            {a.due_at && <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" />{fmtRelative(a.due_at)}</span>}
            {a.status === 'rejected' && <Badge tone="danger">Try again</Badge>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">{actions}</div>
      </li>
    );
  }

  const canSubmit = (a: Assignment) => manager || a.member_id === selfMember?.id;

  if (loading) return <LoadingBlock />;
  if (error) return <ErrorState message={error} onRetry={refresh} />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Chores & rewards"
        description="Assign, complete, and approve — and watch the points add up."
        action={manager && <Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> New chore</Button>}
      />

      {leaderboard.length > 0 && (
        <Card>
          <div className="mb-3 flex items-center gap-2">
            <Trophy className="h-5 w-5 text-warning" />
            <h2 className="text-base font-semibold">Leaderboard</h2>
          </div>
          <div className="flex flex-wrap gap-3">
            {leaderboard.map(({ member, points }, i) => (
              <div key={member!.id} className="flex items-center gap-2 rounded-xl border border-border bg-surface/50 px-3 py-2">
                <span className="text-sm font-bold text-muted">#{i + 1}</span>
                <Avatar name={member!.display_name} color={member!.color} size={28} />
                <span className="text-sm font-medium">{member!.display_name.split(' ')[0]}</span>
                <Badge tone="accent">{points} pts</Badge>
              </div>
            ))}
          </div>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <h2 className="mb-3 text-base font-semibold">To do <span className="text-muted">({todo.length})</span></h2>
          {todo.length === 0 ? (
            <EmptyState icon={CheckSquare} title="All caught up" description={manager ? 'Create a chore to get started.' : 'No chores assigned to you right now.'} />
          ) : (
            <ul className="space-y-2">
              {todo.map((a) =>
                renderCard(a, (
                  <>
                    {canSubmit(a) && (
                      <Button size="sm" loading={busy === a.id} onClick={() => submitAssignment(a)}>
                        <Check className="h-4 w-4" /> Done
                      </Button>
                    )}
                    {manager && (
                      <button onClick={() => removeChore(a)} className="rounded-lg p-2 text-muted hover:text-danger" aria-label="Delete chore">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </>
                )),
              )}
            </ul>
          )}
        </Card>

        <Card>
          <h2 className="mb-3 text-base font-semibold">
            {manager ? 'Awaiting approval' : 'Submitted'} <span className="text-muted">({submitted.length})</span>
          </h2>
          {submitted.length === 0 ? (
            <EmptyState icon={Clock} title="Nothing pending" description="Completed chores will appear here for approval." />
          ) : (
            <ul className="space-y-2">
              {submitted.map((a) =>
                renderCard(a, manager ? (
                  <>
                    <Button size="sm" loading={busy === a.id} onClick={() => approve(a)}><Check className="h-4 w-4" /> Approve</Button>
                    <button onClick={() => reject(a)} className="rounded-lg p-2 text-muted hover:text-danger" aria-label="Reject"><X className="h-4 w-4" /></button>
                  </>
                ) : <Badge tone="warning">Pending</Badge>)
              )}
            </ul>
          )}
        </Card>
      </div>

      {approved.length > 0 && (
        <Card>
          <h2 className="mb-3 text-base font-semibold">Completed <span className="text-muted">({approved.length})</span></h2>
          <ul className="space-y-2">{approved.slice(0, 10).map((a) => renderCard(a, <Badge tone="success">Done</Badge>))}</ul>
        </Card>
      )}

      {open && (
        <NewChoreModal
          onClose={() => setOpen(false)}
          familyId={familyId}
          userId={userId}
          members={members.filter((m) => ['child', 'teen', 'adult', 'parent'].includes(m.role))}
          onCreated={() => { setOpen(false); void refresh(); }}
        />
      )}
    </div>
  );
}

function NewChoreModal({
  onClose, familyId, userId, members, onCreated,
}: {
  onClose: () => void;
  familyId: string;
  userId: string;
  members: Tables<'family_members'>[];
  onCreated: () => void;
}) {
  const { error: toastError, success } = useToast();
  const [loading, setLoading] = useState(false);
  const [assignees, setAssignees] = useState<string[]>([]);

  function toggle(id: string) {
    setAssignees((a) => (a.includes(id) ? a.filter((x) => x !== id) : [...a, id]));
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const title = String(form.get('title') ?? '').trim();
    if (!title) return toastError('Title is required');
    if (assignees.length === 0) return toastError('Pick at least one person');

    setLoading(true);
    const supabase = createClient();
    const dueRaw = String(form.get('due_at') ?? '');
    const due_at = dueRaw ? new Date(dueRaw).toISOString() : null;
    const { data: chore, error } = await supabase.from('chores').insert({
      family_id: familyId, created_by: userId, title,
      points: Number(form.get('points') ?? 10),
      priority: String(form.get('priority') ?? 'medium') as 'low' | 'medium' | 'high',
      due_at, requires_approval: true,
    }).select().single();
    if (error || !chore) { setLoading(false); return toastError(error?.message ?? 'Failed'); }

    const { error: aErr } = await supabase.from('chore_assignments').insert(
      assignees.map((member_id) => ({ family_id: familyId, chore_id: chore.id, member_id, status: 'todo' as const, due_at })),
    );
    setLoading(false);
    if (aErr) return toastError(aErr.message);
    success('Chore created');
    onCreated();
  }

  return (
    <Modal open onClose={onClose} title="New chore" description="Assign it to one or more family members.">
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="What needs doing?" required>
          {(id) => <Input id={id} name="title" placeholder="Take out the trash" autoFocus />}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Points">{(id) => <Input id={id} name="points" type="number" min={0} defaultValue={10} />}</Field>
          <Field label="Priority">
            {(id) => (
              <Select id={id} name="priority" defaultValue="medium">
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </Select>
            )}
          </Field>
        </div>
        <Field label="Due (optional)">{(id) => <Input id={id} name="due_at" type="datetime-local" />}</Field>
        <div>
          <p className="mb-2 text-sm font-medium">Assign to</p>
          <div className="flex flex-wrap gap-2">
            {members.map((m) => {
              const on = assignees.includes(m.id);
              return (
                <button
                  type="button"
                  key={m.id}
                  onClick={() => toggle(m.id)}
                  className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm transition ${on ? 'border-brand bg-brand/15 text-brand' : 'border-border text-muted hover:bg-elevated'}`}
                >
                  <Avatar name={m.display_name} color={m.color} size={22} />
                  {m.display_name.split(' ')[0]}
                  {on && <Check className="h-3.5 w-3.5" />}
                </button>
              );
            })}
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={loading}>Create chore</Button>
        </div>
      </form>
    </Modal>
  );
}
