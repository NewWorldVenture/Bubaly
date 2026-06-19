'use client';

import { useMemo, useState } from 'react';
import { BookOpen, Calendar, ChevronRight, Filter, GraduationCap, MoreHorizontal, Plus, Sparkles } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { Input, Field, Select } from '@/components/ui/input';
import { Avatar } from '@/components/ui/avatar';
import { LoadingBlock, ErrorState } from '@/components/ui/states';
import { cn } from '@/lib/utils/cn';
import type { Tables } from '@/lib/database.types';

type SchoolEvent = Tables<'school_events'>;
const TABS = ['Overview', 'Assignments', 'Classes', 'Grades', 'Resources'] as const;
type Tab = (typeof TABS)[number];
const EVENT_TYPES = ['general', 'holiday', 'field_trip', 'parent_meeting', 'exam', 'concert', 'sport', 'graduation', 'assignment', 'announcement'];
const PRIO_STYLE: Record<string, string> = { High: 'bg-red-500/15 text-red-400 border border-red-500/25', Medium: 'bg-blue-500/15 text-blue-400 border border-blue-500/25', Low: 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/25' };
const STATUS_STYLE: Record<string, string> = { 'Not Started': 'bg-white/10 text-white/60', 'In Progress': 'bg-violet-500/15 text-violet-300', Submitted: 'bg-emerald-500/15 text-emerald-300' };
const SUBJECT_ICONS: Record<string, string> = { Math: '📐', English: '📝', Science: '🔬', History: '🏛️', Spanish: '🌎', Art: '🎨', Music: '🎵', PE: '⚽' };
const CLASS_SCHEDULE = [
  { time: '8:00 AM', subject: 'Math', room: 'Room 203', color: 'bg-violet-500' },
  { time: '9:30 AM', subject: 'English', room: 'Room 105', color: 'bg-blue-500' },
  { time: '11:00 AM', subject: 'Science', room: 'Lab 2', color: 'bg-emerald-500' },
  { time: '12:30 PM', subject: 'Lunch', room: 'Cafeteria', color: 'bg-yellow-500' },
  { time: '1:15 PM', subject: 'History', room: 'Room 301', color: 'bg-orange-500' },
  { time: '2:45 PM', subject: 'Spanish', room: 'Room 104', color: 'bg-rose-500' },
];
const ANNOUNCEMENTS_MOCK = [
  { icon: '🚌', title: 'Spring Field Trip', body: 'The 6th grade field trip to the Museum of Science is on May 22. Permission slips due by May 15.', time: '2 hours ago' },
  { icon: '🏆', title: 'Science Fair', body: 'Sign-ups for the annual science fair are now open! Submit your project by May 20.', time: '1 day ago' },
  { icon: 'ℹ️', title: 'No School – Memorial Day', body: 'School will be closed on Monday, May 27.', time: '2 days ago' },
];
const IMPORTANT_DATES = [
  { month: 'MAY', day: '15', label: 'End of Quarter 4', sub: 'Wednesday, May 15' },
  { month: 'MAY', day: '20', label: 'Final Exam Week', sub: 'May 20 – May 24' },
  { month: 'JUN', day: '7', label: 'Last Day of School', sub: 'Friday, June 7' },
];
const GRADE_DATA = { gpa: '3.45', dist: [{ label: 'A (90-100%)', count: 2, color: '#34d399' }, { label: 'B (80-89%)', count: 3, color: '#60a5fa' }, { label: 'C (70-79%)', count: 1, color: '#fbbf24' }, { label: 'D (60-69%)', count: 0, color: '#fb923c' }, { label: 'F (Below 60%)', count: 0, color: '#f87171' }] };
const FALLBACK_ROWS = [
  { title: 'Math Worksheet #24', sub: 'Chapter 8: Fractions', sidx: 0, subject: 'Math', due: 'May 13', dueSub: 'Today', prio: 'High', status: 'Not Started', urgent: true },
  { title: 'Book Report', sub: 'The City of Ember', sidx: 1, subject: 'English', due: 'May 14', dueSub: 'Tomorrow', prio: 'Medium', status: 'In Progress', urgent: true },
  { title: 'Science Lab Report', sub: 'Volcano Experiment', sidx: 0, subject: 'Science', due: 'May 15', dueSub: '2 days left', prio: 'High', status: 'Not Started', urgent: false },
  { title: 'History Presentation', sub: 'Ancient Greece', sidx: 2, subject: 'History', due: 'May 17', dueSub: '4 days left', prio: 'Low', status: 'Not Started', urgent: false },
  { title: 'Spanish Vocabulary Quiz', sub: 'Unit 6', sidx: 3, subject: 'Spanish', due: 'May 18', dueSub: '5 days left', prio: 'Low', status: 'In Progress', urgent: false },
];

function fmtDue(iso: string) {
  const d = new Date(iso); const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.ceil((d.getTime() - today.getTime()) / 86400000);
  if (diff <= 0) return { label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), sub: 'Today', urgent: true };
  if (diff === 1) return { label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), sub: 'Tomorrow', urgent: true };
  return { label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), sub: `${diff} days left`, urgent: false };
}

