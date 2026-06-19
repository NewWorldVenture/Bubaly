'use client';

import { useMemo, useState } from 'react';
import { Plus, CheckCircle2, Circle, MoreHorizontal, Trophy, Filter, SlidersHorizontal } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { useToast } from '@/components/ui/toast';
import { isManager } from '@/lib/constants/roles';
import { Avatar } from '@/components/ui/avatar';
import { Modal } from '@/components/ui/modal';
import { Input, Field, Select } from '@/components/ui/input';
import { LoadingBlock, ErrorState } from '@/components/ui/states';
import { cn } from '@/lib/utils/cn';
import type { Tables } from '@/lib/database.types';

type Chore = Tables<'chores'>;
type Assignment = Tables<'chore_assignments'> & { chore: Chore | null };

const PRIORITY_STYLES: Record<string, string> = {
  low: 'bg-green-500/15 text-green-400 border border-green-500/30',
  medium: 'bg-amber-500/15 text-amber-400 border border-amber-500/30',
  high: 'bg-red-500/15 text-red-400 border border-red-500/30',
};

const STATUS_STYLES: Record<string, string> = {
  todo: 'bg-surface text-muted border border-border',
  in_progress: 'bg-blue-500/15 text-blue-400 border border-blue-500/30',
  submitted: 'bg-amber-500/15 text-amber-400 border border-amber-500/30',
  approved: 'bg-green-500/15 text-green-400 border border-green-500/30',
  done: 'bg-green-500/15 text-green-400 border border-green-500/30',
  rejected: 'bg-red-500/15 text-red-400 border border-red-500/30',
};

const STATUS_LABELS: Record<string, string> = {
  todo: 'Pending', in_progress: 'In Progress', submitted: 'Submitted',
  approved: 'Completed', done: 'Completed', rejected: 'Rejected',
};

type Tab = 'all' | 'mine' | 'assigned' | 'chores' | 'completed';

function fmtDue(due: string | null): { label: string; urgent: boolean } {
  if (!due) return { label: '—', urgent: false };
  const d = new Date(due);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
  if (d < today) return { label: 'Overdue', urgent: true };
  if (d.toDateString() === today.toDateString()) return { label: 'Today', urgent: true };
  if (d.toDateString() === tomorrow.toDateString()) return { label: 'Tomorrow', urgent: false };
  return { label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), urgent: false };
}

function DonutChart({ segments, total }: { segments: { value: number; color: string }[]; total: number }) {
  const R = 30; const C = 2 * Math.PI * R;
  let cumulative = 0;
  const safe = total || 1;
  return (
    <svg width="80" height="80" viewBox="0 0 80 80" className="flex-shrink-0">
      <circle cx="40" cy="40" r={R} fill="none" stroke="#1e2d40" strokeWidth="10" />
      {segments.map((s, i) => {
        const dash = (s.value / safe) * C;
        const gap = C - dash;
        const offset = C - cumulative * C / safe;
        cumulative += s.value;
        if (!s.value) return null;
        return <circle key={i} cx="40" cy="40" r={R} fill="none" stroke={s.color} strokeWidth="10"
          strokeDasharray={`${dash} ${gap}`} strokeDashoffset={offset} style={{ transform: 'rotate(-90deg)', transformOrigin: '40px 40px' }} />;
      })}
      <text x="40" y="40" textAnchor="middle" dominantBaseline="central" fill="white" fontSize="14" fontWeight="bold">{total}</text>
      <text x="40" y="52" textAnchor="middle" dominantBaseline="central" fill="#94a0b8" fontSize="7">Total</text>
    </svg>
  );
}

