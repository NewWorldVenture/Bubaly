'use client';

import { useMemo, useState } from 'react';
import { Calendar, ChevronRight, Filter, MoreHorizontal, Plus, Sparkles, Trophy, Users, Zap } from 'lucide-react';
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

type SportsEvent = Tables<'sports_events'>;
const TABS = ['Overview', 'Teams', 'Schedule', 'Standings', 'Messages', 'Resources'] as const;
type Tab = (typeof TABS)[number];
const EVENT_TYPES = ['game', 'practice', 'tournament', 'scrimmage', 'meeting', 'tryout', 'camp', 'other'];
const SPORT_EMOJIS: Record<string, string> = { Soccer: '⚽', Basketball: '🏀', Baseball: '⚾', Softball: '🥎', Football: '🏈', Tennis: '🎾', Swimming: '🏊', Track: '🏃', Volleyball: '🏐', Gymnastics: '🤸', Hockey: '🏒', Lacrosse: '🥍', Wrestling: '🤼', Golf: '⛳', default: '🏆' };
const SPORT_COLORS = ['bg-violet-500', 'bg-blue-500', 'bg-emerald-500', 'bg-orange-500', 'bg-rose-500'];
const TEAMS_MOCK = [
  { sport: 'Soccer', team: 'Thunder FC', record: '8-2-1', position: '2nd', color: 'bg-violet-500' },
  { sport: 'Basketball', team: 'Eagles', record: '12-4', position: '1st', color: 'bg-blue-500' },
  { sport: 'Swimming', team: 'Wave Riders', record: '6-1', position: '1st', color: 'bg-emerald-500' },
];
const RESULTS_MOCK = [
  { sport: 'Soccer', team: 'Thunder FC', vs: 'Storm FC', result: 'W', score: '3-1', date: 'May 11', sidx: 0 },
  { sport: 'Basketball', team: 'Eagles', vs: 'Hawks', result: 'W', score: '54-48', date: 'May 10', sidx: 1 },
  { sport: 'Soccer', team: 'Thunder FC', vs: 'Blaze', result: 'L', score: '1-2', date: 'May 8', sidx: 0 },
];
const STANDINGS_MOCK = [
  { pos: 1, team: 'Eagles', w: 12, l: 4, pct: '.750', color: 'bg-violet-500' },
  { pos: 2, team: 'Thunder FC', w: 8, l: 2, pct: '.800', color: 'bg-blue-500' },
  { pos: 3, team: 'Wave Riders', w: 6, l: 1, pct: '.857', color: 'bg-emerald-500' },
];
const NEWS_MOCK = [
  { emoji: '⚽', title: 'Thunder FC Advances to Regional Finals', time: '2 hours ago' },
  { emoji: '🏀', title: 'Eagles Win District Championship', time: '1 day ago' },
  { emoji: '🏊', title: 'Wave Riders Set New Team Record', time: '2 days ago' },
];

type FallbackEvent = { id: string; title: string; starts_at: string; event_type: string; sport: string; team: string; location: string; sidx: number };

const FALLBACK_EVENTS: FallbackEvent[] = [
  { id: 'a', title: 'Soccer Game vs Storm FC', starts_at: new Date(Date.now() + 86400000).toISOString(), event_type: 'game', sport: 'Soccer', team: 'Thunder FC', location: 'Riverside Park Field 3', sidx: 0 },
  { id: 'b', title: 'Basketball Practice', starts_at: new Date(Date.now() + 86400000 * 2).toISOString(), event_type: 'practice', sport: 'Basketball', team: 'Eagles', location: 'Lincoln Gym', sidx: 1 },
  { id: 'c', title: 'Swim Meet – District Qualifier', starts_at: new Date(Date.now() + 86400000 * 4).toISOString(), event_type: 'tournament', sport: 'Swimming', team: 'Wave Riders', location: 'Aquatic Center', sidx: 0 },
  { id: 'd', title: 'Soccer Practice', starts_at: new Date(Date.now() + 86400000 * 5).toISOString(), event_type: 'practice', sport: 'Soccer', team: 'Thunder FC', location: 'Training Field', sidx: 0 },
  { id: 'e', title: 'Basketball Game vs Hawks', starts_at: new Date(Date.now() + 86400000 * 7).toISOString(), event_type: 'game', sport: 'Basketball', team: 'Eagles', location: 'Roosevelt High Gym', sidx: 1 },
];

