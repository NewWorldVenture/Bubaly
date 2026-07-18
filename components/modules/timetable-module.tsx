'use client';

import { useMemo, useState } from 'react';
import { CalendarRange, Plus, Pencil, Trash2, Clock, MapPin, Repeat } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { Input, Field, Select } from '@/components/ui/input';
import { Avatar } from '@/components/ui/avatar';
import { SkeletonList, ErrorState, EmptyState } from '@/components/ui/states';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/app/page-header';
import { AiInsight } from '@/components/ai/ai-insight';
import { cn } from '@/lib/utils/cn';
import {
  buildWeekGrid, weekParity, WEEKDAYS, WEEKDAY_LABELS,
  WEEK_PATTERN_LABELS, type WeekPattern, type ClassLike,
} from '@/lib/school/timetable';
import type { Tables } from '@/lib/database.types';

type SchoolClass = Tables<'school_classes'>;

const SUBJECT_COLORS: Record<string, string> = {
  Math: 'bg-violet-500/15 border-violet-500/40 text-violet-200',
  English: 'bg-blue-500/15 border-blue-500/40 text-blue-200',
  Science: 'bg-emerald-500/15 border-emerald-500/40 text-emerald-200',
  History: 'bg-orange-500/15 border-orange-500/40 text-orange-200',
  Spanish: 'bg-rose-500/15 border-rose-500/40 text-rose-200',
  Art: 'bg-pink-500/15 border-pink-500/40 text-pink-200',
  Music: 'bg-amber-500/15 border-amber-500/40 text-amber-200',
  PE: 'bg-cyan-500/15 border-cyan-500/40 text-cyan-200',
};
const DEFAULT_COLOR = 'bg-surface border-border text-fg';
const subjectColor = (s: string) => SUBJECT_COLORS[s] ?? DEFAULT_COLOR;

const blankForm = {
  id: '', member_id: '', subject: '', teacher: '', room: '',
  time_slot: '', day_of_week: '1', week_pattern: 'all' as WeekPattern, school_name: '',
};

