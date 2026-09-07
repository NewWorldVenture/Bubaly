'use client';

import { useMemo, useState } from 'react';
import { Sparkle, Plus, Timer, Flame, Check, SkipForward, Trash2, Pencil, RotateCcw, CalendarDays, Boxes, Archive, Wand2, ChevronUp, ChevronDown } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/app/page-header';
import { AiInsight } from '@/components/ai/ai-insight';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Input, Field, Select, Textarea } from '@/components/ui/input';
import { SkeletonList, ErrorState, EmptyState } from '@/components/ui/states';
import { cn } from '@/lib/utils/cn';
import type { Tables, DeclutterZoneKind } from '@/lib/database.types';
import {
  ZONE_KINDS, SCORE_LABELS, zoneKindMeta, zoneHealth, missionsForZone, weeklyPlan, declutterSummary, missionPoints, isoDate, dayDiff,
} from '@/lib/declutter/missions';
import { useTranslations } from '@/components/i18n/locale-provider';

type Zone = Tables<'declutter_zones'>;
type Mission = Tables<'declutter_missions'>;
type Session = Tables<'declutter_sessions'>;

const fmtDate = (d: string) => new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
const HEALTH_STYLE = {
  fresh: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200',
  due: 'border-amber-500/30 bg-amber-500/10 text-amber-200',
  overdue: 'border-rose-500/30 bg-rose-500/10 text-rose-200',
  never: 'border-border bg-surface/60 text-muted',
} as const;
const HEALTH_LABEL = { fresh: 'Fresh', due: 'Due for a reset', overdue: 'Overdue', never: 'Never reset' } as const;

