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
import { LoadingBlock, ErrorState, EmptyState } from '@/components/ui/states';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/app/page-header';
import { cn } from '@/lib/utils/cn';
import type { Tables, GradeType } from '@/lib/database.types';

type SchoolEvent = Tables<'school_events'>;
type SchoolClass = Tables<'school_classes'>;
type Grade = Tables<'grades'>;

const TABS = ['Overview', 'Assignments', 'Classes', 'Grades', 'Resources'] as const;
type Tab = (typeof TABS)[number];

const EVENT_TYPES = ['general', 'holiday', 'field_trip', 'parent_meeting', 'exam', 'concert', 'sport', 'graduation', 'assignment', 'announcement'];
const GRADE_TYPES: GradeType[] = ['test', 'quiz', 'homework', 'project', 'final', 'participation', 'other'];
const DAYS_OF_WEEK = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const SUBJECT_ICONS: Record<string, string> = { Math: '📐', English: '📝', Science: '🔬', History: '🏛️', Spanish: '🌎', Art: '🎨', Music: '🎵', PE: '⚽' };
const SUBJECT_COLORS: Record<string, string> = { Math: 'bg-violet-500', English: 'bg-blue-500', Science: 'bg-emerald-500', History: 'bg-orange-500', Spanish: 'bg-rose-500', Art: 'bg-pink-500', Music: 'bg-amber-500', PE: 'bg-cyan-500' };
const ACCENT = ['bg-violet-500', 'bg-blue-500', 'bg-emerald-500', 'bg-orange-500'];

const GRADE_DIST_COLORS = [
  { label: 'A (90-100%)', min: 90, color: '#34d399' },
  { label: 'B (80-89%)', min: 80, color: '#60a5fa' },
  { label: 'C (70-79%)', min: 70, color: '#fbbf24' },
  { label: 'D (60-69%)', min: 60, color: '#fb923c' },
  { label: 'F (Below 60%)', min: 0, color: '#f87171' },
];

function fmtDue(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.ceil((d.getTime() - today.getTime()) / 86400000);
  if (diff <= 0) return { label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), sub: 'Today', urgent: true };
  if (diff === 1) return { label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), sub: 'Tomorrow', urgent: true };
  return { label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), sub: `${diff} days left`, urgent: false };
}

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function letterGrade(pct: number): string {
  if (pct >= 93) return 'A';
  if (pct >= 90) return 'A-';
  if (pct >= 87) return 'B+';
  if (pct >= 83) return 'B';
  if (pct >= 80) return 'B-';
  if (pct >= 77) return 'C+';
  if (pct >= 73) return 'C';
  if (pct >= 70) return 'C-';
  if (pct >= 67) return 'D+';
  if (pct >= 60) return 'D';
  return 'F';
}

function gpaFromPct(pct: number): number {
  if (pct >= 93) return 4.0;
  if (pct >= 90) return 3.7;
  if (pct >= 87) return 3.3;
  if (pct >= 83) return 3.0;
  if (pct >= 80) return 2.7;
  if (pct >= 77) return 2.3;
  if (pct >= 73) return 2.0;
  if (pct >= 70) return 1.7;
  if (pct >= 67) return 1.3;
  if (pct >= 60) return 1.0;
  return 0.0;
}