export function ChoresModule() {
  const { familyId, userId, role, members, selfMember } = useApp();
  const { success, error: toastError } = useToast();
  const manager = isManager(role);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('all');

  const { data, loading, error, refresh } = useRealtimeQuery<Assignment>({
    table: 'chore_assignments', familyId, deps: [familyId],
    fetcher: async (supabase) => {
      const { data: assigns, error } = await supabase.from('chore_assignments').select('*').eq('family_id', familyId).order('created_at', { ascending: false });
      if (error) return { data: null, error };
      const ids = [...new Set(assigns.map(a => a.chore_id))];
      const { data: chores } = ids.length ? await supabase.from('chores').select('*').in('id', ids) : { data: [] as Chore[] };
      const byId = new Map((chores ?? []).map(c => [c.id, c]));
      return { data: assigns.map(a => ({ ...a, chore: byId.get(a.chore_id) ?? null })), error: null };
    },
  });

  const memberById = useMemo(() => new Map(members.map(m => [m.id, m])), [members]);
  const selfMemberId = selfMember?.id;

  const completed = data.filter(a => ['approved', 'done'].includes(a.status));

  const filtered = useMemo(() => {
    switch (tab) {
      case 'mine': return data.filter(a => a.member_id === selfMemberId && !['approved', 'done'].includes(a.status));
      case 'assigned': return data.filter(a => a.member_id !== selfMemberId && !['approved', 'done'].includes(a.status));
      case 'chores': return data.filter(a => !['approved', 'done'].includes(a.status));
      case 'completed': return completed;
      default: return data.filter(a => !['approved', 'done'].includes(a.status));
    }
  }, [data, tab, selfMemberId, completed]);

  const dueToday = data.filter(a => {
    if (!a.due_at || ['approved', 'done'].includes(a.status)) return false;
    return new Date(a.due_at).toDateString() === new Date().toDateString();
  });

  const dueThisWeek = data.filter(a => {
    if (!a.due_at || ['approved', 'done'].includes(a.status)) return false;
    const d = new Date(a.due_at); const t = new Date(); t.setHours(0, 0, 0, 0);
    const w = new Date(t); w.setDate(t.getDate() + 7);
    return d >= t && d <= w;
  });

  const leaderboard = useMemo(() => {
    const totals = new Map<string, number>();
    for (const a of completed) totals.set(a.member_id, (totals.get(a.member_id) ?? 0) + (a.points_awarded ?? 0));
    return members.map(m => ({ member: m, points: totals.get(m.id) ?? 0 })).sort((a, b) => b.points - a.points);
  }, [completed, members]);

  const maxPoints = Math.max(...leaderboard.map(l => l.points), 1);

  async function toggle(a: Assignment) {
    if (busy) return;
    if (['approved', 'done'].includes(a.status)) return;
    setBusy(a.id);
    const supabase = createClient();
    const next = ['todo', 'in_progress', 'rejected'].includes(a.status) ? 'submitted' : 'todo';
    const { error } = await supabase.from('chore_assignments').update({ status: next, submitted_at: next === 'submitted' ? new Date().toISOString() : null }).eq('id', a.id);
    setBusy(null);
    if (error) return toastError(error.message);
    success(next === 'submitted' ? 'Submitted for approval!' : 'Marked open'); void refresh();
  }

  async function approve(a: Assignment) {
    setBusy(a.id);
    const supabase = createClient();
    const { error } = await supabase.from('chore_assignments').update({ status: 'approved', approved_at: new Date().toISOString(), approved_by: userId, points_awarded: a.chore?.points ?? 0 }).eq('id', a.id);
    setBusy(null);
    if (error) return toastError(error.message);
    success('Approved!'); void refresh();
  }

  if (loading) return <LoadingBlock />;
  if (error) return <ErrorState message={error} onRetry={refresh} />;

  const TABS: { key: Tab; label: string }[] = [
    { key: 'all', label: 'All' }, { key: 'mine', label: 'My Tasks' }, { key: 'assigned', label: 'Assigned to Me' },
    { key: 'chores', label: 'Chores' }, { key: 'completed', label: 'Completed' },
  ];

  return (
    <div className="flex h-full min-h-0 gap-0">
      {/* Main */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex-shrink-0 border-b border-border px-5 py-4">
          <div className="flex items-center gap-3">
            <div>
              <h1 className="text-2xl font-bold">Tasks &amp; Chores</h1>
              <p className="mt-0.5 text-sm text-muted">Stay on top of what needs to get done.</p>
            </div>
            {manager && (
              <button onClick={() => setOpen(true)} className="ml-auto flex items-center gap-1.5 rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand/90 transition">
                <Plus className="h-4 w-4" /> Add Task
              </button>
            )}
          </div>

          <div className="mt-4 grid grid-cols-4 gap-3">
            {[
              { label: 'All Tasks', value: data.length, icon: '📋', color: 'text-brand' },
              { label: 'Due Today', value: dueToday.length, icon: '📅', color: 'text-amber-400' },
              { label: 'Due This Week', value: dueThisWeek.length, icon: '🗓️', color: 'text-blue-400' },
              { label: 'Completed', value: completed.length, icon: '✅', color: 'text-green-400' },
            ].map(s => (
              <div key={s.label} className="flex items-center gap-3 rounded-xl border border-border bg-surface/40 px-4 py-3">
                <span className="text-2xl">{s.icon}</span>
                <div>
                  <div className={cn('text-2xl font-bold', s.color)}>{s.value}</div>
                  <div className="text-[11px] text-muted">{s.label}</div>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-4 flex items-center gap-1">
            {TABS.map(t => (
              <button key={t.key} onClick={() => setTab(t.key)}
                className={cn('rounded-lg px-3 py-1.5 text-xs font-medium transition', tab === t.key ? 'bg-brand/20 text-brand' : 'text-muted hover:text-foreground hover:bg-elevated')}>
                {t.label}
              </button>
            ))}
            <div className="ml-auto flex items-center gap-2">
              <button className="flex items-center gap-1.5 rounded-lg border border-border bg-surface/60 px-3 py-1.5 text-xs font-medium hover:bg-elevated transition">
                <Filter className="h-3 w-3" /> Filter
              </button>
              <button className="flex items-center gap-1.5 rounded-lg border border-border bg-surface/60 px-3 py-1.5 text-xs font-medium hover:bg-elevated transition">
                <SlidersHorizontal className="h-3 w-3" /> Sort
              </button>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <div className="overflow-hidden rounded-xl border border-border bg-surface/30">
            <div className="grid grid-cols-[1fr_140px_130px_100px_120px_40px] border-b border-border bg-surface/40 px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-muted">
              <div>Task</div><div>Assigned To</div><div>Due Date</div><div>Priority</div><div>Status</div><div />
            </div>

            {filtered.length === 0 ? (
              <div className="flex flex-col items-center py-12 text-center">
                <CheckCircle2 className="mb-3 h-10 w-10 text-green-400 opacity-60" />
                <p className="text-sm font-medium">All caught up!</p>
                <p className="text-xs text-muted">No tasks in this view.</p>
              </div>
            ) : filtered.map((a, idx) => {
              const member = memberById.get(a.member_id);
              const { label: dueLabel, urgent } = fmtDue(a.due_at);
              const done = ['approved', 'done'].includes(a.status);
              const submitted = a.status === 'submitted';
              return (
                <div key={a.id}
                  className={cn('grid grid-cols-[1fr_140px_130px_100px_120px_40px] items-center border-b border-border/50 px-4 py-3 transition hover:bg-elevated/30', idx === filtered.length - 1 && 'border-b-0')}>
                  <div className="flex items-center gap-3 min-w-0">
                    <button onClick={() => toggle(a)} disabled={!!busy || done} className="flex-shrink-0">
                      {done ? <CheckCircle2 className="h-4 w-4 text-green-400" />
                        : submitted ? <CheckCircle2 className="h-4 w-4 text-amber-400" />
                        : <Circle className={cn('h-4 w-4 text-muted hover:text-brand transition', busy === a.id && 'animate-pulse')} />}
                    </button>
                    <div className="min-w-0">
                      <div className={cn('truncate text-sm font-medium', done && 'line-through text-muted')}>{a.chore?.title ?? '—'}</div>
                      <div className="text-[10px] text-muted">Chore</div>
                    </div>
                  </div>
                  <div>{member ? <div className="flex items-center gap-1.5"><Avatar name={member.display_name} color={member.color} size={22} /><span className="text-xs text-muted">{member.display_name}</span></div> : <span className="text-xs text-muted">—</span>}</div>
                  <div className={cn('text-xs font-medium', urgent ? 'text-red-400' : 'text-muted')}>{dueLabel}</div>
                  <div>{a.chore?.priority ? <span className={cn('rounded-md px-2 py-0.5 text-[10px] font-semibold capitalize', PRIORITY_STYLES[a.chore.priority])}>{a.chore.priority}</span> : <span className="text-xs text-muted">—</span>}</div>
                  <div><span className={cn('rounded-md px-2 py-0.5 text-[10px] font-semibold', STATUS_STYLES[a.status] ?? '')}>{STATUS_LABELS[a.status] ?? a.status}</span></div>
                  <div className="flex justify-end">
                    {submitted && manager
                      ? <button onClick={() => approve(a)} disabled={!!busy} className="rounded-md bg-green-500/20 px-2 py-0.5 text-[10px] font-semibold text-green-400 hover:bg-green-500/30 transition">Approve</button>
                      : <button className="rounded p-1 text-muted hover:text-foreground"><MoreHorizontal className="h-4 w-4" /></button>}
                  </div>
                </div>
              );
            })}

            {manager && (
              <button onClick={() => setOpen(true)} className="flex w-full items-center gap-2 px-4 py-3 text-sm text-muted hover:bg-elevated/30 hover:text-foreground transition">
                <Plus className="h-4 w-4" /> Add Task
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Right sidebar */}
      <div className="hidden w-72 flex-shrink-0 flex-col gap-4 overflow-y-auto border-l border-border bg-surface/20 p-4 xl:flex">
        <div className="rounded-xl border border-border bg-surface/40 p-4">
          <p className="mb-3 text-sm font-semibold">Chores Overview</p>
          <div className="flex items-center gap-4">
            <DonutChart segments={[{ value: completed.length, color: '#22c55e' }, { value: data.filter(a => a.status === 'in_progress').length, color: '#3b82f6' }, { value: data.filter(a => a.status === 'todo').length, color: '#475569' }]} total={data.length} />
            <div className="space-y-2 text-xs">
              {[{ label: 'Completed', value: completed.length, color: '#22c55e' }, { label: 'In Progress', value: data.filter(a => a.status === 'in_progress').length, color: '#3b82f6' }, { label: 'Pending', value: data.filter(a => a.status === 'todo').length, color: '#475569' }].map(s => (
                <div key={s.label} className="flex items-center gap-2">
                  <div className="h-2 w-2 rounded-full" style={{ background: s.color }} />
                  <span className="text-muted">{s.label}</span>
                  <span className="ml-auto font-semibold">{data.length ? Math.round(s.value / data.length * 100) : 0}%</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {selfMember && (
          <div className="rounded-xl border border-border bg-surface/40 p-4">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-sm font-semibold">My Chores</p>
              <button className="text-xs text-brand hover:underline">View all</button>
            </div>
            <div className="space-y-2">
              {data.filter(a => a.member_id === selfMember.id && !['approved', 'done'].includes(a.status)).slice(0, 4).map(a => {
                const { label, urgent } = fmtDue(a.due_at);
                return (
                  <div key={a.id} className="flex items-center gap-2.5 rounded-lg border border-border/50 bg-surface/60 px-3 py-2">
                    <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-brand/20">
                      <CheckCircle2 className="h-3.5 w-3.5 text-brand" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-medium">{a.chore?.title ?? '—'}</div>
                      <div className="text-[10px] text-muted capitalize">{a.chore?.recurrence ?? 'One-time'}</div>
                    </div>
                    <span className={cn('text-[10px] font-semibold', urgent ? 'text-red-400' : 'text-muted')}>{label}</span>
                  </div>
                );
              })}
              {data.filter(a => a.member_id === selfMember.id && !['approved', 'done'].includes(a.status)).length === 0 && (
                <p className="text-xs text-muted">No pending chores</p>
              )}
            </div>
          </div>
        )}

        <div className="rounded-xl border border-border bg-surface/40 p-4">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-sm font-semibold">Family Progress</p>
            <span className="text-[10px] text-muted">This Week</span>
          </div>
          <div className="space-y-3">
            {leaderboard.map(({ member, points }) => (
              <div key={member.id} className="flex items-center gap-2.5">
                <Avatar name={member.display_name} color={member.color} size={26} />
                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-xs font-medium">{member.display_name}</span>
                    <span className="text-xs font-semibold text-brand">{Math.round(points / maxPoints * 100)}%</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-elevated">
                    <div className="h-full rounded-full transition-all" style={{ width: `${Math.round(points / maxPoints * 100)}%`, background: member.color ?? '#7c5dff' }} />
                  </div>
                </div>
              </div>
            ))}
          </div>
          <button className="mt-3 text-xs text-brand hover:underline">View full report →</button>
        </div>
      </div>

      {open && manager && (
        <NewChoreModal familyId={familyId} userId={userId} members={members} onClose={() => setOpen(false)} onSaved={() => { setOpen(false); void refresh(); }} />
      )}
    </div>
  );
}

function NewChoreModal({ familyId, userId, members, onClose, onSaved }: {
  familyId: string; userId: string;
  members: { id: string; display_name: string; color: string | null }[];
  onClose: () => void; onSaved: () => void;
}) {
  const { error: toastError } = useToast();
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const title = String(form.get('title') ?? '').trim();
    const memberId = String(form.get('member_id') ?? '');
    const points = Number(form.get('points') ?? 10);
    const priority = String(form.get('priority') ?? 'medium') as 'low' | 'medium' | 'high';
    const due_at = String(form.get('due_at') ?? '') || null;
    if (!title || !memberId) return toastError('Title and assignee required');
    setLoading(true);
    const supabase = createClient();
    const { data: chore, error: ce } = await supabase.from('chores').insert({ family_id: familyId, title, points, priority, recurrence: 'none', created_by: userId }).select('id').single();
    if (ce || !chore) { setLoading(false); return toastError(ce?.message ?? 'Failed'); }
    const { error: ae } = await supabase.from('chore_assignments').insert({ family_id: familyId, chore_id: chore.id, member_id: memberId, status: 'todo', due_at });
    setLoading(false);
    if (ae) return toastError(ae.message);
    onSaved();
  }

  return (
    <Modal open title="Add Task" onClose={onClose}>
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Title" required>
          {(id) => <Input id={id} name="title" autoFocus placeholder="Take out the trash" />}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Assign to" required>
            {(id) => <Select id={id} name="member_id"><option value="">Pick member…</option>{members.map(m => <option key={m.id} value={m.id}>{m.display_name}</option>)}</Select>}
          </Field>
          <Field label="Priority">
            {(id) => <Select id={id} name="priority"><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></Select>}
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Points">{(id) => <Input id={id} name="points" type="number" defaultValue="10" min="0" max="100" />}</Field>
          <Field label="Due date">{(id) => <Input id={id} name="due_at" type="date" />}</Field>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-elevated transition">Cancel</button>
          <button type="submit" disabled={loading} className="rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand/90 transition disabled:opacity-60">
            {loading ? 'Saving…' : 'Add Task'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