export function TimetableModule() {
  const { familyId, userId, members } = useApp();
  const { success, error: toastError } = useToast();

  const todayWeek = useMemo(() => weekParity(new Date()), []);
  const [week, setWeek] = useState<'a' | 'b'>(todayWeek);
  const [memberFilter, setMemberFilter] = useState<string>('all');
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(blankForm);

  const { data: classes, loading, error, refresh } = useRealtimeQuery<SchoolClass>({
    table: 'school_classes', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('school_classes').select('*').eq('family_id', familyId).order('time_slot'),
  });

  const memberName = (id: string) => members.find((m) => m.id === id)?.display_name ?? 'Someone';
  const hasAltWeeks = useMemo(() => (classes ?? []).some((c) => c.week_pattern !== 'all'), [classes]);

  const filtered = useMemo<ClassLike[]>(() => {
    return (classes ?? [])
      .filter((c) => memberFilter === 'all' || c.member_id === memberFilter)
      .map((c) => ({
        id: c.id, member_id: c.member_id, subject: c.subject,
        time_slot: c.time_slot, day_of_week: c.day_of_week,
        week_pattern: (c.week_pattern ?? 'all') as WeekPattern,
      }));
  }, [classes, memberFilter]);

  const grid = useMemo(() => buildWeekGrid(filtered, week), [filtered, week]);
  const classById = useMemo(() => new Map((classes ?? []).map((c) => [c.id, c])), [classes]);

  function openNew() { setForm(blankForm); setOpen(true); }
  function openEdit(c: SchoolClass) {
    setForm({
      id: c.id, member_id: c.member_id, subject: c.subject,
      teacher: c.teacher ?? '', room: c.room ?? '', time_slot: c.time_slot ?? '',
      day_of_week: c.day_of_week == null ? '' : String(c.day_of_week),
      week_pattern: (c.week_pattern ?? 'all') as WeekPattern, school_name: c.school_name ?? '',
    });
    setOpen(true);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.member_id) { toastError('Pick a family member'); return; }
    if (!form.subject.trim()) { toastError('Subject is required'); return; }
    setSaving(true);
    const sb = createClient();
    const fields = {
      subject: form.subject.trim(),
      teacher: form.teacher.trim() || null, room: form.room.trim() || null,
      time_slot: form.time_slot.trim() || null,
      day_of_week: form.day_of_week === '' ? null : parseInt(form.day_of_week, 10),
      week_pattern: form.week_pattern, school_name: form.school_name.trim() || null,
    };
    const { error: err } = form.id
      ? await sb.from('school_classes').update(fields).eq('id', form.id)
      : await sb.from('school_classes').insert({ ...fields, family_id: familyId, member_id: form.member_id, created_by: userId });
    setSaving(false);
    if (err) { toastError(form.id ? 'Failed to update class' : 'Failed to add class'); return; }
    success(form.id ? 'Class updated' : 'Class added');
    setOpen(false);
    refresh();
  }

  async function remove(c: SchoolClass) {
    if (!confirm(`Remove ${c.subject} from the timetable?`)) return;
    const sb = createClient();
    const { error: err } = await sb.from('school_classes').delete().eq('id', c.id);
    if (err) { toastError('Failed to remove class'); return; }
    success('Class removed');
    refresh();
  }

  if (loading) return <SkeletonList count={5} />;
  if (error) return <ErrorState message={error} />;

  const totalShown = WEEKDAYS.reduce((n, d) => n + grid[d].length, 0);

  return (
    <div>
      <PageHeader
        title="Timetable"
        description="A visual Mon–Fri class schedule for every student — with alternating A/B week support for rotating timetables."
        action={<div className="flex items-center gap-2"><AiInsight kind="timetable" iconOnly /><Button onClick={openNew} className="gap-1.5"><Plus className="h-4 w-4" /> Add class</Button></div>}
      />

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3 mb-5">
        {/* Member filter */}
        <Select value={memberFilter} onChange={(e) => setMemberFilter(e.target.value)} className="h-9 w-auto">
          <option value="all">All students</option>
          {members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}
        </Select>

        {/* A/B week toggle — only meaningful when alternating-week classes exist */}
        {hasAltWeeks && (
          <div className="inline-flex items-center rounded-xl border border-border bg-surface/50 p-0.5">
            {(['a', 'b'] as const).map((w) => (
              <button key={w} onClick={() => setWeek(w)}
                className={cn('rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
                  week === w ? 'bg-brand text-white' : 'text-muted hover:text-fg')}>
                {WEEK_PATTERN_LABELS[w]}
                {todayWeek === w && <span className="ml-1.5 text-xs opacity-80">(now)</span>}
              </button>
            ))}
          </div>
        )}
      </div>

      {totalShown === 0 ? (
        <EmptyState icon={CalendarRange} title="No classes scheduled"
          description="Add classes with a day and time to build a visual weekly timetable. Use A/B week patterns for rotating schedules."
          action={<Button onClick={openNew} className="gap-1.5"><Plus className="h-4 w-4" /> Add class</Button>} />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
          {WEEKDAYS.map((day) => (
            <div key={day} className="rounded-2xl border border-border bg-surface/30 p-2.5">
              <div className="px-1.5 pb-2 text-sm font-semibold text-fg">{WEEKDAY_LABELS[day]}</div>
              <div className="space-y-2">
                {grid[day].length === 0 ? (
                  <div className="px-1.5 py-3 text-xs text-muted">No classes</div>
                ) : (
                  grid[day].map((cl) => {
                    const c = classById.get(cl.id)!;
                    return (
                      <div key={cl.id} className={cn('group rounded-xl border p-2.5', subjectColor(c.subject))}>
                        <div className="flex items-start justify-between gap-1">
                          <div className="font-semibold text-sm leading-tight">{c.subject}</div>
                          <div className="flex items-center gap-0.5 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus-visible:opacity-100 coarse:opacity-100 transition-opacity">
                            <button onClick={() => openEdit(c)} aria-label="Edit" className="p-1 rounded-md hover:bg-black/20"><Pencil className="h-3.5 w-3.5" /></button>
                            <button onClick={() => remove(c)} aria-label="Remove" className="p-1 rounded-md hover:bg-black/20"><Trash2 className="h-3.5 w-3.5" /></button>
                          </div>
                        </div>
                        {c.time_slot && <div className="mt-1 flex items-center gap-1 text-xs opacity-90"><Clock className="h-3 w-3" />{c.time_slot}</div>}
                        {c.room && <div className="mt-0.5 flex items-center gap-1 text-xs opacity-90"><MapPin className="h-3 w-3" />{c.room}</div>}
                        <div className="mt-1.5 flex items-center gap-1 text-xs opacity-80">
                          <Avatar name={memberName(c.member_id)} size={16} />
                          <span className="truncate">{memberName(c.member_id)}</span>
                        </div>
                        {c.week_pattern && c.week_pattern !== 'all' && (
                          <div className="mt-1 inline-flex items-center gap-1 rounded-md bg-black/25 px-1.5 py-0.5 text-[10px] font-medium">
                            <Repeat className="h-2.5 w-2.5" />{WEEK_PATTERN_LABELS[c.week_pattern as WeekPattern]}
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add / edit class modal */}
      <Modal open={open} onClose={() => setOpen(false)} title={form.id ? 'Edit class' : 'Add class'}>
        <form onSubmit={submit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Student" required>
              {(id) => (
                <Select id={id} value={form.member_id} onChange={(e) => setForm((f) => ({ ...f, member_id: e.target.value }))}>
                  <option value="">Select…</option>
                  {members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}
                </Select>
              )}
            </Field>
            <Field label="Subject" required>
              {(id) => <Input id={id} value={form.subject} onChange={(e) => setForm((f) => ({ ...f, subject: e.target.value }))} placeholder="Math" autoFocus />}
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Day">
              {(id) => (
                <Select id={id} value={form.day_of_week} onChange={(e) => setForm((f) => ({ ...f, day_of_week: e.target.value }))}>
                  {WEEKDAYS.map((d) => <option key={d} value={String(d)}>{WEEKDAY_LABELS[d]}</option>)}
                  <option value="">Every day</option>
                </Select>
              )}
            </Field>
            <Field label="Time">
              {(id) => <Input id={id} value={form.time_slot} onChange={(e) => setForm((f) => ({ ...f, time_slot: e.target.value }))} placeholder="9:00 AM" />}
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Teacher">
              {(id) => <Input id={id} value={form.teacher} onChange={(e) => setForm((f) => ({ ...f, teacher: e.target.value }))} placeholder="Ms. Lee" />}
            </Field>
            <Field label="Room">
              {(id) => <Input id={id} value={form.room} onChange={(e) => setForm((f) => ({ ...f, room: e.target.value }))} placeholder="Room 204" />}
            </Field>
          </div>
          <Field label="Repeats">
            {(id) => (
              <Select id={id} value={form.week_pattern} onChange={(e) => setForm((f) => ({ ...f, week_pattern: e.target.value as WeekPattern }))}>
                {(Object.keys(WEEK_PATTERN_LABELS) as WeekPattern[]).map((w) => <option key={w} value={w}>{WEEK_PATTERN_LABELS[w]}</option>)}
              </Select>
            )}
          </Field>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? 'Saving…' : form.id ? 'Save changes' : 'Add class'}</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