export function SchoolModule() {
  const { familyId, userId, members } = useApp();
  const { success, error: toastError } = useToast();
  const [tab, setTab] = useState<Tab>('Overview');
  const [scheduleIdx, setScheduleIdx] = useState(0);

  // Modal states
  const [eventOpen, setEventOpen] = useState(false);
  const [classOpen, setClassOpen] = useState(false);
  const [gradeOpen, setGradeOpen] = useState(false);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  // Forms
  const [eventForm, setEventForm] = useState({ title: '', event_type: 'assignment', starts_at: '', notes: '', member_id: '', school_name: '' });
  const [classForm, setClassForm] = useState({ member_id: '', subject: '', teacher: '', room: '', time_slot: '', day_of_week: '1', school_name: '' });
  const [gradeForm, setGradeForm] = useState({ member_id: '', subject: '', title: '', grade: '', grade_type: 'test' as GradeType, score: '', max_score: '100', date: '' });

  const now = useMemo(() => new Date().toISOString(), []);
  const in14 = useMemo(() => { const d = new Date(); d.setDate(d.getDate() + 14); return d.toISOString(); }, []);
  const today = useMemo(() => new Date().getDay(), []);

  // ── Queries ──────────────────────────────────────────────
  const { data: events, loading: eventsLoading, error: eventsError, refresh: refreshEvents } = useRealtimeQuery<SchoolEvent>({
    table: 'school_events', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('school_events').select('*').eq('family_id', familyId).order('starts_at'),
  });

  const { data: classes, loading: classesLoading, error: classesError, refresh: refreshClasses } = useRealtimeQuery<SchoolClass>({
    table: 'school_classes', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('school_classes').select('*').eq('family_id', familyId).order('time_slot'),
  });

  const { data: grades, loading: gradesLoading, error: gradesError, refresh: refreshGrades } = useRealtimeQuery<Grade>({
    table: 'grades', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('grades').select('*').eq('family_id', familyId).order('date', { ascending: false }),
  });

  const loading = eventsLoading || classesLoading || gradesLoading;
  const error = eventsError || classesError || gradesError;

  // ── Derived data ─────────────────────────────────────────
  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);

  // Students: members who have classes or grades
  const studentIds = useMemo(() => {
    const ids = new Set<string>();
    classes.forEach((c) => ids.add(c.member_id));
    grades.forEach((g) => ids.add(g.member_id));
    return ids;
  }, [classes, grades]);

  // Assignments: school_events with event_type assignment or exam, future
  const assignments = useMemo(
    () => events.filter((e) => (e.event_type === 'assignment' || e.event_type === 'exam') && e.starts_at >= now),
    [events, now],
  );

  // Announcements: school_events with event_type announcement
  const announcements = useMemo(
    () => events.filter((e) => e.event_type === 'announcement').slice(0, 5),
    [events],
  );

  // Sidebar events: upcoming non-assignment/non-announcement events
  const sidebarEvents = useMemo(
    () => events.filter((e) => e.starts_at >= now && e.starts_at <= in14 && e.event_type !== 'assignment' && e.event_type !== 'announcement').slice(0, 4),
    [events, now, in14],
  );

  // Important dates: upcoming non-assignment events
  const importantDates = useMemo(
    () => events.filter((e) => e.starts_at >= now && e.event_type !== 'assignment' && e.event_type !== 'announcement').slice(0, 4),
    [events, now],
  );

  // Events this week
  const eventsThisWeek = useMemo(() => {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const daysSinceMon = (start.getDay() + 6) % 7;
    start.setDate(start.getDate() - daysSinceMon);
    const end = new Date(start); end.setDate(end.getDate() + 7);
    return events.filter((e) => { const d = new Date(e.starts_at); return d >= start && d < end; });
  }, [events]);

  // Class schedule for selected member
  const selectedMember = members[scheduleIdx];
  const memberClasses = useMemo(
    () => selectedMember ? classes.filter((c) => c.member_id === selectedMember.id).sort((a, b) => (a.time_slot ?? '').localeCompare(b.time_slot ?? '')) : [],
    [classes, selectedMember],
  );
  const todayClasses = useMemo(
    () => memberClasses.filter((c) => c.day_of_week === null || c.day_of_week === today),
    [memberClasses, today],
  );

  // Grade summary
  const gradeStats = useMemo(() => {
    const scored = grades.filter((g) => g.score != null && g.max_score != null && g.max_score > 0);
    if (scored.length === 0) return { gpa: '—', avgPct: 0, dist: GRADE_DIST_COLORS.map((d) => ({ ...d, count: 0 })) };

    const pcts = scored.map((g) => ((g.score! / g.max_score!) * 100));
    const avgPct = pcts.reduce((a, b) => a + b, 0) / pcts.length;
    const gpaVal = pcts.map(gpaFromPct).reduce((a, b) => a + b, 0) / pcts.length;

    const dist = GRADE_DIST_COLORS.map((d, i) => {
      const next = GRADE_DIST_COLORS[i - 1]?.min ?? 101;
      return { ...d, count: pcts.filter((p) => p >= d.min && p < next).length };
    });

    return { gpa: gpaVal.toFixed(2), avgPct, dist };
  }, [grades]);

  // Donut chart segments
  const circ = 251.2;
  const gradeSegs = useMemo(() => {
    const total = gradeStats.dist.reduce((s, g) => s + g.count, 0) || 1;
    let off = 0;
    return gradeStats.dist.map((g) => {
      const dash = (g.count / total) * circ;
      const seg = { dash, offset: circ - off, color: g.color };
      off += dash;
      return seg;
    });
  }, [gradeStats]);

  // ── CRUD handlers ────────────────────────────────────────
  async function saveEvent() {
    if (!eventForm.title || !eventForm.starts_at) return;
    setSaving(true);
    const sb = createClient();
    const { error: err } = await sb.from('school_events').insert({
      family_id: familyId, title: eventForm.title, event_type: eventForm.event_type,
      starts_at: new Date(eventForm.starts_at).toISOString(), notes: eventForm.notes || null,
      member_id: eventForm.member_id || null, school_name: eventForm.school_name || null, created_by: userId,
    });
    setSaving(false);
    if (err) { toastError('Failed to save event'); return; }
    success('Event added!');
    setEventOpen(false);
    setEventForm({ title: '', event_type: 'assignment', starts_at: '', notes: '', member_id: '', school_name: '' });
    refreshEvents();
  }

  async function saveClass() {
    if (!classForm.member_id || !classForm.subject) return;
    setSaving(true);
    const sb = createClient();
    const { error: err } = await sb.from('school_classes').insert({
      family_id: familyId, member_id: classForm.member_id, subject: classForm.subject,
      teacher: classForm.teacher || null, room: classForm.room || null,
      time_slot: classForm.time_slot || null, day_of_week: classForm.day_of_week ? parseInt(classForm.day_of_week) : null,
      school_name: classForm.school_name || null, created_by: userId,
    });
    setSaving(false);
    if (err) { toastError('Failed to save class'); return; }
    success('Class added!');
    setClassOpen(false);
    setClassForm({ member_id: '', subject: '', teacher: '', room: '', time_slot: '', day_of_week: '1', school_name: '' });
    refreshClasses();
  }

  async function saveGrade() {
    if (!gradeForm.member_id || !gradeForm.subject) return;
    setSaving(true);
    const sb = createClient();
    const { error: err } = await sb.from('grades').insert({
      family_id: familyId, member_id: gradeForm.member_id, subject: gradeForm.subject,
      title: gradeForm.title || null, grade: gradeForm.grade || null,
      grade_type: gradeForm.grade_type, score: gradeForm.score ? parseFloat(gradeForm.score) : null,
      max_score: gradeForm.max_score ? parseFloat(gradeForm.max_score) : null,
      date: gradeForm.date || new Date().toISOString().split('T')[0], created_by: userId,
    });
    setSaving(false);
    if (err) { toastError('Failed to save grade'); return; }
    success('Grade added!');
    setGradeOpen(false);
    setGradeForm({ member_id: '', subject: '', title: '', grade: '', grade_type: 'test', score: '', max_score: '100', date: '' });
    refreshGrades();
  }

  if (loading) return <LoadingBlock />;
  if (error) return <ErrorState message={error} />;

  return (
    <div className="module-with-sidebar">
      <div className="module-main module-page">
        <PageHeader
          title="School"
          description="Stay on top of classes, assignments, and school events."
          action={
            <div className="relative">
              <Button onClick={() => setAddMenuOpen((v) => !v)}><Plus className="h-4 w-4" /> Add Item</Button>
              {addMenuOpen && (
                <div className="absolute right-0 top-full z-20 mt-1 w-48 rounded-xl border border-border bg-surface p-1 shadow-lg">
                  <button className="w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-surface/60" onClick={() => { setAddMenuOpen(false); setEventOpen(true); }}>School Event</button>
                  <button className="w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-surface/60" onClick={() => { setAddMenuOpen(false); setClassOpen(true); }}>Class</button>
                  <button className="w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-surface/60" onClick={() => { setAddMenuOpen(false); setGradeOpen(true); }}>Grade</button>
                </div>
              )}
            </div>
          }
        />

        {/* Tab bar */}
        <div className="flex items-center justify-between border-b border-border">
          <div className="tab-bar">{TABS.map((t) => <button key={t} onClick={() => setTab(t)} className={cn('tab-item', tab === t ? 'tab-item-active' : 'tab-item-inactive')}>{t}</button>)}</div>
          <div className="flex gap-2 pb-1">
            <button className="btn-inline"><Filter className="h-3 w-3" /> Filter</button>
            <button className="btn-inline"><MoreHorizontal className="h-3 w-3" /> More</button>
          </div>
        </div>

        {/* Stats grid */}
        <div className="grid-stats gap-3">
          {[
            { icon: GraduationCap, label: 'Students', value: studentIds.size, sub: 'Enrolled', bg: 'bg-violet-600/20 text-violet-300' },
            { icon: BookOpen, label: 'Assignments Due', value: assignments.length, sub: 'Upcoming', bg: 'bg-emerald-600/20 text-emerald-300' },
            { icon: Calendar, label: 'Events', value: eventsThisWeek.length, sub: 'This week', bg: 'bg-orange-600/20 text-orange-300' },
            { icon: GraduationCap, label: 'Average Grade', value: gradeStats.avgPct > 0 ? letterGrade(gradeStats.avgPct) : '—', sub: 'This term', bg: 'bg-blue-600/20 text-blue-300' },
          ].map(({ icon: Icon, label, value, sub, bg }) => (
            <div key={label} className="stat-card">
              <div className={cn('mb-3 grid h-10 w-10 place-items-center rounded-xl', bg)}><Icon className="h-5 w-5" /></div>
              <p className="text-2xl font-black">{value}</p><p className="text-sm font-semibold">{label}</p><p className="text-xs text-muted">{sub}</p>
            </div>
          ))}
        </div>

        {/* Upcoming Assignments */}
        {(tab === 'Overview' || tab === 'Assignments') && (
          <div className="rounded-2xl border border-border bg-surface/40">
            <div className="flex items-center justify-between p-5">
              <h2 className="font-semibold">Upcoming Assignments</h2>
              <button onClick={() => setTab('Assignments')} className="flex items-center gap-1 text-xs font-semibold text-brand">View all assignments <ChevronRight className="h-3.5 w-3.5" /></button>
            </div>
            {assignments.length === 0 ? (
              <div className="p-5 pt-0">
                <EmptyState icon={BookOpen} title="No assignments yet" description="Add assignment events to track due dates." action={<Button onClick={() => setEventOpen(true)}><Plus className="h-4 w-4" /> Add Assignment</Button>} />
              </div>
            ) : (
              <>
                <div className="table-responsive overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead><tr className="border-t border-border text-xs text-muted">
                      <th className="px-5 py-3 text-left font-medium">Assignment</th>
                      <th className="px-4 py-3 text-left font-medium">Student</th>
                      <th className="px-4 py-3 text-left font-medium">Type</th>
                      <th className="px-4 py-3 text-left font-medium">Due Date</th>
                      <th className="w-8 px-4 py-3" />
                    </tr></thead>
                    <tbody className="divide-y divide-white/5">
                      {(tab === 'Assignments' ? assignments : assignments.slice(0, 5)).map((e) => {
                        const due = fmtDue(e.starts_at);
                        const member = e.member_id ? memberById.get(e.member_id) : undefined;
                        return (
                          <tr key={e.id} className="hover:bg-surface/20">
                            <td className="px-5 py-3.5">
                              <div className="flex items-center gap-3">
                                <span className="text-lg">{e.event_type === 'exam' ? '📝' : '📚'}</span>
                                <div><p className="font-medium">{e.title}</p>{e.notes && <p className="text-xs text-muted">{e.notes}</p>}</div>
                              </div>
                            </td>
                            <td className="px-4 py-3.5">
                              {member ? <div className="flex items-center gap-2"><Avatar name={member.display_name} color={member.color} size={28} /><span>{member.display_name.split(' ')[0]}</span></div> : <span className="text-muted/60">All</span>}
                            </td>
                            <td className="px-4 py-3.5 capitalize text-fg">{(e.event_type ?? 'general').replace('_', ' ')}</td>
                            <td className="px-4 py-3.5"><p className="font-medium">{due.label}</p><p className={cn('text-xs', due.urgent ? 'text-orange-400' : 'text-muted')}>{due.sub}</p></td>
                            <td className="px-4 py-3.5"><button className="text-muted/60 hover:text-muted"><MoreHorizontal className="h-4 w-4" /></button></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {tab === 'Overview' && assignments.length > 5 && (
                  <div className="border-t border-border p-4 text-center">
                    <button onClick={() => setTab('Assignments')} className="mx-auto flex items-center gap-1 text-xs font-semibold text-brand">View all {assignments.length} assignments <ChevronRight className="h-3.5 w-3.5" /></button>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* Classes tab */}
        {tab === 'Classes' && (
          <div className="rounded-2xl border border-border bg-surface/40 p-5">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="font-semibold">All Classes</h2>
              <Button onClick={() => setClassOpen(true)}><Plus className="h-4 w-4" /> Add Class</Button>
            </div>
            {classes.length === 0 ? (
              <EmptyState icon={BookOpen} title="No classes added" description="Add your classes to see schedules." action={<Button onClick={() => setClassOpen(true)}><Plus className="h-4 w-4" /> Add Class</Button>} />
            ) : (
              <div className="space-y-2">
                {classes.map((c) => {
                  const member = memberById.get(c.member_id);
                  return (
                    <div key={c.id} className="flex items-center gap-3 rounded-xl border border-border bg-surface/20 p-3 text-sm">
                      <div className={cn('h-2.5 w-2.5 shrink-0 rounded-full', SUBJECT_COLORS[c.subject] ?? 'bg-gray-500')} />
                      <span className="text-lg">{SUBJECT_ICONS[c.subject] ?? '📚'}</span>
                      <div className="flex-1">
                        <p className="font-medium">{c.subject}</p>
                        <p className="text-xs text-muted">{[c.teacher, c.room, c.day_of_week != null ? DAYS_OF_WEEK[c.day_of_week] : null].filter(Boolean).join(' · ')}</p>
                      </div>
                      {member && <Avatar name={member.display_name} color={member.color} size={24} />}
                      {c.time_slot && <span className="text-xs text-muted tabular-nums">{c.time_slot}</span>}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Grades tab */}
        {tab === 'Grades' && (
          <div className="rounded-2xl border border-border bg-surface/40 p-5">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="font-semibold">All Grades</h2>
              <Button onClick={() => setGradeOpen(true)}><Plus className="h-4 w-4" /> Add Grade</Button>
            </div>
            {grades.length === 0 ? (
              <EmptyState icon={GraduationCap} title="No grades recorded" description="Add grades to track academic performance." action={<Button onClick={() => setGradeOpen(true)}><Plus className="h-4 w-4" /> Add Grade</Button>} />
            ) : (
              <div className="table-responsive overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="border-b border-border text-xs text-muted">
                    <th className="px-4 py-3 text-left font-medium">Title</th>
                    <th className="px-4 py-3 text-left font-medium">Student</th>
                    <th className="px-4 py-3 text-left font-medium">Subject</th>
                    <th className="px-4 py-3 text-left font-medium">Type</th>
                    <th className="px-4 py-3 text-left font-medium">Score</th>
                    <th className="px-4 py-3 text-left font-medium">Date</th>
                  </tr></thead>
                  <tbody className="divide-y divide-white/5">
                    {grades.map((g) => {
                      const member = memberById.get(g.member_id);
                      const pct = g.score != null && g.max_score ? (g.score / g.max_score) * 100 : null;
                      return (
                        <tr key={g.id} className="hover:bg-surface/20">
                          <td className="px-4 py-3"><p className="font-medium">{g.title ?? g.subject}</p></td>
                          <td className="px-4 py-3">{member ? <div className="flex items-center gap-2"><Avatar name={member.display_name} color={member.color} size={24} /><span>{member.display_name.split(' ')[0]}</span></div> : '—'}</td>
                          <td className="px-4 py-3">{g.subject}</td>
                          <td className="px-4 py-3 capitalize">{g.grade_type}</td>
                          <td className="px-4 py-3">
                            {pct != null ? (
                              <span className={cn('font-bold', pct >= 90 ? 'text-emerald-400' : pct >= 80 ? 'text-blue-400' : pct >= 70 ? 'text-yellow-400' : 'text-red-400')}>
                                {g.score}/{g.max_score} ({pct.toFixed(0)}%)
                              </span>
                            ) : g.grade ?? '—'}
                          </td>
                          <td className="px-4 py-3 text-muted">{new Date(g.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* Resources tab */}
        {tab === 'Resources' && (
          <div className="rounded-2xl border border-border bg-surface/40 p-5">
            <EmptyState icon={BookOpen} title="Resources coming soon" description="Study materials, links, and helpful resources will appear here." />
          </div>
        )}

        {/* Two-column grid: Class Schedules + Announcements (Overview) */}
        {tab === 'Overview' && (
          <div className="grid gap-5 lg:grid-cols-2">
            {/* Class Schedules */}
            <div className="rounded-2xl border border-border bg-surface/40 p-5">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="font-semibold">Today&apos;s Classes</h2>
                <button onClick={() => setTab('Classes')} className="text-xs font-semibold text-brand">View full schedule →</button>
              </div>
              {members.length > 0 && (
                <div className="mb-4 flex gap-2 overflow-x-auto pb-1">
                  {members.slice(0, 4).map((m, i) => (
                    <button key={m.id} onClick={() => setScheduleIdx(i)} className={cn('flex items-center gap-1.5 whitespace-nowrap rounded-full px-3 py-1.5 text-sm transition', scheduleIdx === i ? 'bg-brand text-white' : 'border border-border text-muted hover:text-fg')}>
                      <Avatar name={m.display_name} color={m.color} size={18} />{m.display_name.split(' ')[0]}
                    </button>
                  ))}
                </div>
              )}
              {todayClasses.length === 0 ? (
                <EmptyState icon={BookOpen} title="No classes today" description={selectedMember ? `No classes scheduled for ${selectedMember.display_name.split(' ')[0]} today.` : 'Add classes to see the schedule.'} action={<Button onClick={() => setClassOpen(true)}><Plus className="h-4 w-4" /> Add Class</Button>} />
              ) : (
                <div className="space-y-2.5">
                  {todayClasses.map((c) => (
                    <div key={c.id} className="flex items-center gap-3 text-sm">
                      <span className="w-16 shrink-0 text-xs text-muted tabular-nums">{c.time_slot ?? '—'}</span>
                      <div className={cn('h-2.5 w-2.5 shrink-0 rounded-full', SUBJECT_COLORS[c.subject] ?? 'bg-gray-500')} />
                      <span className="flex-1 font-medium">{c.subject}</span>
                      <span className="text-xs text-muted">{c.room ?? ''}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Announcements */}
            <div className="rounded-2xl border border-border bg-surface/40 p-5">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="font-semibold">School Announcements</h2>
              </div>
              {announcements.length === 0 ? (
                <EmptyState icon={BookOpen} title="No announcements" description="Announcements will appear here when added." action={<Button onClick={() => { setEventForm((f) => ({ ...f, event_type: 'announcement' })); setEventOpen(true); }}><Plus className="h-4 w-4" /> Add Announcement</Button>} />
              ) : (
                <div className="space-y-4">
                  {announcements.map((a) => (
                    <div key={a.id} className="flex gap-3">
                      <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-surface/40 text-lg">📢</div>
                      <div>
                        <p className="text-sm font-semibold">{a.title}</p>
                        {a.notes && <p className="mt-0.5 text-xs leading-5 text-muted">{a.notes}</p>}
                        <p className="mt-1 text-xs text-muted/60">{timeAgo(a.starts_at)}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── Sidebar ───────────────────────────────────────────── */}
      <aside className="module-sidebar hidden lg:flex lg:flex-col gap-5">
        {/* Upcoming School Events */}
        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <div className="mb-4 flex items-center justify-between"><h2 className="font-semibold">Upcoming School Events</h2></div>
          {sidebarEvents.length === 0 ? (
            <p className="text-sm text-muted">No upcoming events in the next 2 weeks.</p>
          ) : (
            <div className="space-y-3">
              {sidebarEvents.map((e, i) => {
                const d = new Date(e.starts_at);
                return (
                  <div key={e.id} className="flex items-start gap-3">
                    <div className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-lg text-center text-white', ACCENT[i % ACCENT.length])}>
                      <div><p className="text-[9px] font-bold uppercase">{d.toLocaleDateString('en-US', { month: 'short' })}</p><p className="text-sm font-black leading-none">{d.getDate()}</p></div>
                    </div>
                    <div>
                      <p className="text-sm font-semibold">{e.title}</p>
                      <p className="text-xs text-muted">{d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}</p>
                      {e.notes && <p className="text-xs text-muted/60">{e.notes}</p>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Grade Summary */}
        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <h2 className="mb-4 font-semibold">Grade Summary <span className="text-xs text-muted/60">(This Term)</span></h2>
          {grades.length === 0 ? (
            <p className="text-sm text-muted">No grades recorded yet.</p>
          ) : (
            <>
              <div className="flex items-center gap-4">
                <div className="relative h-24 w-24 shrink-0">
                  <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90">
                    <circle cx="50" cy="50" r="40" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="14" />
                    {gradeSegs.map((s, i) => s.dash > 0 && <circle key={i} cx="50" cy="50" r="40" fill="none" stroke={s.color} strokeWidth="14" strokeDasharray={`${s.dash} ${circ}`} strokeDashoffset={s.offset} />)}
                  </svg>
                  <div className="absolute inset-0 flex flex-col items-center justify-center"><span className="text-xl font-black">{gradeStats.gpa}</span><span className="text-[9px] text-muted">GPA</span></div>
                </div>
                <div className="space-y-1.5">
                  {gradeStats.dist.map(({ label, count, color }) => (
                    <div key={label} className="flex items-center gap-2 text-xs">
                      <div className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color }} />
                      <span className="flex-1 text-muted">{label}</span><span className="font-bold">{count}</span>
                    </div>
                  ))}
                </div>
              </div>
              <button onClick={() => setTab('Grades')} className="mt-4 flex items-center gap-1 text-xs text-brand">View grade details <ChevronRight className="h-3.5 w-3.5" /></button>
            </>
          )}
        </div>

        {/* Important Dates */}
        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <div className="mb-4 flex items-center justify-between"><h2 className="font-semibold">Important Dates</h2></div>
          {importantDates.length === 0 ? (
            <p className="text-sm text-muted">No upcoming dates.</p>
          ) : (
            <div className="space-y-3">
              {importantDates.map((e) => {
                const d = new Date(e.starts_at);
                return (
                  <div key={e.id} className="flex items-start gap-3">
                    <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-brand/15 text-center">
                      <div><p className="text-[9px] font-bold uppercase text-brand">{d.toLocaleDateString('en-US', { month: 'short' })}</p><p className="text-sm font-black text-violet-200 leading-none">{d.getDate()}</p></div>
                    </div>
                    <div><p className="text-sm font-semibold">{e.title}</p><p className="text-xs text-muted">{d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}</p></div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* AI Study Helper */}
        <div className="rounded-2xl border border-brand/25 bg-gradient-to-br from-violet-600/10 to-blue-900/10 p-5 text-center">
          <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-full bg-brand/15"><Sparkles className="h-6 w-6 text-brand" /></div>
          <h3 className="font-bold">AI Study Helper</h3>
          <p className="mt-2 text-xs leading-5 text-muted">Get study tips, homework help, and resources for your kids.</p>
          <Button className="mt-4 w-full">Ask AI</Button>
        </div>
      </aside>

      {/* ── Modals ────────────────────────────────────────────── */}
      <Modal open={eventOpen} title="Add School Event" onClose={() => setEventOpen(false)}>
        <div className="space-y-4">
          <Field label="Title">{(id) => <Input id={id} value={eventForm.title} onChange={(e) => setEventForm((f) => ({ ...f, title: e.target.value }))} placeholder="e.g. Math Worksheet" />}</Field>
          <Field label="Type">{(id) => <Select id={id} value={eventForm.event_type} onChange={(e) => setEventForm((f) => ({ ...f, event_type: e.target.value }))}>{EVENT_TYPES.map((t) => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}</Select>}</Field>
          <Field label="Student">{(id) => <Select id={id} value={eventForm.member_id} onChange={(e) => setEventForm((f) => ({ ...f, member_id: e.target.value }))}><option value="">All</option>{members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</Select>}</Field>
          <Field label="Date & Time">{(id) => <Input id={id} type="datetime-local" value={eventForm.starts_at} onChange={(e) => setEventForm((f) => ({ ...f, starts_at: e.target.value }))} />}</Field>
          <Field label="School">{(id) => <Input id={id} value={eventForm.school_name} onChange={(e) => setEventForm((f) => ({ ...f, school_name: e.target.value }))} placeholder="Optional" />}</Field>
          <Field label="Notes">{(id) => <Input id={id} value={eventForm.notes} onChange={(e) => setEventForm((f) => ({ ...f, notes: e.target.value }))} />}</Field>
          <Button className="w-full" onClick={saveEvent} disabled={saving || !eventForm.title || !eventForm.starts_at}>{saving ? 'Saving...' : 'Add Event'}</Button>
        </div>
      </Modal>

      <Modal open={classOpen} title="Add Class" onClose={() => setClassOpen(false)}>
        <div className="space-y-4">
          <Field label="Student">{(id) => <Select id={id} value={classForm.member_id} onChange={(e) => setClassForm((f) => ({ ...f, member_id: e.target.value }))}><option value="">Select student</option>{members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</Select>}</Field>
          <Field label="Subject">{(id) => <Input id={id} value={classForm.subject} onChange={(e) => setClassForm((f) => ({ ...f, subject: e.target.value }))} placeholder="e.g. Math" />}</Field>
          <Field label="Teacher">{(id) => <Input id={id} value={classForm.teacher} onChange={(e) => setClassForm((f) => ({ ...f, teacher: e.target.value }))} placeholder="Optional" />}</Field>
          <Field label="Room">{(id) => <Input id={id} value={classForm.room} onChange={(e) => setClassForm((f) => ({ ...f, room: e.target.value }))} placeholder="e.g. Room 203" />}</Field>
          <Field label="Time">{(id) => <Input id={id} value={classForm.time_slot} onChange={(e) => setClassForm((f) => ({ ...f, time_slot: e.target.value }))} placeholder="e.g. 8:00 AM" />}</Field>
          <Field label="Day of Week">{(id) => <Select id={id} value={classForm.day_of_week} onChange={(e) => setClassForm((f) => ({ ...f, day_of_week: e.target.value }))}>{DAYS_OF_WEEK.map((d, i) => <option key={i} value={String(i)}>{d}</option>)}</Select>}</Field>
          <Field label="School">{(id) => <Input id={id} value={classForm.school_name} onChange={(e) => setClassForm((f) => ({ ...f, school_name: e.target.value }))} placeholder="Optional" />}</Field>
          <Button className="w-full" onClick={saveClass} disabled={saving || !classForm.member_id || !classForm.subject}>{saving ? 'Saving...' : 'Add Class'}</Button>
        </div>
      </Modal>

      <Modal open={gradeOpen} title="Add Grade" onClose={() => setGradeOpen(false)}>
        <div className="space-y-4">
          <Field label="Student">{(id) => <Select id={id} value={gradeForm.member_id} onChange={(e) => setGradeForm((f) => ({ ...f, member_id: e.target.value }))}><option value="">Select student</option>{members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</Select>}</Field>
          <Field label="Subject">{(id) => <Input id={id} value={gradeForm.subject} onChange={(e) => setGradeForm((f) => ({ ...f, subject: e.target.value }))} placeholder="e.g. Math" />}</Field>
          <Field label="Title">{(id) => <Input id={id} value={gradeForm.title} onChange={(e) => setGradeForm((f) => ({ ...f, title: e.target.value }))} placeholder="e.g. Chapter 5 Test" />}</Field>
          <Field label="Type">{(id) => <Select id={id} value={gradeForm.grade_type} onChange={(e) => setGradeForm((f) => ({ ...f, grade_type: e.target.value as GradeType }))}>{GRADE_TYPES.map((t) => <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>)}</Select>}</Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Score">{(id) => <Input id={id} type="number" value={gradeForm.score} onChange={(e) => setGradeForm((f) => ({ ...f, score: e.target.value }))} placeholder="e.g. 92" />}</Field>
            <Field label="Max Score">{(id) => <Input id={id} type="number" value={gradeForm.max_score} onChange={(e) => setGradeForm((f) => ({ ...f, max_score: e.target.value }))} />}</Field>
          </div>
          <Field label="Letter Grade (optional)">{(id) => <Input id={id} value={gradeForm.grade} onChange={(e) => setGradeForm((f) => ({ ...f, grade: e.target.value }))} placeholder="e.g. A-" />}</Field>
          <Field label="Date">{(id) => <Input id={id} type="date" value={gradeForm.date} onChange={(e) => setGradeForm((f) => ({ ...f, date: e.target.value }))} />}</Field>
          <Button className="w-full" onClick={saveGrade} disabled={saving || !gradeForm.member_id || !gradeForm.subject}>{saving ? 'Saving...' : 'Add Grade'}</Button>
        </div>
      </Modal>
    </div>
  );
}