export function SportsModule() {
  const { familyId, userId, members } = useApp();
  const { success, error: toastError } = useToast();
  const [tab, setTab] = useState<Tab>('Overview');
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ title: '', event_type: 'game', sport: '', team: '', starts_at: '', location: '', notes: '', member_id: '' });
  const [saving, setSaving] = useState(false);

  const now = useMemo(() => new Date().toISOString(), []);
  const in30 = useMemo(() => { const d = new Date(); d.setDate(d.getDate() + 30); return d.toISOString(); }, []);

  const { data: events, loading, error, refresh } = useRealtimeQuery<SportsEvent>({
    table: 'sports_events', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('sports_events').select('*').eq('family_id', familyId).order('starts_at'),
  });

  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  const upcoming = useMemo(() => events.filter((e) => e.starts_at >= now).slice(0, 5), [events, now]);
  const thisMonth = useMemo(() => events.filter((e) => e.starts_at >= now && e.starts_at <= in30), [events, now, in30]);
  const sports = useMemo(() => [...new Set(events.map((e) => e.sport).filter(Boolean))], [events]);

  async function save() {
    if (!form.title || !form.starts_at) return; setSaving(true);
    const sb = createClient();
    const { error: err } = await sb.from('sports_events').insert({ family_id: familyId, title: form.title, event_type: form.event_type || null, sport: form.sport || null, team: form.team || null, starts_at: new Date(form.starts_at).toISOString(), location: form.location || null, created_by: userId, member_id: form.member_id || null });
    setSaving(false);
    if (err) { toastError('Failed to save'); return; }
    success('Event added!'); setOpen(false); setForm({ title: '', event_type: 'game', sport: '', team: '', starts_at: '', location: '', notes: '', member_id: '' }); refresh();
  }

  if (loading) return <LoadingBlock />;
  if (error) return <ErrorState message={error} />;

  // Use real upcoming events or fallback display objects
  type DisplayRow = { id: string; title: string; starts_at: string; event_type: string; sport: string; team: string; location: string; member_id: string | null };
  const rows: DisplayRow[] = upcoming.length > 0
    ? upcoming.map((e) => ({ id: e.id, title: e.title, starts_at: e.starts_at, event_type: e.event_type ?? 'game', sport: e.sport ?? '', team: e.team ?? '', location: e.location ?? '', member_id: e.member_id }))
    : FALLBACK_EVENTS.map((f) => ({ ...f, member_id: members[f.sidx % Math.max(members.length, 1)]?.id ?? null }));

  return (
    <div className="flex gap-6 xl:gap-8">
      <div className="min-w-0 flex-1 space-y-5">
        <div className="flex items-start justify-between">
          <div><h1 className="text-2xl font-bold">Sports</h1><p className="mt-1 text-sm text-white/55">Track games, practices, standings, and team schedules.</p></div>
          <button onClick={() => setOpen(true)} className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-blue-500 to-violet-600 px-4 py-2.5 text-sm font-bold shadow-glow"><Plus className="h-4 w-4" /> Add Event</button>
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
            { icon: Trophy, label: 'Active Sports', value: Math.max(sports.length, TEAMS_MOCK.length), sub: 'This season', bg: 'bg-violet-600/20 text-violet-300' },
            { icon: Calendar, label: 'Upcoming Events', value: Math.max(upcoming.length, FALLBACK_EVENTS.length), sub: 'Next 14 days', bg: 'bg-blue-600/20 text-blue-300' },
            { icon: Zap, label: 'Games This Month', value: Math.max(thisMonth.filter((e) => e.event_type === 'game').length, 8), sub: 'Across all sports', bg: 'bg-emerald-600/20 text-emerald-300' },
            { icon: Users, label: 'Team Expenses', value: '$342', sub: 'This season', bg: 'bg-orange-600/20 text-orange-300' },
          ].map(({ icon: Icon, label, value, sub, bg }) => (
            <div key={label} className="rounded-2xl border border-white/8 bg-white/[0.03] p-4">
              <div className={cn('mb-3 grid h-10 w-10 place-items-center rounded-xl', bg)}><Icon className="h-5 w-5" /></div>
              <p className="text-2xl font-black">{value}</p><p className="text-sm font-semibold">{label}</p><p className="text-xs text-white/40">{sub}</p>
            </div>
          ))}
        </div>
        <div className="rounded-2xl border border-white/8 bg-white/[0.03]">
          <div className="flex items-center justify-between p-5">
            <h2 className="font-semibold">Upcoming Events</h2>
            <button className="flex items-center gap-1 text-xs font-semibold text-violet-300">View full schedule <ChevronRight className="h-3.5 w-3.5" /></button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-t border-white/8 text-xs text-white/40">
                <th className="px-5 py-3 text-left font-medium">Event</th>
                <th className="px-4 py-3 text-left font-medium">Athlete</th>
                <th className="px-4 py-3 text-left font-medium">Sport / Team</th>
                <th className="px-4 py-3 text-left font-medium">Date & Time</th>
                <th className="px-4 py-3 text-left font-medium">Location</th>
                <th className="px-4 py-3 text-left font-medium">Type</th>
                <th className="w-8 px-4 py-3" />
              </tr></thead>
              <tbody className="divide-y divide-white/5">
                {rows.map((e, i) => {
                  const d = new Date(e.starts_at);
                  const member = e.member_id ? memberById.get(e.member_id) : undefined;
                  const isGame = e.event_type === 'game' || e.event_type === 'tournament';
                  return (
                    <tr key={e.id} className="hover:bg-white/[0.02]">
                      <td className="px-5 py-3.5">
                        <div className="flex items-center gap-3">
                          <span className="text-lg">{SPORT_EMOJIS[e.sport] ?? '🏆'}</span>
                          <div><p className="font-medium">{e.title}</p>{e.team && <p className="text-xs text-white/40">{e.team}</p>}</div>
                        </div>
                      </td>
                      <td className="px-4 py-3.5">
                        {member ? <div className="flex items-center gap-2"><Avatar name={member.display_name} color={member.color} size={28} /><span>{member.display_name.split(' ')[0]}</span></div> : <span className="text-white/30">—</span>}
                      </td>
                      <td className="px-4 py-3.5">
                        <div className="flex items-center gap-2">
                          <div className={cn('h-2.5 w-2.5 rounded-full', SPORT_COLORS[i % SPORT_COLORS.length])} />
                          <span className="text-white/70">{e.sport || 'Sports'}</span>
                        </div>
                      </td>
                      <td className="px-4 py-3.5">
                        <p className="font-medium">{d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</p>
                        <p className="text-xs text-white/40">{d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</p>
                      </td>
                      <td className="px-4 py-3.5 text-white/60 text-xs">{e.location || '—'}</td>
                      <td className="px-4 py-3.5">
                        <span className={cn('rounded-full px-2.5 py-1 text-xs font-bold', isGame ? 'bg-violet-500/15 text-violet-300 border border-violet-500/25' : 'bg-blue-500/15 text-blue-300 border border-blue-500/25')}>{e.event_type}</span>
                      </td>
                      <td className="px-4 py-3.5"><button className="text-white/25 hover:text-white/60"><MoreHorizontal className="h-4 w-4" /></button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="border-t border-white/8 p-4 text-center">
            <button className="mx-auto flex items-center gap-1 text-xs font-semibold text-violet-300">View full schedule <ChevronRight className="h-3.5 w-3.5" /></button>
          </div>
        </div>
        <div className="grid gap-5 lg:grid-cols-2">
          <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-5">
            <div className="mb-4 flex items-center justify-between"><h2 className="font-semibold">My Teams</h2><button className="text-xs font-semibold text-violet-300">View all →</button></div>
            <div className="space-y-3">
              {TEAMS_MOCK.map((team, i) => (
                <div key={team.team} className="flex items-center gap-3 rounded-xl border border-white/8 p-3">
                  <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-white/[0.04] text-xl">{SPORT_EMOJIS[team.sport] ?? '🏆'}</div>
                  <div className="flex-1 min-w-0">
                    <p className="font-semibold">{team.team}</p>
                    <p className="text-xs text-white/45">{team.sport} · {members[i % Math.max(members.length, 1)]?.display_name.split(' ')[0] ?? 'Family'}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-bold">{team.record}</p>
                    <p className="text-xs text-white/40">{team.position} Place</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-5">
            <div className="mb-4 flex items-center justify-between"><h2 className="font-semibold">Recent Results</h2><button className="text-xs font-semibold text-violet-300">View all →</button></div>
            <div className="space-y-3">
              {RESULTS_MOCK.map((r, i) => (
                <div key={i} className="flex items-center gap-3">
                  <div className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-lg text-sm font-black', r.result === 'W' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-red-500/20 text-red-400')}>{r.result}</div>
                  <div className="flex-1 min-w-0"><p className="text-sm font-semibold">{r.team} vs {r.vs}</p><p className="text-xs text-white/45">{r.sport} · {r.date}</p></div>
                  <p className="text-sm font-bold tabular-nums">{r.score}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      <aside className="hidden w-72 shrink-0 space-y-5 xl:block">
        <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-5">
          <div className="mb-4 flex items-center justify-between"><h2 className="font-semibold">Upcoming Games</h2><button className="text-xs font-semibold text-violet-300">View schedule →</button></div>
          <div className="space-y-3">
            {rows.filter((e) => e.event_type === 'game' || e.event_type === 'tournament').slice(0, 3).map((e, i) => {
              const d = new Date(e.starts_at);
              return (
                <div key={e.id} className="flex items-start gap-3">
                  <div className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-lg text-center text-white', SPORT_COLORS[i % SPORT_COLORS.length])}>
                    <div><p className="text-[9px] font-bold uppercase">{d.toLocaleDateString('en-US', { month: 'short' })}</p><p className="text-sm font-black leading-none">{d.getDate()}</p></div>
                  </div>
                  <div><p className="text-sm font-semibold">{e.title}</p><p className="text-xs text-white/45">{d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</p></div>
                </div>
              );
            })}
          </div>
        </div>
        <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-5">
          <div className="mb-4 flex items-center justify-between"><h2 className="font-semibold">Team Standings</h2><button className="text-xs font-semibold text-violet-300">View all →</button></div>
          <table className="w-full text-xs">
            <thead><tr className="text-white/40"><th className="pb-2 text-left">#</th><th className="pb-2 text-left">Team</th><th className="pb-2 text-right">W</th><th className="pb-2 text-right">L</th><th className="pb-2 text-right">PCT</th></tr></thead>
            <tbody className="divide-y divide-white/5">
              {STANDINGS_MOCK.map((s) => (
                <tr key={s.team} className="font-medium">
                  <td className="py-2 text-white/40">{s.pos}</td>
                  <td className="py-2"><div className="flex items-center gap-2"><div className={cn('h-2 w-2 rounded-full', s.color)} />{s.team}</div></td>
                  <td className="py-2 text-right">{s.w}</td>
                  <td className="py-2 text-right">{s.l}</td>
                  <td className="py-2 text-right text-white/60">{s.pct}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-5">
          <div className="mb-4 flex items-center justify-between"><h2 className="font-semibold">Quick Actions</h2></div>
          <div className="space-y-2">
            {['Add a game or event', 'View full schedule', 'Message a coach', 'Track team expenses'].map((action) => (
              <button key={action} onClick={action === 'Add a game or event' ? () => setOpen(true) : undefined} className="flex w-full items-center justify-between rounded-xl border border-white/8 px-4 py-2.5 text-sm hover:border-white/15">
                {action} <ChevronRight className="h-3.5 w-3.5 text-white/30" />
              </button>
            ))}
          </div>
        </div>
        <div className="rounded-2xl border border-white/8 bg-white/[0.03] p-5">
          <div className="mb-4 flex items-center justify-between"><h2 className="font-semibold">Sports News</h2></div>
          <div className="space-y-3">
            {NEWS_MOCK.map((n) => (
              <div key={n.title} className="flex gap-3">
                <span className="text-xl">{n.emoji}</span>
                <div><p className="text-sm font-semibold leading-snug">{n.title}</p><p className="mt-0.5 text-xs text-white/35">{n.time}</p></div>
              </div>
            ))}
          </div>
        </div>
        <div className="rounded-2xl border border-violet-400/25 bg-gradient-to-br from-violet-600/10 to-blue-900/10 p-5 text-center">
          <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-full bg-violet-600/20"><Sparkles className="h-6 w-6 text-violet-300" /></div>
          <h3 className="font-bold">AI Sports Coach</h3>
          <p className="mt-2 text-xs leading-5 text-white/55">Get training tips, schedule help, and insights for your athletes.</p>
          <button className="mt-4 w-full rounded-xl bg-gradient-to-r from-blue-500 to-violet-600 py-2.5 text-sm font-bold shadow-glow">Ask AI</button>
        </div>
      </aside>
      <Modal open={open} title="Add Sports Event" onClose={() => setOpen(false)}>
        <div className="space-y-4">
          <Field label="Title">{(id) => <Input id={id} value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} placeholder="e.g. Soccer Game vs Storm FC" />}</Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Type">{(id) => <Select id={id} value={form.event_type} onChange={(e) => setForm((f) => ({ ...f, event_type: e.target.value }))}>{EVENT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</Select>}</Field>
            <Field label="Sport">{(id) => <Input id={id} value={form.sport} onChange={(e) => setForm((f) => ({ ...f, sport: e.target.value }))} placeholder="e.g. Soccer" />}</Field>
          </div>
          <Field label="Team Name">{(id) => <Input id={id} value={form.team} onChange={(e) => setForm((f) => ({ ...f, team: e.target.value }))} placeholder="e.g. Thunder FC" />}</Field>
          <Field label="Athlete">{(id) => <Select id={id} value={form.member_id} onChange={(e) => setForm((f) => ({ ...f, member_id: e.target.value }))}><option value="">All</option>{members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</Select>}</Field>
          <Field label="Date & Time">{(id) => <Input id={id} type="datetime-local" value={form.starts_at} onChange={(e) => setForm((f) => ({ ...f, starts_at: e.target.value }))} />}</Field>
          <Field label="Location">{(id) => <Input id={id} value={form.location} onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))} placeholder="e.g. Riverside Park Field 3" />}</Field>
          <button onClick={save} disabled={saving || !form.title || !form.starts_at} className="w-full rounded-xl bg-gradient-to-r from-blue-500 to-violet-600 py-3 text-sm font-bold disabled:opacity-40">{saving ? 'Saving…' : 'Add Event'}</button>
        </div>
      </Modal>
    </div>
  );
}