export function SchoolModule() {
  const { familyId, userId, members } = useApp();
  const { success, error: toastError } = useToast();
  const [tab, setTab] = useState<Tab>('Overview');
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ title: '', event_type: 'assignment', starts_at: '', notes: '', member_id: '', school_name: '' });
  const [saving, setSaving] = useState(false);
  const [scheduleIdx, setScheduleIdx] = useState(0);

  const now = useMemo(() => new Date().toISOString(), []);
  const in14 = useMemo(() => { const d = new Date(); d.setDate(d.getDate() + 14); return d.toISOString(); }, []);

  const { data: events, loading, error, refresh } = useRealtimeQuery<SchoolEvent>({
    table: 'school_events', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('school_events').select('*').eq('family_id', familyId).order('starts_at'),
  });

  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  const upcoming = useMemo(() => events.filter((e) => e.starts_at >= now).slice(0, 5), [events, now]);
  const sidebarEvents = useMemo(() => events.filter((e) => e.starts_at >= now && e.starts_at <= in14).slice(0, 4), [events, now, in14]);

  const gradeTotal = GRADE_DATA.dist.reduce((s, g) => s + g.count, 0) || 1;
  let off = 0; const circ = 251.2;
  const gradeSegs = GRADE_DATA.dist.map((g) => { const dash = (g.count / gradeTotal) * circ; const seg = { dash, offset: circ - off, color: g.color }; off += dash; return seg; });

  async function save() {
    if (!form.title || !form.starts_at) return; setSaving(true);
    const sb = createClient();
    const { error: err } = await sb.from('school_events').insert({ family_id: familyId, title: form.title, event_type: form.event_type, starts_at: new Date(form.starts_at).toISOString(), notes: form.notes || null, member_id: form.member_id || null, school_name: form.school_name || null, created_by: userId });
    setSaving(false);
    if (err) { toastError('Failed to save'); return; }
    success('Event added!'); setOpen(false); setForm({ title: '', event_type: 'assignment', starts_at: '', notes: '', member_id: '', school_name: '' }); refresh();
  }

  if (loading) return <LoadingBlock />;
  if (error) return <ErrorState message={error} />;

  const ACCENT = ['bg-violet-500', 'bg-blue-500', 'bg-emerald-500', 'bg-orange-500'];

  return (
    <div className="flex gap-6 xl:gap-8">
      <div className="min-w-0 flex-1 space-y-5">
        <div className="flex items-start justify-between">
          <div><h1 className="text-2xl font-bold">School</h1><p className="mt-1 text-sm text-white/55">Stay on top of classes, assignments, and school events.</p></div>
          <button onClick={() => setOpen(true)} className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-blue-500 to-violet-600 px-4 py-2.5 text-sm font-bold shadow-glow"><Plus className="h-4 w-4" /> Add Item</button>
        </div>
        <div className="flex items-center justify-between border-b border-white/8">
          <div className="flex">{TABS.map((t) => <button key={t} onClick={() => setTab(t)} className={cn('px-4 py-3 text-sm font-medium transition', tab === t ? 'border-b-2 border-violet-400 text-white' : 'text-white/50 hover:text-white/80')}>{t}</button>)}</div>
          <div className="flex gap-2 pb-1">
            <button className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-white/55"><Filter className="h-3 w-3" /> Filter</button>
            <button className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-white/55"><MoreHorizontal className="h-3 w-3" /> More</button>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[
            { icon: GraduationCap, label: 'Students', value: Math.max(members.length, 3), sub: 'Across all grades', bg: 'bg-violet-600/20 text-violet-300' },
            { icon: BookOpen, label: 'Assignments Due', value: Math.max(upcoming.length, 7), sub: 'This week', bg: 'bg-emerald-600/20 text-emerald-300' },
            { icon: Calendar, label: 'Events', value: Math.max(sidebarEvents.length, 2), sub: 'This week', bg: 'bg-orange-600/20 text-orange-300' },
            { icon: GraduationCap, label: 'Average Grade', value: 'A-', sub: 'This term', bg: 'bg-blue-600/20 text-blue-300' },
          ].map(({ icon: Icon, label, value, sub, bg }) => (
            <div key={label} className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
              <div className={cn('mb-3 grid h-10 w-10 place-items-center rounded-xl', bg)}><Icon className="h-5 w-5" /></div>
              <p className="text-2xl font-black">{value}</p><p className="text-sm font-semibold">{label}</p><p className="text-xs text-white/40">{sub}</p>
            </div>
          ))}
        </div>
        <div className="rounded-2xl border border-white/8 bg-white/[0.03]">
          <div className="flex items-center justify-between p-5">
            <h2 className="font-semibold">Upcoming Assignments</h2>
            <button className="flex items-center gap-1 text-xs font-semibold text-violet-300">View all assignments <ChevronRight className="h-3.5 w-3.5" /></button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-t border-white/8 text-xs text-white/40">
                <th className="px-5 py-3 text-left font-medium">Assignment</th>
                <th className="px-4 py-3 text-left font-medium">Student</th>
                <th className="px-4 py-3 text-left font-medium">Subject</th>
                <th className="px-4 py-3 text-left font-medium">Due Date</th>
                <th className="px-4 py-3 text-left font-medium">Priority</th>
                <th className="px-4 py-3 text-left font-medium">Status</th>
                <th className="w-8 px-4 py-3" />
              </tr></thead>
              <tbody className="divide-y divide-white/5">
                {(upcoming.length > 0
                  ? upcoming.map((e, i) => {
                    const SUBJECTS = ['Math', 'English', 'Science', 'History', 'Spanish'];
                    const PRIOS = ['High', 'Medium', 'High', 'Low', 'Low'];
                    const STATUSES = ['Not Started', 'In Progress', 'Not Started', 'Not Started', 'In Progress'];
                    const subj = SUBJECTS[i % SUBJECTS.length];
                    const due = fmtDue(e.starts_at);
                    const member = e.member_id ? memberById.get(e.member_id) : members[i % Math.max(members.length, 1)];
                    return { key: e.id, title: e.title, sub: e.notes ?? e.school_name ?? '', member, subject: subj, due: due.label, dueSub: due.sub, prio: PRIOS[i % PRIOS.length], status: STATUSES[i % STATUSES.length], urgent: due.urgent };
                  })
                  : FALLBACK_ROWS.map((r) => ({ ...r, key: r.title, member: members[r.sidx % Math.max(members.length, 1)] }))
                ).map((row) => (
                  <tr key={row.key} className="hover:bg-white/[0.02]">
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-3">
                        <span className="text-lg">{SUBJECT_ICONS[row.subject] ?? '📚'}</span>
                        <div><p className="font-medium">{row.title}</p><p className="text-xs text-white/40">{row.sub}</p></div>
                      </div>
                    </td>
                    <td className="px-4 py-3.5">
                      {row.member ? <div className="flex items-center gap-2"><Avatar name={row.member.display_name} color={row.member.color} size={28} /><span>{row.member.display_name.split(' ')[0]}</span></div> : <span className="text-white/30">—</span>}
                    </td>
                    <td className="px-4 py-3.5 text-white/70">{row.subject}</td>
                    <td className="px-4 py-3.5"><p className="font-medium">{row.due}</p><p className={cn('text-xs', row.urgent ? 'text-orange-400' : 'text-white/40')}>{row.dueSub}</p></td>
                    <td className="px-4 py-3.5"><span className={cn('rounded-full px-2.5 py-1 text-xs font-bold', PRIO_STYLE[row.prio])}>{row.prio}</span></td>
                    <td className="px-4 py-3.5"><span className={cn('rounded-full px-2.5 py-1 text-xs font-semibold', STATUS_STYLE[row.status])}>{row.status}</span></td>
                    <td className="px-4 py-3.5"><button className="text-white/25 hover:text-white/60"><MoreHorizontal className="h-4 w-4" /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="border-t border-white/8 p-4 text-center">
            <button className="mx-auto flex items-center gap-1 text-xs font-semibold text-violet-300">View all assignments <ChevronRight className="h-3.5 w-3.5" /></button>
          </div>
        </div>
        <div className="grid gap-5 lg:grid-cols-2">
          <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-5">
            <div className="mb-4 flex items-center justify-between"><h2 className="font-semibold">Class Schedules</h2><button className="text-xs font-semibold text-violet-300">View full schedule →</button></div>
            <div className="mb-4 flex gap-2 overflow-x-auto pb-1">
              {members.slice(0, 4).map((m, i) => (
                <button key={m.id} onClick={() => setScheduleIdx(i)} className={cn('flex items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-sm transition', scheduleIdx === i ? 'bg-violet-600 text-white' : 'border border-white/10 text-white/60 hover:text-white/80')}>
                  <Avatar name={m.display_name} color={m.color} size={18} />{m.display_name.split(' ')[0]}
                </button>
              ))}
            </div>
            <div className="space-y-2.5">
              {CLASS_SCHEDULE.map(({ time, subject, room, color }) => (
                <div key={time} className="flex items-center gap-3 text-sm">
                  <span className="w-16 shrink-0 text-xs text-white/45 tabular-nums">{time}</span>
                  <div className={cn('h-2.5 w-2.5 shrink-0 rounded-full', color)} />
                  <span className="flex-1 font-medium">{subject}</span>
                  <span className="text-xs text-white/40">{room}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-5">
            <div className="mb-4 flex items-center justify-between"><h2 className="font-semibold">School Announcements</h2><button className="text-xs font-semibold text-violet-300">View all →</button></div>
            <div className="space-y-4">
              {ANNOUNCEMENTS_MOCK.map((a) => (
                <div key={a.title} className="flex gap-3">
                  <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white/[0.04] text-lg">{a.icon}</div>
                  <div><p className="text-sm font-semibold">{a.title}</p><p className="mt-0.5 text-xs leading-5 text-white/55">{a.body}</p><p className="mt-1 text-xs text-white/30">{a.time}</p></div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      <aside className="hidden w-72 shrink-0 space-y-5 xl:block">
        <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-5">
          <div className="mb-4 flex items-center justify-between"><h2 className="font-semibold">Upcoming School Events</h2><button className="text-xs font-semibold text-violet-300">View calendar →</button></div>
          <div className="space-y-3">
            {(sidebarEvents.length > 0 ? sidebarEvents : [
              { id: 'a', starts_at: new Date(Date.now() + 86400000 * 3).toISOString(), title: 'PTA Meeting', notes: 'School Library', event_type: 'parent_meeting', family_id: familyId, school_name: null, ends_at: null, source: null, member_id: null, created_by: null },
              { id: 'b', starts_at: new Date(Date.now() + 86400000 * 9).toISOString(), title: '6th Grade Field Trip', notes: 'Museum of Science', event_type: 'field_trip', family_id: familyId, school_name: null, ends_at: null, source: null, member_id: null, created_by: null },
              { id: 'c', starts_at: new Date(Date.now() + 86400000 * 11).toISOString(), title: 'Talent Show', notes: 'School Auditorium 7:00 PM', event_type: 'concert', family_id: familyId, school_name: null, ends_at: null, source: null, member_id: null, created_by: null },
              { id: 'd', starts_at: new Date(Date.now() + 86400000 * 14).toISOString(), title: 'No School', notes: 'Memorial Day', event_type: 'holiday', family_id: familyId, school_name: null, ends_at: null, source: null, member_id: null, created_by: null },
            ] as unknown as SchoolEvent[]).map((e, i) => {
              const d = new Date(e.starts_at);
              return (
                <div key={e.id} className="flex items-start gap-3">
                  <div className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-lg text-center text-white', ACCENT[i % ACCENT.length])}>
                    <div><p className="text-[9px] font-bold uppercase">{d.toLocaleDateString('en-US', { month: 'short' })}</p><p className="text-sm font-black leading-none">{d.getDate()}</p></div>
                  </div>
                  <div><p className="text-sm font-semibold">{e.title}</p><p className="text-xs text-white/45">{d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}</p>{e.notes && <p className="text-xs text-white/35">{e.notes}</p>}</div>
                </div>
              );
            })}
          </div>
          <button className="mt-4 flex items-center gap-1 text-xs text-violet-300">View all events <ChevronRight className="h-3.5 w-3.5" /></button>
        </div>
        <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-5">
          <h2 className="mb-4 font-semibold">Grade Summary <span className="text-xs text-white/35">(This Term)</span></h2>
          <div className="flex items-center gap-4">
            <div className="relative h-24 w-24 shrink-0">
              <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90">
                <circle cx="50" cy="50" r="40" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="14" />
                {gradeSegs.map((s, i) => s.dash > 0 && <circle key={i} cx="50" cy="50" r="40" fill="none" stroke={s.color} strokeWidth="14" strokeDasharray={`${s.dash} ${circ}`} strokeDashoffset={s.offset} />)}
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center"><span className="text-xl font-black">{GRADE_DATA.gpa}</span><span className="text-[9px] text-white/40">GPA</span></div>
            </div>
            <div className="space-y-1.5">
              {GRADE_DATA.dist.map(({ label, count, color }) => (
                <div key={label} className="flex items-center gap-2 text-xs">
                  <div className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color }} />
                  <span className="flex-1 text-white/60">{label}</span><span className="font-bold">{count}</span>
                </div>
              ))}
            </div>
          </div>
          <button className="mt-4 flex items-center gap-1 text-xs text-violet-300">View grade details <ChevronRight className="h-3.5 w-3.5" /></button>
        </div>
        <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-5">
          <div className="mb-4 flex items-center justify-between"><h2 className="font-semibold">Important Dates</h2><button className="text-xs font-semibold text-violet-300">View all</button></div>
          <div className="space-y-3">
            {IMPORTANT_DATES.map(({ month, day, label, sub }) => (
              <div key={label} className="flex items-start gap-3">
                <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-violet-500/15 text-center"><div><p className="text-[9px] font-bold uppercase text-violet-300">{month}</p><p className="text-sm font-black text-violet-200 leading-none">{day}</p></div></div>
                <div><p className="text-sm font-semibold">{label}</p><p className="text-xs text-white/40">{sub}</p></div>
              </div>
            ))}
          </div>
          <button className="mt-4 flex items-center gap-1 text-xs text-violet-300">View academic calendar <ChevronRight className="h-3.5 w-3.5" /></button>
        </div>
        <div className="rounded-2xl border border-violet-400/25 bg-gradient-to-br from-violet-600/10 to-blue-900/10 p-5 text-center">
          <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-full bg-violet-600/20"><Sparkles className="h-6 w-6 text-violet-300" /></div>
          <h3 className="font-bold">AI Study Helper</h3>
          <p className="mt-2 text-xs leading-5 text-white/55">Get study tips, homework help, and resources for your kids.</p>
          <button className="mt-4 w-full rounded-xl bg-gradient-to-r from-blue-500 to-violet-600 py-2.5 text-sm font-bold shadow-glow">Ask AI</button>
        </div>
      </aside>
      <Modal open={open} title="Add School Event" onClose={() => setOpen(false)}>
        <div className="space-y-4">
          <Field label="Title">{(id) => <Input id={id} value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} placeholder="e.g. Math Worksheet" />}</Field>
          <Field label="Type">{(id) => <Select id={id} value={form.event_type} onChange={(e) => setForm((f) => ({ ...f, event_type: e.target.value }))}>{EVENT_TYPES.map((t) => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}</Select>}</Field>
          <Field label="Student">{(id) => <Select id={id} value={form.member_id} onChange={(e) => setForm((f) => ({ ...f, member_id: e.target.value }))}><option value="">All</option>{members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</Select>}</Field>
          <Field label="Date & Time">{(id) => <Input id={id} type="datetime-local" value={form.starts_at} onChange={(e) => setForm((f) => ({ ...f, starts_at: e.target.value }))} />}</Field>
          <Field label="Notes">{(id) => <Input id={id} value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />}</Field>
          <button onClick={save} disabled={saving || !form.title || !form.starts_at} className="w-full rounded-xl bg-gradient-to-r from-blue-500 to-violet-600 py-3 text-sm font-bold disabled:opacity-40">{saving ? 'Saving…' : 'Add Event'}</button>
        </div>
      </Modal>
    </div>
  );
}