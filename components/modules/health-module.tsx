'use client';

import { useMemo, useState } from 'react';
import { Activity, ChevronRight, Filter, Heart, MoreHorizontal, Plus, Sparkles, Zap } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { Input, Field, Select } from '@/components/ui/input';
import { Avatar } from '@/components/ui/avatar';
import { LoadingBlock, ErrorState } from '@/components/ui/states';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/app/page-header';
import { cn } from '@/lib/utils/cn';
import type { Tables } from '@/lib/database.types';

type Appointment = Tables<'appointments'>;
type Reminder = Tables<'reminders'>;

const TABS = ['Overview', 'Activity', 'Nutrition', 'Sleep', 'Checkups', 'Medications', 'Documents', 'Vitals'] as const;
type Tab = (typeof TABS)[number];

const MEMBER_STATS = [
  { steps: 12453, sleep: '7h 30m', hr: 68, pct: 85, color: '#7c5dff' },
  { steps: 8201, sleep: '8h 15m', hr: 72, pct: 58, color: '#60a5fa' },
  { steps: 5320, sleep: '9h 00m', hr: 78, pct: 38, color: '#34d399' },
  { steps: 2482, sleep: '8h 45m', hr: 82, pct: 18, color: '#fbbf24' },
];

const WEEKLY_BARS = [
  { day: 'Mon', val: 75 }, { day: 'Tue', val: 90 }, { day: 'Wed', val: 45 },
  { day: 'Thu', val: 80 }, { day: 'Fri', val: 60 }, { day: 'Sat', val: 100 }, { day: 'Sun', val: 55 },
];

const WORKOUTS_MOCK = [
  { icon: '🏃', name: 'Morning Run', sub: '3.2 miles · 28 min', cal: '285 cal', sidx: 0, time: 'Today 7:15 AM' },
  { icon: '🏊', name: 'Swim Practice', sub: '45 min · 1800m', cal: '420 cal', sidx: 1, time: 'Yesterday 4:30 PM' },
  { icon: '🚴', name: 'Bike Ride', sub: '12.5 miles · 52 min', cal: '380 cal', sidx: 0, time: 'May 11 8:00 AM' },
];

const INSIGHTS_MOCK = [
  { icon: '💡', text: 'Emma has been consistently hitting her step goals for 5 days in a row!', color: 'bg-violet-500/15 border-violet-400/20' },
  { icon: '😴', text: 'Average sleep improved 23 min this week compared to last week.', color: 'bg-blue-500/15 border-blue-400/20' },
  { icon: '⚠️', text: 'Jake has a scheduled checkup next week. Review the appointment details.', color: 'bg-orange-500/15 border-orange-400/20' },
];

const HEALTH_SUMMARY = [
  { label: 'Avg Steps', value: '7,114', sub: 'Family average', color: 'text-brand' },
  { label: 'Avg Sleep', value: '8h 22m', sub: 'Per night', color: 'text-blue-300' },
  { label: 'Calories Burned', value: '1,892', sub: 'Today combined', color: 'text-emerald-300' },
  { label: 'Active Days', value: '5 / 7', sub: 'This week', color: 'text-orange-300' },
];

const REMINDERS_FALLBACK = [
  { title: 'Take Allergy Medication', notes: 'Emma · 8:00 AM Daily' },
  { title: 'Vitamin D Supplement', notes: 'Whole family · Morning' },
  { title: 'Drink 8 glasses of water', notes: 'All members' },
];

