'use client';

import { useMemo, useState } from 'react';
import { Calendar, ChevronRight, MoreHorizontal, Plus, Sparkles, Trophy, Users, Zap } from 'lucide-react';
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
import type { Tables, GameResult } from '@/lib/database.types';

type SportsEvent = Tables<'sports_events'>;
type Team = Tables<'teams'>;
type GameResultRow = Tables<'game_results'>;

const TABS = ['Overview', 'Teams', 'Schedule', 'Standings', 'Messages', 'Resources'] as const;
type Tab = (typeof TABS)[number];
const EVENT_TYPES = ['game', 'practice', 'tournament', 'scrimmage', 'meeting', 'tryout', 'camp', 'other'];
const SPORT_EMOJIS: Record<string, string> = { Soccer: '⚽', Basketball: '🏀', Baseball: '⚾', Softball: '🥎', Football: '🏈', Tennis: '🎾', Swimming: '🏊', Track: '🏃', Volleyball: '🏐', Gymnastics: '🤸', Hockey: '🏒', Lacrosse: '🥍', Wrestling: '🤼', Golf: '⛳', default: '🏆' };
const RESULT_OPTIONS = ['win', 'loss', 'tie'] as const;

export function SportsModule() {
  const { familyId, userId, members } = useApp();
  const { success, error: toastError } = useToast();
  const [tab, setTab] = useState<Tab>('Overview');

  // --- Modal state ---
  const [eventOpen, setEventOpen] = useState(false);
  const [teamOpen, setTeamOpen] = useState(false);
  const [gameOpen, setGameOpen] = useState(false);

  const [eventForm, setEventForm] = useState({ title: '', event_type: 'game', sport: '', team: '', starts_at: '', location: '', notes: '', member_id: '' });
  const [teamForm, setTeamForm] = useState({ sport: '', team_name: '', season: '', coach: '', member_id: '' });
  const [gameForm, setGameForm] = useState({ team_id: '', opponent: '', our_score: '', their_score: '', date: '', result: 'win' as string, notes: '' });
  const [saving, setSaving] = useState(false);

  // --- Date helpers ---
  const now = useMemo(() => new Date().toISOString(), []);
  const monthStart = useMemo(() => { const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d.toISOString(); }, []);
  const monthEnd = useMemo(() => { const d = new Date(); d.setMonth(d.getMonth() + 1, 0); d.setHours(23, 59, 59, 999); return d.toISOString(); }, []);

  // --- Realtime queries ---
  const { data: events, loading: eventsLoading, error: eventsError, refresh: refreshEvents } = useRealtimeQuery<SportsEvent>({
    table: 'sports_events', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('sports_events').select('*').eq('family_id', familyId).order('starts_at'),
  });

  const { data: teams, loading: teamsLoading, error: teamsError, refresh: refreshTeams } = useRealtimeQuery<Team>({
    table: 'teams', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('teams').select('*').eq('family_id', familyId).order('created_at', { ascending: false }),
  });

  const { data: gameResults, loading: gamesLoading, error: gamesError, refresh: refreshGames } = useRealtimeQuery<GameResultRow>({
    table: 'game_results', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('game_results').select('*').eq('family_id', familyId).order('date', { ascending: false }),
  });

  // --- Lookups ---
  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  const teamById = useMemo(() => new Map(teams.map((t) => [t.id, t])), [teams]);
  const activeTeams = useMemo(() => teams.filter((t) => t.is_active), [teams]);

  // --- Derived data ---
  const upcoming = useMemo(() => events.filter((e) => e.starts_at >= now).slice(0, 5), [events, now]);
  const upcomingGames = useMemo(() => events.filter((e) => e.starts_at >= now && (e.event_type === 'game' || e.event_type === 'tournament')).slice(0, 3), [events, now]);
  const gamesThisMonth = useMemo(() => gameResults.filter((g) => g.date >= monthStart && g.date <= monthEnd), [gameResults, monthStart, monthEnd]);
  const activeSports = useMemo(() => [...new Set(activeTeams.map((t) => t.sport).filter(Boolean))], [activeTeams]);
  const recentResults = useMemo(() => gameResults.slice(0, 5), [gameResults]);

  // --- Standings: group game_results by team_id ---
  const standings = useMemo(() => {
    const map = new Map<string, { wins: number; losses: number; ties: number }>();
    for (const g of gameResults) {
      if (!g.team_id) continue;
      const s = map.get(g.team_id) ?? { wins: 0, losses: 0, ties: 0 };
      if (g.result === 'win') s.wins++;
      else if (g.result === 'loss') s.losses++;
      else if (g.result === 'tie') s.ties++;
      map.set(g.team_id, s);
    }
    return Array.from(map.entries())
      .map(([teamId, s]) => {
        const total = s.wins + s.losses + s.ties;
        const pct = total > 0 ? s.wins / total : 0;
        const team = teamById.get(teamId);
        return { teamId, teamName: team?.team_name ?? 'Unknown', sport: team?.sport ?? '', ...s, pct };
      })
      .sort((a, b) => b.pct - a.pct);
  }, [gameResults, teamById]);

  // --- CRUD ---
  async function saveEvent() {
    if (!eventForm.title || !eventForm.starts_at) return;
    setSaving(true);
    const sb = createClient();
    const { error: err } = await sb.from('sports_events').insert({
      family_id: familyId, title: eventForm.title, event_type: eventForm.event_type || null,
      sport: eventForm.sport || null, team: eventForm.team || null,
      starts_at: new Date(eventForm.starts_at).toISOString(), location: eventForm.location || null,
      created_by: userId, member_id: eventForm.member_id || null,
    });
    setSaving(false);
    if (err) { toastError('Failed to save event'); return; }
    success('Event added!');
    setEventOpen(false);
    setEventForm({ title: '', event_type: 'game', sport: '', team: '', starts_at: '', location: '', notes: '', member_id: '' });
    refreshEvents();
  }

  async function saveTeam() {
    if (!teamForm.team_name || !teamForm.sport) return;
    setSaving(true);
    const sb = createClient();
    const { error: err } = await sb.from('teams').insert({
      family_id: familyId, sport: teamForm.sport, team_name: teamForm.team_name,
      season: teamForm.season || null, coach: teamForm.coach || null,
      member_id: teamForm.member_id || null, is_active: true, created_by: userId,
    });
    setSaving(false);
    if (err) { toastError('Failed to add team'); return; }
    success('Team added!');
    setTeamOpen(false);
    setTeamForm({ sport: '', team_name: '', season: '', coach: '', member_id: '' });
    refreshTeams();
  }

  async function saveGameResult() {
    if (!gameForm.team_id || !gameForm.opponent || !gameForm.date) return;
    setSaving(true);
    const sb = createClient();
    const { error: err } = await sb.from('game_results').insert({
      family_id: familyId, team_id: gameForm.team_id, opponent: gameForm.opponent,
      our_score: gameForm.our_score ? Number(gameForm.our_score) : 0,
      their_score: gameForm.their_score ? Number(gameForm.their_score) : 0,
      date: gameForm.date, result: gameForm.result as GameResult, notes: gameForm.notes || null,
      created_by: userId,
    });
    setSaving(false);
    if (err) { toastError('Failed to save result'); return; }
    success('Game result added!');
    setGameOpen(false);
    setGameForm({ team_id: '', opponent: '', our_score: '', their_score: '', date: '', result: 'win', notes: '' });
    refreshGames();
  }

  // --- Loading / Error ---
  const loading = eventsLoading || teamsLoading || gamesLoading;
  const error = eventsError || teamsError || gamesError;
  if (loading) return <SkeletonList />;
  if (error) return <ErrorState message={error} />;

  return (
    <div className="module-with-sidebar">
      <div className="module-main module-page">
        <PageHeader
          title="Sports"
          description="Track games, practices, standings, and team schedules."
          action={<div className="flex items-center gap-2"><AiInsight kind="sports" iconOnly /><Button onClick={() => setEventOpen(true)}><Plus className="h-4 w-4" /> Add Event</Button></div>}
        />

        {/* Tab bar */}
        <div className="flex items-center justify-between border-b border-border">
          <div className="tab-bar">
            {TABS.map((t) => (
              <button key={t} onClick={() => setTab(t)} className={cn('tab-item', tab === t ? 'tab-item-active' : 'tab-item-inactive')}>{t}</button>
            ))}
          </div>
        </div>

        {/* Stats grid */}
        <div className="grid-stats gap-3">
          {[
            { icon: Trophy, label: 'Active Sports', value: activeSports.length, sub: 'This season', bg: 'bg-violet-600/20 text-violet-300' },
            { icon: Calendar, label: 'Upcoming Events', value: upcoming.length, sub: 'Next 14 days', bg: 'bg-blue-600/20 text-blue-300' },
            { icon: Zap, label: 'Games This Month', value: gamesThisMonth.length, sub: 'Across all sports', bg: 'bg-emerald-600/20 text-emerald-300' },
            { icon: Users, label: 'Active Teams', value: activeTeams.length, sub: 'This season', bg: 'bg-orange-600/20 text-orange-300' },
          ].map(({ icon: Icon, label, value, sub, bg }) => (
            <div key={label} className="stat-card">
              <div className={cn('mb-3 grid h-10 w-10 place-items-center rounded-xl', bg)}><Icon className="h-5 w-5" /></div>
              <p className="text-2xl font-black">{value}</p><p className="text-sm font-semibold">{label}</p><p className="text-xs text-muted">{sub}</p>
            </div>
          ))}
        </div>

        {/* Upcoming Events table */}
        <div className="rounded-2xl border border-border bg-surface/40">
          <div className="flex items-center justify-between p-5">
            <h2 className="font-semibold">Upcoming Events</h2>
            <button onClick={() => setTab('Schedule')} className="flex items-center gap-1 text-xs font-semibold text-brand">View full schedule <ChevronRight className="h-3.5 w-3.5" /></button>
          </div>
          {upcoming.length === 0 ? (
            <div className="px-5 pb-5">
              <EmptyState icon={Calendar} title="No upcoming events" description="Add a sports event to get started." action={<Button onClick={() => setEventOpen(true)}><Plus className="h-4 w-4" /> Add Event</Button>} />
            </div>
          ) : (
            <>
              <div className="table-responsive overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="border-t border-border text-xs text-muted">
                    <th className="px-5 py-3 text-left font-medium">Event</th>
                    <th className="px-4 py-3 text-left font-medium">Athlete</th>
                    <th className="px-4 py-3 text-left font-medium">Sport / Team</th>
                    <th className="px-4 py-3 text-left font-medium">Date &amp; Time</th>
                    <th className="px-4 py-3 text-left font-medium">Location</th>
                    <th className="px-4 py-3 text-left font-medium">Type</th>
                    <th className="w-8 px-4 py-3" />
                  </tr></thead>
                  <tbody className="divide-y divide-border">
                    {upcoming.map((e) => {
                      const d = new Date(e.starts_at);
                      const member = e.member_id ? memberById.get(e.member_id) : undefined;
                      const isGame = e.event_type === 'game' || e.event_type === 'tournament';
                      return (
                        <tr key={e.id} className="hover:bg-surface/20">
                          <td className="px-5 py-3.5">
                            <div className="flex items-center gap-3">
                              <span className="text-lg">{SPORT_EMOJIS[e.sport ?? ''] ?? SPORT_EMOJIS.default}</span>
                              <div><p className="font-medium">{e.title}</p>{e.team && <p className="text-xs text-muted">{e.team}</p>}</div>
                            </div>
                          </td>
                          <td className="px-4 py-3.5">
                            {member ? <div className="flex items-center gap-2"><Avatar name={member.display_name} color={member.color} size={28} /><span>{member.display_name.split(' ')[0]}</span></div> : <span className="text-muted/60">&mdash;</span>}
                          </td>
                          <td className="px-4 py-3.5"><span className="text-fg">{e.sport || 'Sports'}</span></td>
                          <td className="px-4 py-3.5">
                            <p className="font-medium">{d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</p>
                            <p className="text-xs text-muted">{d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</p>
                          </td>
                          <td className="px-4 py-3.5 text-muted text-xs">{e.location || '—'}</td>
                          <td className="px-4 py-3.5">
                            <span className={cn('rounded-full px-2.5 py-1 text-xs font-bold', isGame ? 'bg-violet-500/15 text-violet-300 border border-violet-500/25' : 'bg-blue-500/15 text-blue-300 border border-blue-500/25')}>{e.event_type}</span>
                          </td>
                          <td className="px-4 py-3.5"><button className="text-muted/60 hover:text-muted"><MoreHorizontal className="h-4 w-4" /></button></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="border-t border-border p-4 text-center">
                <button onClick={() => setTab('Schedule')} className="mx-auto flex items-center gap-1 text-xs font-semibold text-brand">View full schedule <ChevronRight className="h-3.5 w-3.5" /></button>
              </div>
            </>
          )}
        </div>

        {/* Two-column: My Teams + Recent Results */}
        <div className="grid gap-5 lg:grid-cols-2">
          {/* My Teams */}
          <div className="rounded-2xl border border-border bg-surface/40 p-5">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="font-semibold">My Teams</h2>
              <Button variant="ghost" size="sm" onClick={() => setTeamOpen(true)}><Plus className="h-3.5 w-3.5" /> Add Team</Button>
            </div>
            {activeTeams.length === 0 ? (
              <EmptyState icon={Users} title="No teams yet" description="Add your first team to track rosters and records." action={<Button onClick={() => setTeamOpen(true)}><Plus className="h-4 w-4" /> Add Team</Button>} />
            ) : (
              <div className="space-y-3">
                {activeTeams.map((team) => {
                  const member = team.member_id ? memberById.get(team.member_id) : undefined;
                  const record = standings.find((s) => s.teamId === team.id);
                  const recordStr = record ? `${record.wins}-${record.losses}${record.ties > 0 ? `-${record.ties}` : ''}` : '0-0';
                  return (
                    <div key={team.id} className="flex items-center gap-3 rounded-xl border border-border p-3">
                      <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-surface/40 text-xl">{SPORT_EMOJIS[team.sport ?? ''] ?? SPORT_EMOJIS.default}</div>
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold">{team.team_name}</p>
                        <p className="text-xs text-muted">{team.sport}{member ? ` · ${member.display_name.split(' ')[0]}` : ''}{team.season ? ` · ${team.season}` : ''}</p>
                      </div>
                      <div className="text-right">
                        <p className="text-sm font-bold">{recordStr}</p>
                        {team.coach && <p className="text-xs text-muted">Coach: {team.coach}</p>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Recent Results */}
          <div className="rounded-2xl border border-border bg-surface/40 p-5">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="font-semibold">Recent Results</h2>
              <Button variant="ghost" size="sm" onClick={() => setGameOpen(true)}><Plus className="h-3.5 w-3.5" /> Add Result</Button>
            </div>
            {recentResults.length === 0 ? (
              <EmptyState icon={Trophy} title="No game results" description="Log a game result to start tracking your record." action={<Button onClick={() => setGameOpen(true)}><Plus className="h-4 w-4" /> Add Result</Button>} />
            ) : (
              <div className="space-y-3">
                {recentResults.map((r) => {
                  const team = r.team_id ? teamById.get(r.team_id) : undefined;
                  const isWin = r.result === 'win';
                  const isTie = r.result === 'tie';
                  const label = isWin ? 'W' : isTie ? 'T' : 'L';
                  const scoreStr = r.our_score != null && r.their_score != null ? `${r.our_score}-${r.their_score}` : '—';
                  const d = new Date(r.date);
                  return (
                    <div key={r.id} className="flex items-center gap-3">
                      <div className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-lg text-sm font-black', isWin ? 'bg-emerald-500/20 text-emerald-300' : isTie ? 'bg-yellow-500/20 text-yellow-300' : 'bg-red-500/20 text-red-400')}>{label}</div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold">{team?.team_name ?? 'Unknown'} vs {r.opponent}</p>
                        <p className="text-xs text-muted">{team?.sport ?? 'Sports'} &middot; {d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</p>
                      </div>
                      <p className="text-sm font-bold tabular-nums">{scoreStr}</p>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Sidebar */}
      <aside className="module-sidebar hidden lg:flex lg:flex-col gap-5">
        {/* Upcoming Games */}
        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <div className="mb-4 flex items-center justify-between"><h2 className="font-semibold">Upcoming Games</h2><button onClick={() => setTab('Schedule')} className="text-xs font-semibold text-brand">View schedule &rarr;</button></div>
          {upcomingGames.length === 0 ? (
            <p className="text-sm text-muted">No upcoming games scheduled.</p>
          ) : (
            <div className="space-y-3">
              {upcomingGames.map((e) => {
                const d = new Date(e.starts_at);
                return (
                  <div key={e.id} className="flex items-start gap-3">
                    <div className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-violet-500 text-center text-white">
                      <div><p className="text-[9px] font-bold uppercase">{d.toLocaleDateString('en-US', { month: 'short' })}</p><p className="text-sm font-black leading-none">{d.getDate()}</p></div>
                    </div>
                    <div><p className="text-sm font-semibold">{e.title}</p><p className="text-xs text-muted">{d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</p></div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Team Standings */}
        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <div className="mb-4 flex items-center justify-between"><h2 className="font-semibold">Team Standings</h2><button onClick={() => setTab('Standings')} className="text-xs font-semibold text-brand">View all &rarr;</button></div>
          {standings.length === 0 ? (
            <p className="text-sm text-muted">No standings data yet. Log game results to see standings.</p>
          ) : (
            <table className="w-full text-xs">
              <thead><tr className="text-muted"><th className="pb-2 text-left">#</th><th className="pb-2 text-left">Team</th><th className="pb-2 text-right">W</th><th className="pb-2 text-right">L</th><th className="pb-2 text-right">T</th><th className="pb-2 text-right">PCT</th></tr></thead>
              <tbody className="divide-y divide-border">
                {standings.map((s, i) => (
                  <tr key={s.teamId} className="font-medium">
                    <td className="py-2 text-muted">{i + 1}</td>
                    <td className="py-2">{s.teamName}</td>
                    <td className="py-2 text-right">{s.wins}</td>
                    <td className="py-2 text-right">{s.losses}</td>
                    <td className="py-2 text-right">{s.ties}</td>
                    <td className="py-2 text-right text-muted">{s.pct.toFixed(3)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Quick Actions */}
        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <div className="mb-4 flex items-center justify-between"><h2 className="font-semibold">Quick Actions</h2></div>
          <div className="space-y-2">
            {[
              { label: 'Add a game or event', action: () => setEventOpen(true) },
              { label: 'Add a team', action: () => setTeamOpen(true) },
              { label: 'Log game result', action: () => setGameOpen(true) },
              { label: 'View full schedule', action: () => setTab('Schedule') },
            ].map(({ label, action }) => (
              <button key={label} onClick={action} className="flex w-full items-center justify-between rounded-xl border border-border px-4 py-2.5 text-sm hover:border-border">
                {label} <ChevronRight className="h-3.5 w-3.5 text-muted/60" />
              </button>
            ))}
          </div>
        </div>

        {/* Sports News — empty state */}
        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <div className="mb-4 flex items-center justify-between"><h2 className="font-semibold">Sports News</h2></div>
          <p className="text-sm text-muted">No news yet. Team updates and announcements will appear here.</p>
        </div>

        {/* AI Sports Coach */}
        <div className="rounded-2xl border border-brand/25 bg-gradient-to-br from-violet-600/10 to-blue-900/10 p-5 text-center">
          <div className="mx-auto mb-3 grid h-12 w-12 place-items-center rounded-full bg-brand/15"><Sparkles className="h-6 w-6 text-brand" /></div>
          <h3 className="font-bold">AI Sports Coach</h3>
          <p className="mt-2 text-xs leading-5 text-muted">Get training tips, schedule help, and insights for your athletes.</p>
          <Button className="mt-4 w-full">Ask AI</Button>
        </div>
      </aside>

      {/* Add Event Modal */}
      <Modal open={eventOpen} title="Add Sports Event" onClose={() => setEventOpen(false)}>
        <div className="space-y-4">
          <Field label="Title">{(id) => <Input id={id} value={eventForm.title} onChange={(e) => setEventForm((f) => ({ ...f, title: e.target.value }))} placeholder="e.g. Soccer Game vs Storm FC" />}</Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Type">{(id) => <Select id={id} value={eventForm.event_type} onChange={(e) => setEventForm((f) => ({ ...f, event_type: e.target.value }))}>{EVENT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</Select>}</Field>
            <Field label="Sport">{(id) => <Input id={id} value={eventForm.sport} onChange={(e) => setEventForm((f) => ({ ...f, sport: e.target.value }))} placeholder="e.g. Soccer" />}</Field>
          </div>
          <Field label="Team Name">{(id) => <Input id={id} value={eventForm.team} onChange={(e) => setEventForm((f) => ({ ...f, team: e.target.value }))} placeholder="e.g. Thunder FC" />}</Field>
          <Field label="Athlete">{(id) => <Select id={id} value={eventForm.member_id} onChange={(e) => setEventForm((f) => ({ ...f, member_id: e.target.value }))}><option value="">All</option>{members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</Select>}</Field>
          <Field label="Date &amp; Time">{(id) => <Input id={id} type="datetime-local" value={eventForm.starts_at} onChange={(e) => setEventForm((f) => ({ ...f, starts_at: e.target.value }))} />}</Field>
          <Field label="Location">{(id) => <Input id={id} value={eventForm.location} onChange={(e) => setEventForm((f) => ({ ...f, location: e.target.value }))} placeholder="e.g. Riverside Park Field 3" />}</Field>
          <Button className="w-full" onClick={saveEvent} disabled={saving || !eventForm.title || !eventForm.starts_at}>{saving ? 'Saving…' : 'Add Event'}</Button>
        </div>
      </Modal>

      {/* Add Team Modal */}
      <Modal open={teamOpen} title="Add Team" onClose={() => setTeamOpen(false)}>
        <div className="space-y-4">
          <Field label="Sport">{(id) => <Input id={id} value={teamForm.sport} onChange={(e) => setTeamForm((f) => ({ ...f, sport: e.target.value }))} placeholder="e.g. Soccer" />}</Field>
          <Field label="Team Name">{(id) => <Input id={id} value={teamForm.team_name} onChange={(e) => setTeamForm((f) => ({ ...f, team_name: e.target.value }))} placeholder="e.g. Thunder FC" />}</Field>
          <Field label="Season">{(id) => <Input id={id} value={teamForm.season} onChange={(e) => setTeamForm((f) => ({ ...f, season: e.target.value }))} placeholder="e.g. Spring 2026" />}</Field>
          <Field label="Coach">{(id) => <Input id={id} value={teamForm.coach} onChange={(e) => setTeamForm((f) => ({ ...f, coach: e.target.value }))} placeholder="e.g. Coach Smith" />}</Field>
          <Field label="Athlete">{(id) => <Select id={id} value={teamForm.member_id} onChange={(e) => setTeamForm((f) => ({ ...f, member_id: e.target.value }))}><option value="">Select athlete</option>{members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</Select>}</Field>
          <Button className="w-full" onClick={saveTeam} disabled={saving || !teamForm.sport || !teamForm.team_name}>{saving ? 'Saving…' : 'Add Team'}</Button>
        </div>
      </Modal>

      {/* Add Game Result Modal */}
      <Modal open={gameOpen} title="Log Game Result" onClose={() => setGameOpen(false)}>
        <div className="space-y-4">
          <Field label="Team">{(id) => (
            <Select id={id} value={gameForm.team_id} onChange={(e) => setGameForm((f) => ({ ...f, team_id: e.target.value }))}>
              <option value="">Select team</option>
              {activeTeams.map((t) => <option key={t.id} value={t.id}>{t.team_name} ({t.sport})</option>)}
            </Select>
          )}</Field>
          <Field label="Opponent">{(id) => <Input id={id} value={gameForm.opponent} onChange={(e) => setGameForm((f) => ({ ...f, opponent: e.target.value }))} placeholder="e.g. Storm FC" />}</Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Our Score">{(id) => <Input id={id} type="number" min="0" value={gameForm.our_score} onChange={(e) => setGameForm((f) => ({ ...f, our_score: e.target.value }))} placeholder="0" />}</Field>
            <Field label="Their Score">{(id) => <Input id={id} type="number" min="0" value={gameForm.their_score} onChange={(e) => setGameForm((f) => ({ ...f, their_score: e.target.value }))} placeholder="0" />}</Field>
          </div>
          <Field label="Date">{(id) => <Input id={id} type="date" value={gameForm.date} onChange={(e) => setGameForm((f) => ({ ...f, date: e.target.value }))} />}</Field>
          <Field label="Result">{(id) => (
            <Select id={id} value={gameForm.result} onChange={(e) => setGameForm((f) => ({ ...f, result: e.target.value }))}>
              {RESULT_OPTIONS.map((r) => <option key={r} value={r}>{r.charAt(0).toUpperCase() + r.slice(1)}</option>)}
            </Select>
          )}</Field>
          <Field label="Notes">{(id) => <Input id={id} value={gameForm.notes} onChange={(e) => setGameForm((f) => ({ ...f, notes: e.target.value }))} placeholder="Optional notes" />}</Field>
          <Button className="w-full" onClick={saveGameResult} disabled={saving || !gameForm.team_id || !gameForm.opponent || !gameForm.date}>{saving ? 'Saving…' : 'Log Result'}</Button>
        </div>
      </Modal>
    </div>
  );
}