export function DeclutterModule() {
  const tr = useTranslations();
  const { familyId, userId, members, selfMember } = useApp();
  const { success, error: toastError } = useToast();

  const zones = useRealtimeQuery<Zone>({
    table: 'declutter_zones', familyId,
    fetcher: (s) => s.from('declutter_zones').select('*').eq('family_id', familyId).order('clutter_score', { ascending: false }).order('name'),
    deps: [familyId],
  });
  const missions = useRealtimeQuery<Mission>({
    table: 'declutter_missions', familyId,
    fetcher: (s) => s.from('declutter_missions').select('*').eq('family_id', familyId).order('scheduled_for', { ascending: true, nullsFirst: false }).limit(400),
    deps: [familyId],
  });
  const sessions = useRealtimeQuery<Session>({
    table: 'declutter_sessions', familyId,
    fetcher: (s) => s.from('declutter_sessions').select('*').eq('family_id', familyId).order('started_at', { ascending: false }).limit(200),
    deps: [familyId],
  });

  const [zoneForm, setZoneForm] = useState<{ open: boolean; zone: Zone | null }>({ open: false, zone: null });
  const [missionForm, setMissionForm] = useState<{ open: boolean; mission: Mission | null; zoneId?: string; preset?: { title: string; minutes: number; points: number } }>({ open: false, mission: null });
  const [completing, setCompleting] = useState<Mission | null>(null);
  const [sessionOpen, setSessionOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [planning, setPlanning] = useState(false);

  const today = useMemo(() => new Date(), []);
  const todayIso = isoDate(today);
  const activeZones = useMemo(() => zones.data.filter((z) => z.is_active), [zones.data]);
  const summary = useMemo(() => declutterSummary(zones.data, missions.data, sessions.data, today), [zones.data, missions.data, sessions.data, today]);
  const plan = useMemo(() => weeklyPlan(zones.data, missions.data, members.map((m) => m.id), today), [zones.data, missions.data, members, today]);
  const nameOf = (id: string | null) => members.find((m) => m.id === id)?.display_name ?? null;
  const zoneOf = (id: string | null) => zones.data.find((z) => z.id === id) ?? null;

  const open = missions.data.filter((m) => m.status === 'planned');
  const groups = {
    today: open.filter((m) => m.scheduled_for && m.scheduled_for <= todayIso),
    week: open.filter((m) => m.scheduled_for && m.scheduled_for > todayIso && dayDiff(todayIso, m.scheduled_for) <= 7),
    later: open.filter((m) => !m.scheduled_for || dayDiff(todayIso, m.scheduled_for) > 7),
  };
  const recentDone = missions.data.filter((m) => m.status !== 'planned').sort((a, b) => (b.completed_at ?? b.updated_at).localeCompare(a.completed_at ?? a.updated_at)).slice(0, 8);

  async function planWeek() {
    if (!plan.length) return toastError('Every zone already has a mission this week, or nothing needs one. Bump a clutter score to plan more.');
    setPlanning(true);
    const { error } = await createClient().from('declutter_missions').insert(plan.map((p) => ({
      family_id: familyId, zone_id: p.zone.id, title: p.template.title, minutes: p.template.minutes, points: p.template.points,
      assignee_id: p.assigneeId, scheduled_for: p.day, status: 'planned' as const, created_by: userId,
    })));
    setPlanning(false);
    if (error) return toastError(describeDbError(error));
    success(`${plan.length} mission${plan.length === 1 ? '' : 's'} planned for the week`);
  }

  async function skipMission(m: Mission) {
    const { error } = await createClient().from('declutter_missions').update({ status: 'skipped' }).eq('id', m.id);
    if (error) return toastError(describeDbError(error));
    success('Mission skipped');
  }

  async function reopenMission(m: Mission) {
    const { error } = await createClient().from('declutter_missions').update({ status: 'planned', completed_at: null }).eq('id', m.id);
    if (error) return toastError(describeDbError(error));
    success('Mission back on the list');
  }

  async function deleteMission(m: Mission) {
    if (!confirm(`Delete “${m.title}”?`)) return;
    const { error } = await createClient().from('declutter_missions').delete().eq('id', m.id);
    if (error) return toastError(describeDbError(error));
    success('Mission deleted');
  }

  async function resetZone(z: Zone) {
    const { error } = await createClient().from('declutter_zones').update({ clutter_score: 1, last_reset_at: new Date().toISOString() }).eq('id', z.id);
    if (error) return toastError(describeDbError(error));
    success(`${z.name} reset to tidy`);
  }

  async function bumpScore(z: Zone, delta: 1 | -1) {
    const next = Math.min(5, Math.max(1, z.clutter_score + delta));
    if (next === z.clutter_score) return;
    const { error } = await createClient().from('declutter_zones').update({ clutter_score: next }).eq('id', z.id);
    if (error) return toastError(describeDbError(error));
  }

  async function archiveZone(z: Zone, active: boolean) {
    const { error } = await createClient().from('declutter_zones').update({ is_active: active }).eq('id', z.id);
    if (error) return toastError(describeDbError(error));
    success(active ? `${z.name} restored` : `${z.name} archived`);
  }

  const loading = zones.loading || missions.loading || sessions.loading;
  const error = zones.error || missions.error || sessions.error;
  const refresh = () => { void zones.refresh(); void missions.refresh(); void sessions.refresh(); };
  if (loading) return <SkeletonList />;
  if (error) return <ErrorState message={tr('declutterModule.couldNotLoadYourDeclutter')} onRetry={refresh} />;

  const MissionRow = ({ m }: { m: Mission }) => {
  const tr = useTranslations();
    const z = zoneOf(m.zone_id);
    const overdue = m.status === 'planned' && m.scheduled_for && m.scheduled_for < todayIso;
    return (
      <li className="flex items-center gap-3 rounded-xl border border-border bg-surface/60 px-3 py-2">
        <span className="text-lg" aria-hidden>{z ? zoneKindMeta(z.kind).emoji : '📦'}</span>
        <div className="min-w-0 flex-1">
          <p className={cn('truncate text-sm font-medium', m.status === 'done' && 'text-muted line-through')}>{m.title}</p>
          <p className="text-xs text-muted">
            {z ? `${z.name}${z.room ? ` · ${z.room}` : ''}` : 'No zone'} · {m.minutes} {tr('declutter.min')} {m.points} pts
            {m.assignee_id ? ` · ${nameOf(m.assignee_id) ?? 'someone'}` : ''}
            {m.scheduled_for ? <span className={cn(overdue && 'text-amber-300')}> · {overdue ? 'overdue, ' : ''}{fmtDate(m.scheduled_for)}</span> : null}
            {m.status === 'done' ? ` · ${m.items_removed} removed, +${missionPoints(m)} pts` : m.status === 'skipped' ? ' · skipped' : ''}
          </p>
        </div>
        {m.status === 'planned' ? (
          <div className="flex shrink-0 items-center gap-1">
            <Button size="sm" onClick={() => setCompleting(m)}><Check className="h-3.5 w-3.5" /> {tr('declutter.done')}</Button>
            <button onClick={() => skipMission(m)} aria-label={`Skip ${m.title}`} className="rounded-lg p-1.5 text-muted hover:text-fg"><SkipForward className="h-4 w-4" /></button>
            <button onClick={() => setMissionForm({ open: true, mission: m })} aria-label={`Edit ${m.title}`} className="rounded-lg p-1.5 text-muted hover:text-fg"><Pencil className="h-4 w-4" /></button>
            <button onClick={() => deleteMission(m)} aria-label={`Delete ${m.title}`} className="rounded-lg p-1.5 text-muted hover:text-rose-400"><Trash2 className="h-4 w-4" /></button>
          </div>
        ) : (
          <button onClick={() => reopenMission(m)} className="shrink-0 text-xs text-muted hover:text-fg">{tr('declutter.reopen')}</button>
        )}
      </li>
    );
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title={tr('declutter.declutterMissions')}
        description={tr('declutterModule.cleanTheHouseBecomes10')}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <AiInsight kind="declutter" iconOnly />
            <Button variant="secondary" onClick={() => setSessionOpen(true)}><Timer className="h-4 w-4" /> {tr('declutter.logASession')}</Button>
            <Button variant="secondary" onClick={() => setZoneForm({ open: true, zone: null })}><Plus className="h-4 w-4" /> {tr('declutter.zone')}</Button>
            <Button onClick={planWeek} loading={planning} disabled={!activeZones.length}><Wand2 className="h-4 w-4" /> {tr('declutter.planThisWeek')}{plan.length ? ` (${plan.length})` : ''}</Button>
          </div>
        }
      />

      {/* Summary */}
      <div className="grid gap-4 md:grid-cols-4">
        <div className={cn('rounded-2xl border p-5', summary.avgScore !== null && summary.avgScore >= 3.5 ? 'border-rose-500/30 bg-rose-500/10' : summary.avgScore !== null && summary.avgScore <= 1.5 ? 'border-emerald-500/30 bg-emerald-500/10' : 'border-border bg-surface/40')}>
          <div className="flex items-center gap-2 text-sm font-semibold"><Sparkle className="h-4 w-4 text-brand-text" /> {tr('declutter.homeRightNow')}</div>
          <p className="mt-2 text-lg font-bold">{summary.text}</p>
          <p className="mt-1 text-xs text-muted">{summary.worst ? `Worst spot: ${summary.worst.name} (${SCORE_LABELS[summary.worst.clutter_score]})` : 'Add the spots that get messy'}</p>
        </div>
        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <div className="flex items-center gap-2 text-sm font-semibold"><CalendarDays className="h-4 w-4 text-brand-text" /> {tr('declutter.thisWeek')}</div>
          <p className="mt-2 text-2xl font-bold">{summary.doneThisWeek}<span className="text-sm font-normal text-muted"> done</span></p>
          <p className="mt-1 text-xs text-muted">{groups.today.length} {tr('declutter.dueToday')} {groups.week.length} {tr('declutter.laterThisWeek')}</p>
        </div>
        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <div className="flex items-center gap-2 text-sm font-semibold"><Boxes className="h-4 w-4 text-brand-text" /> {tr('declutter.goneThisMonth')}</div>
          <p className="mt-2 text-2xl font-bold">{summary.itemsRemovedMonth}<span className="text-sm font-normal text-muted"> items</span></p>
          <p className="mt-1 text-xs text-muted">{summary.minutesMonth} {tr('declutter.minutesOfSessions')}</p>
        </div>
        <div className={cn('rounded-2xl border p-5', summary.streak >= 3 ? 'border-amber-500/30 bg-amber-500/10' : 'border-border bg-surface/40')}>
          <div className="flex items-center gap-2 text-sm font-semibold"><Flame className="h-4 w-4 text-brand-text" /> {tr('declutter.streak')}</div>
          <p className="mt-2 text-2xl font-bold">{summary.streak}<span className="text-sm font-normal text-muted"> day{summary.streak === 1 ? '' : 's'}</span></p>
          <p className="mt-1 text-xs text-muted">{summary.streak ? 'A session today keeps it alive' : 'Log a session to start one'}</p>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        {/* Zones */}
        <div className="space-y-3 lg:col-span-2">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">{tr('declutter.zones')}</h2>
            {zones.data.some((z) => !z.is_active) && <button onClick={() => setShowArchived((v) => !v)} className="text-xs text-muted hover:text-fg">{showArchived ? 'Hide' : 'Show'} archived</button>}
          </div>
          {activeZones.length === 0 ? (
            <EmptyState icon={Sparkle} title={tr('declutter.noZonesYet')} description={tr('declutterModule.aZoneIsAnySpot')} action={<Button onClick={() => setZoneForm({ open: true, zone: null })}><Plus className="h-4 w-4" /> {tr('declutter.addAZone')}</Button>} />
          ) : (
            <ul className="space-y-2">
              {(showArchived ? zones.data : activeZones).map((z) => {
                const h = zoneHealth(z, today);
                const meta = zoneKindMeta(z.kind);
                const openHere = open.filter((m) => m.zone_id === z.id).length;
                return (
                  <li key={z.id} className={cn('rounded-2xl border border-border bg-surface/40 p-4', !z.is_active && 'opacity-60')}>
                    <div className="flex items-start gap-3">
                      <span className="text-2xl" aria-hidden>{meta.emoji}</span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-medium">{z.name}</p>
                          {z.room && <span className="text-xs text-muted">{z.room}</span>}
                          <span className={cn('rounded-full border px-2 py-0.5 text-[11px]', HEALTH_STYLE[h.health])}>{HEALTH_LABEL[h.health]}{h.daysSinceReset !== null ? ` · ${h.daysSinceReset}d` : ''}</span>
                        </div>
                        <div className="mt-2 flex items-center gap-2">
                          <div className="flex gap-0.5" aria-label={`Clutter ${z.clutter_score} of 5`}>
                            {[1, 2, 3, 4, 5].map((n) => <span key={n} className={cn('h-2 w-5 rounded-sm', n <= z.clutter_score ? (z.clutter_score >= 4 ? 'bg-rose-400/80' : z.clutter_score === 3 ? 'bg-amber-400/80' : 'bg-emerald-400/80') : 'bg-border')} />)}
                          </div>
                          <span className="text-xs text-muted">{SCORE_LABELS[z.clutter_score]}</span>
                          {z.is_active && (
                            <span className="ml-auto flex items-center gap-0.5">
                              <button onClick={() => bumpScore(z, -1)} aria-label={tr('declutter.lessCluttered')} className="rounded p-0.5 text-muted hover:text-fg"><ChevronDown className="h-4 w-4" /></button>
                              <button onClick={() => bumpScore(z, 1)} aria-label={tr('declutter.moreCluttered')} className="rounded p-0.5 text-muted hover:text-fg"><ChevronUp className="h-4 w-4" /></button>
                            </span>
                          )}
                        </div>
                        {z.target_state && <p className="mt-1 text-xs text-muted">Goal: {z.target_state}</p>}
                        {z.is_active && (
                          <div className="mt-3 flex flex-wrap items-center gap-1.5">
                            {missionsForZone(z).slice(0, 2).map((t) => (
                              <button key={t.title} onClick={() => setMissionForm({ open: true, mission: null, zoneId: z.id, preset: t })} className="rounded-full border border-brand/30 bg-brand/10 px-2.5 py-1 text-xs text-brand-text hover:bg-brand/20 coarse:min-h-9">+ {t.title} · {t.minutes}m</button>
                            ))}
                            {openHere > 0 && <span className="text-xs text-muted">{openHere} open</span>}
                          </div>
                        )}
                      </div>
                      <div className="flex shrink-0 flex-col items-center gap-0.5">
                        {z.is_active ? (
                          <>
                            <button onClick={() => resetZone(z)} aria-label={`Mark ${z.name} reset`} title={tr('declutter.markResetTidy')} className="rounded-lg p-1.5 text-muted hover:text-emerald-400"><RotateCcw className="h-4 w-4" /></button>
                            <button onClick={() => setZoneForm({ open: true, zone: z })} aria-label={`Edit ${z.name}`} className="rounded-lg p-1.5 text-muted hover:text-fg"><Pencil className="h-4 w-4" /></button>
                            <button onClick={() => archiveZone(z, false)} aria-label={`Archive ${z.name}`} className="rounded-lg p-1.5 text-muted hover:text-rose-400"><Archive className="h-4 w-4" /></button>
                          </>
                        ) : (
                          <button onClick={() => archiveZone(z, true)} className="text-xs text-muted hover:text-fg">{tr('declutter.restore')}</button>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Missions */}
        <div className="space-y-4 lg:col-span-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold">{tr('declutter.missions')}</h2>
            <Button size="sm" variant="secondary" onClick={() => setMissionForm({ open: true, mission: null })}><Plus className="h-3.5 w-3.5" /> {tr('declutter.mission')}</Button>
          </div>
          {open.length === 0 ? (
            <div className="rounded-2xl border border-brand/20 bg-brand/5 p-5">
              <p className="text-sm font-semibold text-brand-text">{tr('declutter.nothingPlanned')}</p>
              <p className="mt-1 text-sm text-muted">{activeZones.length ? `“Plan this week” turns your ${activeZones.length} zone${activeZones.length === 1 ? '' : 's'} into ${plan.length || 'a few'} short mission${plan.length === 1 ? '' : 's'}, worst spots first, shared across the family.` : 'Add a zone first, then let the planner spread missions across the week.'}</p>
              {plan.length > 0 && (
                <ul className="mt-3 grid gap-1 text-xs text-muted sm:grid-cols-2">
                  {plan.slice(0, 6).map((p) => <li key={`${p.day}-${p.zone.id}`}>{p.dayLabel}: {zoneKindMeta(p.zone.kind).emoji} {p.template.title} <span className="opacity-70">({p.zone.name}{p.assigneeId ? `, ${nameOf(p.assigneeId)}` : ''})</span></li>)}
                </ul>
              )}
            </div>
          ) : (
            <>
              {groups.today.length > 0 && (<section><h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{tr('declutter.today')}</h3><ul className="space-y-2">{groups.today.map((m) => <MissionRow key={m.id} m={m} />)}</ul></section>)}
              {groups.week.length > 0 && (<section><h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{tr('declutter.thisWeek')}</h3><ul className="space-y-2">{groups.week.map((m) => <MissionRow key={m.id} m={m} />)}</ul></section>)}
              {groups.later.length > 0 && (<section><h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{tr('declutter.laterUnscheduled')}</h3><ul className="space-y-2">{groups.later.map((m) => <MissionRow key={m.id} m={m} />)}</ul></section>)}
            </>
          )}
          {recentDone.length > 0 && (
            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{tr('declutter.recentlyFinished')}</h3>
              <ul className="space-y-2">{recentDone.map((m) => <MissionRow key={m.id} m={m} />)}</ul>
            </section>
          )}
          {sessions.data.length > 0 && (
            <section>
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{tr('declutter.recentSessions')}</h3>
              <ul className="grid gap-2 sm:grid-cols-2">
                {sessions.data.slice(0, 6).map((s) => (
                  <li key={s.id} className="rounded-xl border border-border bg-surface/60 px-3 py-2 text-sm">
                    <p className="font-medium">{s.minutes} min{zoneOf(s.zone_id) ? ` · ${zoneOf(s.zone_id)?.name}` : ''}</p>
                    <p className="text-xs text-muted">{new Date(s.started_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}{s.member_id ? ` · ${nameOf(s.member_id)}` : ''} · {s.items_removed} {tr('declutter.itemsOut')}{s.missions_done ? ` · ${s.missions_done} mission${s.missions_done === 1 ? '' : 's'}` : ''}</p>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>

      {zoneForm.open && (
        <ZoneForm familyId={familyId} userId={userId} zone={zoneForm.zone} onClose={() => setZoneForm({ open: false, zone: null })} onSaved={() => { setZoneForm({ open: false, zone: null }); success('Zone saved'); }} />
      )}
      {missionForm.open && (
        <MissionForm familyId={familyId} userId={userId} zones={activeZones} members={members} mission={missionForm.mission} zoneId={missionForm.zoneId} preset={missionForm.preset} defaultAssignee={selfMember?.id ?? null}
          onClose={() => setMissionForm({ open: false, mission: null })} onSaved={() => { setMissionForm({ open: false, mission: null }); success('Mission saved'); }} />
      )}
      {completing && (
        <CompleteForm familyId={familyId} userId={userId} mission={completing} memberId={completing.assignee_id ?? selfMember?.id ?? null} onClose={() => setCompleting(null)} onSaved={(pts) => { setCompleting(null); success(`Mission done · +${pts} pts`); }} />
      )}
      {sessionOpen && (
        <SessionForm familyId={familyId} userId={userId} zones={activeZones} members={members} defaultMember={selfMember?.id ?? null} onClose={() => setSessionOpen(false)} onSaved={() => { setSessionOpen(false); success('Session logged'); }} />
      )}
    </div>
  );
}

function ZoneForm({ familyId, userId, zone, onClose, onSaved }: { familyId: string; userId: string; zone: Zone | null; onClose: () => void; onSaved: () => void }) {
  const tr = useTranslations();
  const { error: toastError } = useToast();
  const [loading, setLoading] = useState(false);
  const [score, setScore] = useState(zone?.clutter_score ?? 3);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const name = String(f.get('name') ?? '').trim();
    if (!name) return toastError('Give the zone a name');
    setLoading(true);
    const payload = {
      name, room: String(f.get('room') ?? '').trim() || null, kind: String(f.get('kind') ?? 'surface') as DeclutterZoneKind, clutter_score: score,
      target_state: String(f.get('target_state') ?? '').trim() || null, notes: String(f.get('notes') ?? '').trim() || null,
    };
    const supabase = createClient();
    const { error } = zone
      ? await supabase.from('declutter_zones').update(payload).eq('id', zone.id)
      : await supabase.from('declutter_zones').insert({ family_id: familyId, created_by: userId, is_active: true, ...payload });
    setLoading(false);
    if (error) return toastError(describeDbError(error));
    onSaved();
  }

  return (
    <Modal open title={zone ? 'Edit zone' : 'Add a zone'} description={tr('declutterModule.aZoneIsOneSpot')} onClose={onClose}>
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label={tr('declutter.name')} required>{(id) => <Input id={id} name="name" defaultValue={zone?.name ?? ''} placeholder={tr('declutter.kitchenCounter')} autoFocus />}</Field>
          <Field label={tr('declutter.room')}>{(id) => <Input id={id} name="room" defaultValue={zone?.room ?? ''} placeholder={tr('declutter.kitchen')} />}</Field>
        </div>
        <Field label={tr('declutter.kind')} hint={tr('declutterModule.picksTheMissionTemplates')}>{(id) => <Select id={id} name="kind" defaultValue={zone?.kind ?? 'surface'}>{ZONE_KINDS.map((k) => <option key={k.value} value={k.value}>{k.emoji} {k.label}</option>)}</Select>}</Field>
        <div>
          <p className="mb-1.5 text-xs font-medium text-muted">{tr('declutter.howBadIsItRightNow')}</p>
          <div className="flex gap-2" role="radiogroup" aria-label={tr('declutter.clutterScore')}>
            {[1, 2, 3, 4, 5].map((n) => <button type="button" key={n} role="radio" aria-checked={score === n} onClick={() => setScore(n)} className={cn('flex-1 rounded-xl border px-2 py-2 text-xs coarse:min-h-11', score === n ? 'border-brand bg-brand/15 text-brand-text' : 'border-border text-muted')}>{n}<br />{SCORE_LABELS[n]}</button>)}
          </div>
        </div>
        <Field label={tr('declutter.whatDoneLooksLike')}>{(id) => <Input id={id} name="target_state" defaultValue={zone?.target_state ?? ''} placeholder={tr('declutter.onlyTheFruitBowlAndCoffee')} />}</Field>
        <Field label={tr('declutter.notes')}>{(id) => <Textarea id={id} name="notes" defaultValue={zone?.notes ?? ''} rows={2} />}</Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>{tr('declutter.cancel')}</Button>
          <Button type="submit" loading={loading}><Check className="h-4 w-4" /> {tr('declutter.saveZone')}</Button>
        </div>
      </form>
    </Modal>
  );
}

function MissionForm({ familyId, userId, zones, members, mission, zoneId, preset, defaultAssignee, onClose, onSaved }: {
  familyId: string; userId: string; zones: Zone[]; members: { id: string; display_name: string }[]; mission: Mission | null; zoneId?: string;
  preset?: { title: string; minutes: number; points: number }; defaultAssignee: string | null; onClose: () => void; onSaved: () => void;
}) {
  const tr = useTranslations();
  const { error: toastError } = useToast();
  const [loading, setLoading] = useState(false);
  const [zone, setZone] = useState(mission?.zone_id ?? zoneId ?? zones[0]?.id ?? '');
  const templates = zone ? zoneKindMeta(zones.find((z) => z.id === zone)?.kind ?? 'other').templates : [];

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const title = String(f.get('title') ?? '').trim();
    if (!title) return toastError('Give the mission a title');
    const minutes = Math.min(60, Math.max(5, Number(f.get('minutes') ?? 15)));
    setLoading(true);
    const payload = {
      title, minutes, zone_id: zone || null, assignee_id: String(f.get('assignee_id') ?? '') || null,
      scheduled_for: String(f.get('scheduled_for') ?? '') || null, points: Math.min(100, Math.max(0, Number(f.get('points') ?? 5))),
      notes: String(f.get('notes') ?? '').trim() || null,
    };
    const supabase = createClient();
    const { error } = mission
      ? await supabase.from('declutter_missions').update(payload).eq('id', mission.id)
      : await supabase.from('declutter_missions').insert({ family_id: familyId, created_by: userId, status: 'planned', ...payload });
    setLoading(false);
    if (error) return toastError(describeDbError(error));
    onSaved();
  }

  return (
    <Modal open title={mission ? 'Edit mission' : 'New mission'} description={tr('declutterModule.keepItToOneTimer')} onClose={onClose}>
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label={tr('declutter.zone')}>{(id) => <Select id={id} name="zone_id" value={zone} onChange={(e) => setZone(e.target.value)}><option value="">{tr('declutter.noZone')}</option>{zones.map((z) => <option key={z.id} value={z.id}>{zoneKindMeta(z.kind).emoji} {z.name}{z.room ? ` · ${z.room}` : ''}</option>)}</Select>}</Field>
        <Field label={tr('declutter.mission')} required>{(id) => <Input id={id} name="title" list="mission-ideas" defaultValue={mission?.title ?? preset?.title ?? ''} placeholder={tr('declutter.clearEverythingThatDoesntLiveHere')} autoFocus={!preset} />}</Field>
        {templates.length > 0 && <datalist id="mission-ideas">{templates.map((t) => <option key={t.title} value={t.title} />)}</datalist>}
        <div className="grid grid-cols-3 gap-3">
          <Field label={tr('declutter.minutes')}>{(id) => <Input id={id} name="minutes" type="number" min={5} max={60} step={5} defaultValue={mission?.minutes ?? preset?.minutes ?? 15} />}</Field>
          <Field label={tr('declutter.points')}>{(id) => <Input id={id} name="points" type="number" min={0} max={100} defaultValue={mission?.points ?? preset?.points ?? 5} />}</Field>
          <Field label={tr('declutter.when')}>{(id) => <Input id={id} name="scheduled_for" type="date" defaultValue={mission?.scheduled_for ?? isoDate(new Date())} />}</Field>
        </div>
        <Field label="Who">{(id) => <Select id={id} name="assignee_id" defaultValue={mission?.assignee_id ?? defaultAssignee ?? ''}><option value="">{tr('declutter.anyone')}</option>{members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</Select>}</Field>
        <Field label={tr('declutter.notes')}>{(id) => <Textarea id={id} name="notes" defaultValue={mission?.notes ?? ''} rows={2} />}</Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>{tr('declutter.cancel')}</Button>
          <Button type="submit" loading={loading}><Check className="h-4 w-4" /> {tr('declutter.saveMission')}</Button>
        </div>
      </form>
    </Modal>
  );
}

function CompleteForm({ familyId, userId, mission, memberId, onClose, onSaved }: { familyId: string; userId: string; mission: Mission; memberId: string | null; onClose: () => void; onSaved: (points: number) => void }) {
  const tr = useTranslations();
  const { error: toastError } = useToast();
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState(0);
  const points = missionPoints({ points: mission.points, items_removed: items });

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const minutes = Math.min(480, Math.max(1, Number(f.get('minutes') ?? mission.minutes)));
    const notes = String(f.get('notes') ?? '').trim() || null;
    setLoading(true);
    const supabase = createClient();
    const { error } = await supabase.from('declutter_missions').update({ status: 'done', completed_at: new Date().toISOString(), items_removed: items, notes: notes ?? mission.notes }).eq('id', mission.id);
    if (error) { setLoading(false); return toastError(describeDbError(error)); }
    // The mission counts as a timed session too, so streaks and minutes add up
    // without a second form. A failed session insert is reported but does not
    // undo the completion — the mission itself is what the family cares about.
    const { error: sessionError } = await supabase.from('declutter_sessions').insert({
      family_id: familyId, zone_id: mission.zone_id, member_id: memberId, minutes, missions_done: 1, items_removed: items, created_by: userId,
    });
    setLoading(false);
    if (sessionError) toastError(describeDbError(sessionError));
    onSaved(points);
  }

  return (
    <Modal open title={tr('declutter.missionDone')} description={mission.title} onClose={onClose}>
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label={tr('declutter.itemsOutDonatedTossedRehomed')}>{(id) => <Input id={id} name="items_removed" type="number" min={0} max={999} value={items} onChange={(e) => setItems(Math.max(0, Number(e.target.value) || 0))} autoFocus />}</Field>
          <Field label={tr('declutter.minutesItTook')}>{(id) => <Input id={id} name="minutes" type="number" min={1} max={480} defaultValue={mission.minutes} />}</Field>
        </div>
        <p className="text-sm text-muted">{tr('declutter.earns')} <span className="font-semibold text-brand-text">{points} points</span>{items >= 5 ? ' including a bonus for what left the house' : ''}.</p>
        <Field label={tr('declutter.notes')}>{(id) => <Textarea id={id} name="notes" rows={2} placeholder={tr('declutter.twoBagsToTheDonationBin')} />}</Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>{tr('declutter.cancel')}</Button>
          <Button type="submit" loading={loading}><Check className="h-4 w-4" /> {tr('declutter.finishMission')}</Button>
        </div>
      </form>
    </Modal>
  );
}

function SessionForm({ familyId, userId, zones, members, defaultMember, onClose, onSaved }: { familyId: string; userId: string; zones: Zone[]; members: { id: string; display_name: string }[]; defaultMember: string | null; onClose: () => void; onSaved: () => void }) {
  const tr = useTranslations();
  const { error: toastError } = useToast();
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const minutes = Math.min(480, Math.max(1, Number(f.get('minutes') ?? 15)));
    setLoading(true);
    const { error } = await createClient().from('declutter_sessions').insert({
      family_id: familyId, zone_id: String(f.get('zone_id') ?? '') || null, member_id: String(f.get('member_id') ?? '') || null,
      minutes, items_removed: Math.max(0, Number(f.get('items_removed') ?? 0)), missions_done: 0,
      notes: String(f.get('notes') ?? '').trim() || null, created_by: userId,
    });
    setLoading(false);
    if (error) return toastError(describeDbError(error));
    onSaved();
  }

  return (
    <Modal open title={tr('declutter.logASession')} description={tr('declutterModule.anyTimedTidyCountsMission')} onClose={onClose}>
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label={tr('declutter.minutes')} required>{(id) => <Input id={id} name="minutes" type="number" min={1} max={480} defaultValue={15} autoFocus />}</Field>
          <Field label={tr('declutter.itemsOut')}>{(id) => <Input id={id} name="items_removed" type="number" min={0} max={999} defaultValue={0} />}</Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label={tr('declutter.zone')}>{(id) => <Select id={id} name="zone_id" defaultValue=""><option value="">{tr('declutter.wholeHouse')}</option>{zones.map((z) => <option key={z.id} value={z.id}>{zoneKindMeta(z.kind).emoji} {z.name}</option>)}</Select>}</Field>
          <Field label="Who">{(id) => <Select id={id} name="member_id" defaultValue={defaultMember ?? ''}><option value="">{tr('declutter.everyone')}</option>{members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</Select>}</Field>
        </div>
        <Field label={tr('declutter.notes')}>{(id) => <Textarea id={id} name="notes" rows={2} />}</Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>{tr('declutter.cancel')}</Button>
          <Button type="submit" loading={loading}><Timer className="h-4 w-4" /> {tr('declutter.saveSession')}</Button>
        </div>
      </form>
    </Modal>
  );
}