export function HealthModule() {
  const { familyId, userId, members } = useApp();
  const { success, error: toastError } = useToast();
  const [tab, setTab] = useState<Tab>('Overview');
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ title: '', starts_at: '', member_id: '', notes: '' });
  const [saving, setSaving] = useState(false);

  const now = useMemo(() => new Date().toISOString(), []);

  const { data: appointments, loading: apptLoading, error: apptError } = useRealtimeQuery<Appointment>({
    table: 'appointments', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('appointments').select('*').eq('family_id', familyId).gte('starts_at', now).order('starts_at').limit(6),
  });

  const { data: reminders, loading: remLoading, error: remError } = useRealtimeQuery<Reminder>({
    table: 'reminders', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('reminders').select('*').eq('family_id', familyId).eq('is_done', false).limit(4),
  });

  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  const loading = apptLoading || remLoading;
  const error = apptError || remError;

  async function save() {
    if (!form.title || !form.starts_at) return; setSaving(true);
    const sb = createClient();
    const { error: err } = await sb.from('appointments').insert({ family_id: familyId, title: form.title, starts_at: new Date(form.starts_at).toISOString(), member_id: form.member_id || null, notes: form.notes || null, created_by: userId });
    setSaving(false);
    if (err) { toastError('Failed to save'); return; }
    success('Appointment added!'); setOpen(false); setForm({ title: '', starts_at: '', member_id: '', notes: '' });
  }

  if (loading) return <LoadingBlock />;
  if (error) return <ErrorState message={error} />;

  const goalPct = 68;
  const circ = 251.2;
  const dash = (goalPct / 100) * circ;

  const APPT_FALLBACK: Appointment[] = [
    { id: 'a', title: 'Annual Physical - Emma', starts_at: new Date(Date.now() + 86400000 * 7).toISOString(), family_id: familyId, member_id: members[0]?.id ?? null, provider: 'Dr. Martinez', location: 'Oak Medical', notes: 'Dr. Martinez · Oak Medical', ends_at: null, created_by: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
    { id: 'b', title: 'Dental Cleaning - Jake', starts_at: new Date(Date.now() + 86400000 * 14).toISOString(), family_id: familyId, member_id: members[1]?.id ?? null, provider: 'Dr. Chen', location: 'Bright Smiles', notes: 'Dr. Chen · Bright Smiles', ends_at: null, created_by: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
    { id: 'c', title: 'Eye Exam - Sarah', starts_at: new Date(Date.now() + 86400000 * 21).toISOString(), family_id: familyId, member_id: members[2]?.id ?? null, provider: 'Dr. Johnson', location: 'Vision Plus', notes: 'Dr. Johnson · Vision Plus', ends_at: null, created_by: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  ];

  const appts = appointments.length > 0 ? appointments : APPT_FALLBACK;
  const ACCENT = ['bg-violet-500', 'bg-blue-500', 'bg-emerald-500', 'bg-orange-500'];

  return (
    <div className="module-with-sidebar">
      <div className="module-main space-y-5">
        <PageHeader
          title="Health"
          description="Track fitness, wellness, and health across your whole family."
          action={<Button onClick={() => setOpen(true)} className="btn-cta"><Plus className="h-4 w-4" /> Add Checkup</Button>}
        />
        <div className="flex items-center justify-between border-b border-border">
          <div className="tab-bar">{TABS.map((t) => <button key={t} onClick={() => setTab(t)} className={cn('tab-item', tab === t ? 'tab-item-active' : 'tab-item-inactive')}>{t}</button>)}</div>
          <div className="shrink-0 pb-1"><button className="btn-inline"><Filter className="h-3 w-3" /> Filter</button></div>
        </div>
        <div className="grid-stats gap-3">
          {[
            { icon: Heart, label: 'Family Members', value: members.length || 4, sub: 'Tracking health', bg: 'bg-rose-600/20 text-rose-300' },
            { icon: Activity, label: 'Steps Today', value: '28,456', sub: 'Family combined', bg: 'bg-brand/15 text-brand' },
            { icon: Zap, label: 'Active Calories', value: '1,892', sub: 'Today combined', bg: 'bg-orange-600/20 text-orange-300' },
            { icon: Activity, label: 'Avg Sleep', value: '8h 22m', sub: 'Last night', bg: 'bg-blue-600/20 text-blue-300' },
          ].map(({ icon: Icon, label, value, sub, bg }) => (
            <div key={label} className="rounded-2xl border border-border bg-surface/40 p-4">
              <div className={cn('mb-3 grid h-10 w-10 place-items-center rounded-xl', bg)}><Icon className="h-5 w-5" /></div>
              <p className="text-2xl font-black">{value}</p><p className="text-sm font-semibold">{label}</p><p className="text-xs text-muted">{sub}</p>
            </div>
          ))}
        </div>
        <div className="grid gap-5 lg:grid-cols-2">
          <div className="rounded-2xl border border-border bg-surface/40 p-5">
            <div className="mb-4 flex items-center justify-between"><h2 className="font-semibold">Activity Summary</h2><span className="text-xs text-muted">Today</span></div>
            <div className="flex items-center gap-6">
              <div className="relative h-32 w-32 shrink-0">
                <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90">
                  <circle cx="50" cy="50" r="40" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="12" />
                  <circle cx="50" cy="50" r="40" fill="none" stroke="url(#healthGrad)" strokeWidth="12" strokeDasharray={`${dash} ${circ}`} strokeLinecap="round" />
                  <defs><linearGradient id="healthGrad" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stopColor="#7c5dff" /><stop offset="100%" stopColor="#34d399" /></linearGradient></defs>
                </svg>
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <span className="text-2xl font-black">{goalPct}%</span>
                  <span className="text-[10px] text-muted">Goal Met</span>
                </div>
              </div>
              <div className="space-y-3 flex-1">
                {[{ label: 'Steps', val: '8,234', goal: '10,000', pct: 82 }, { label: 'Calories', val: '1,245', goal: '2,000', pct: 62 }, { label: 'Active Min', val: '38', goal: '60', pct: 63 }].map((s) => (
                  <div key={s.label}>
                    <div className="flex justify-between text-xs mb-1"><span className="text-muted">{s.label}</span><span className="font-semibold">{s.val} / {s.goal}</span></div>
                    <div className="h-1.5 rounded-full bg-border"><div className="h-full rounded-full bg-gradient-to-r from-violet-500 to-emerald-400" style={{ width: `${s.pct}%` }} /></div>
                  </div>
                ))}
              </div>
            </div>
            <div className="mt-5">
              <p className="mb-3 text-xs text-muted">This Week</p>
              <div className="flex items-end gap-1.5 h-16">
                {WEEKLY_BARS.map(({ day, val }) => (
                  <div key={day} className="flex flex-1 flex-col items-center gap-1">
                    <div className="w-full rounded-sm bg-gradient-to-t from-violet-600 to-blue-400 opacity-80" style={{ height: `${val}%` }} />
                    <span className="text-[9px] text-muted/60">{day}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="rounded-2xl border border-border bg-surface/40 p-5">
            <div className="mb-4 flex items-center justify-between"><h2 className="font-semibold">Family Health at a Glance</h2><button className="text-xs font-semibold text-brand">View details &rarr;</button></div>
            <div className="space-y-3">
              {members.slice(0, 4).map((m, i) => {
                const stats = MEMBER_STATS[i % MEMBER_STATS.length];
                return (
                  <div key={m.id} className="rounded-xl border border-border p-3">
                    <div className="flex items-center gap-3 mb-2.5">
                      <Avatar name={m.display_name} color={m.color} size={32} />
                      <div className="flex-1"><p className="text-sm font-semibold">{m.display_name}</p><p className="text-xs text-muted">{m.role}</p></div>
                      <span className="text-xs font-bold" style={{ color: stats.color }}>{stats.pct}%</span>
                    </div>
                    <div className="grid grid-cols-3 gap-2 text-center text-xs">
                      <div><p className="font-bold">{stats.steps.toLocaleString()}</p><p className="text-muted">Steps</p></div>
                      <div><p className="font-bold">{stats.sleep}</p><p className="text-muted">Sleep</p></div>
                      <div><p className="font-bold">{stats.hr} bpm</p><p className="text-muted">Heart Rate</p></div>
                    </div>
                    <div className="mt-2.5 h-1.5 rounded-full bg-border"><div className="h-full rounded-full" style={{ width: `${stats.pct}%`, background: stats.color }} /></div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
        <div className="grid gap-5 lg:grid-cols-2">
          <div className="rounded-2xl border border-border bg-surface/40 p-5">
            <div className="mb-4 flex items-center justify-between"><h2 className="font-semibold">Recent Workouts</h2><button className="text-xs font-semibold text-brand">View all &rarr;</button></div>
            <div className="space-y-3">
              {WORKOUTS_MOCK.map((w) => (
                <div key={w.name} className="flex items-center gap-3">
                  <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-surface/40 text-xl">{w.icon}</div>
                  <div className="flex-1 min-w-0"><p className="text-sm font-semibold">{w.name}</p><p className="text-xs text-muted">{w.sub}</p></div>
                  <div className="text-right shrink-0"><p className="text-sm font-bold text-emerald-300">{w.cal}</p><p className="text-xs text-muted/60">{w.time}</p></div>
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-2xl border border-border bg-surface/40 p-5">
            <div className="mb-4 flex items-center justify-between"><h2 className="font-semibold">Health Insights</h2><span className="flex items-center gap-1 text-xs text-brand"><Sparkles className="h-3 w-3" /> AI-powered</span></div>
            <div className="space-y-3">
              {INSIGHTS_MOCK.map((insight) => (
                <div key={insight.text} className={cn('flex items-start gap-3 rounded-xl border p-3', insight.color)}>
                  <span className="text-lg shrink-0">{insight.icon}</span>
                  <p className="text-xs leading-5 text-fg">{insight.text}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      <aside className="module-sidebar hidden lg:flex lg:flex-col gap-5">
        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <h2 className="mb-4 font-semibold">Health Summary</h2>
          <div className="space-y-4">
            {HEALTH_SUMMARY.map(({ label, value, sub, color }) => (
              <div key={label} className="flex items-center justify-between">
                <div><p className="text-sm font-semibold">{label}</p><p className="text-xs text-muted">{sub}</p></div>
                <span className={cn('text-lg font-black', color)}>{value}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <div className="mb-4 flex items-center justify-between"><h2 className="font-semibold">Upcoming Checkups</h2><button className="text-xs font-semibold text-brand">View all &rarr;</button></div>
          <div className="space-y-3">
            {appts.slice(0, 4).map((a, i) => {
              const d = new Date(a.starts_at);
              const member = a.member_id ? memberById.get(a.member_id) : undefined;
              return (
                <div key={a.id} className="flex items-start gap-3">
                  <div className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-lg text-center text-white', ACCENT[i % ACCENT.length])}>
                    <div><p className="text-[9px] font-bold uppercase">{d.toLocaleDateString('en-US', { month: 'short' })}</p><p className="text-sm font-black leading-none">{d.getDate()}</p></div>
                  </div>
                  <div>
                    <p className="text-sm font-semibold">{a.title}</p>
                    {member && <p className="text-xs text-muted">{member.display_name}</p>}
                    {a.notes && <p className="text-xs text-muted/60">{a.notes}</p>}
                  </div>
                </div>
              );
            })}
          </div>
          <button onClick={() => setOpen(true)} className="mt-4 flex w-full items-center justify-center gap-1.5 rounded-xl border border-border py-2.5 text-xs font-semibold text-muted hover:text-fg">
            <Plus className="h-3.5 w-3.5" /> Add Checkup
          </button>
        </div>
        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <div className="mb-4 flex items-center justify-between"><h2 className="font-semibold">Health Reminders</h2><button className="text-xs font-semibold text-brand">View all &rarr;</button></div>
          <div className="space-y-3">
            {(reminders.length > 0
              ? reminders.map((r) => ({ title: r.title, notes: r.notes }))
              : REMINDERS_FALLBACK
            ).slice(0, 4).map((r) => (
              <div key={r.title} className="flex items-start gap-3">
                <div className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border-2 border-border" />
                <div><p className="text-sm font-semibold">{r.title}</p>{r.notes && <p className="text-xs text-muted">{r.notes}</p>}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="rounded-2xl border border-brand/25 bg-gradient-to-br from-violet-600/10 to-blue-900/10 p-5 text-center">
          <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-full bg-brand/15"><Sparkles className="h-6 w-6 text-brand" /></div>
          <h3 className="font-bold">AI Health Coach</h3>
          <p className="mt-2 text-xs leading-5 text-muted">Get personalized health tips and wellness insights for your family.</p>
          <Button onClick={() => {}} className="btn-cta mt-4 w-full">Ask AI</Button>
        </div>
      </aside>
      <Modal open={open} title="Add Appointment" onClose={() => setOpen(false)}>
        <div className="space-y-4">
          <Field label="Title">{(id) => <Input id={id} value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} placeholder="e.g. Annual Physical - Emma" />}</Field>
          <Field label="Member">{(id) => <Select id={id} value={form.member_id} onChange={(e) => setForm((f) => ({ ...f, member_id: e.target.value }))}><option value="">All</option>{members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</Select>}</Field>
          <Field label="Date & Time">{(id) => <Input id={id} type="datetime-local" value={form.starts_at} onChange={(e) => setForm((f) => ({ ...f, starts_at: e.target.value }))} />}</Field>
          <Field label="Notes (Provider, Location)">{(id) => <Input id={id} value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} placeholder="e.g. Dr. Martinez · Oak Medical" />}</Field>
          <Button onClick={save} disabled={saving || !form.title || !form.starts_at} loading={saving} className="w-full">{saving ? 'Saving...' : 'Add Appointment'}</Button>
        </div>
      </Modal>
    </div>
  );
}
