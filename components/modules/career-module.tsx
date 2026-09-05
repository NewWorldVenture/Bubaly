'use client';

import { useEffect, useMemo, useState } from 'react';
import { Briefcase, Plus, Check, Pencil, Trash2, FileText, Target, Bell, TrendingUp, Sparkles, ExternalLink, Star, ArrowRight, Map } from 'lucide-react';
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
import type { Database, Tables, CareerEmploymentType, CareerStatus, CareerWorkMode, JobStage } from '@/lib/database.types';
import {
  JOB_STAGES, CAREER_STATUSES, WORK_MODES, EMPLOYMENT_TYPES, OPEN_STAGES, stageMeta, parseKeywords, atsScore, pipelineStats, followUps, salaryFit, careerMap, careerSummary, money, isoDate,
} from '@/lib/career/hub';

type Profile = Tables<'career_profiles'>;
type Application = Tables<'job_applications'>;
type Resume = Tables<'resume_versions'>;

const fmtDate = (d: string) => new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const dollarsToCents = (v: FormDataEntryValue | null) => { const raw = String(v ?? '').trim(); if (!raw) return null; const n = Number(raw.replace(/[^0-9.]/g, '')); return Number.isFinite(n) ? Math.round(n * 100) : null; };
const centsToDollars = (c: number | null | undefined) => (c === null || c === undefined ? '' : String(c / 100));
const STAGE_STYLE: Record<JobStage, string> = {
  saved: 'border-border text-muted', applied: 'border-sky-500/30 bg-sky-500/10 text-sky-200', screening: 'border-indigo-500/30 bg-indigo-500/10 text-indigo-200',
  interview: 'border-amber-500/30 bg-amber-500/10 text-amber-200', offer: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200',
  accepted: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-100', rejected: 'border-border text-muted line-through', withdrawn: 'border-border text-muted',
};

export function CareerModule() {
  const { familyId, userId, members, selfMember } = useApp();
  const { success, error: toastError } = useToast();

  const profiles = useRealtimeQuery<Profile>({
    table: 'career_profiles', familyId,
    fetcher: (s) => s.from('career_profiles').select('*').eq('family_id', familyId).order('is_active', { ascending: false }).order('created_at'),
    deps: [familyId],
  });
  const apps = useRealtimeQuery<Application>({
    table: 'job_applications', familyId,
    fetcher: (s) => s.from('job_applications').select('*').eq('family_id', familyId).order('updated_at', { ascending: false }).limit(600),
    deps: [familyId],
  });
  const resumes = useRealtimeQuery<Resume>({
    table: 'resume_versions', familyId,
    fetcher: (s) => s.from('resume_versions').select('*').eq('family_id', familyId).order('is_primary', { ascending: false }).order('updated_at', { ascending: false }).limit(300),
    deps: [familyId],
  });

  const [profileId, setProfileId] = useState('');
  useEffect(() => {
    if (profiles.data.length && !profiles.data.some((p) => p.id === profileId)) {
      setProfileId((profiles.data.find((p) => p.is_active && p.member_id === selfMember?.id) ?? profiles.data.find((p) => p.is_active) ?? profiles.data[0]).id);
    }
  }, [profiles.data, profileId, selfMember]);
  const [profileForm, setProfileForm] = useState<{ open: boolean; profile: Profile | null }>({ open: false, profile: null });
  const [appForm, setAppForm] = useState<{ open: boolean; application: Application | null }>({ open: false, application: null });
  const [resumeForm, setResumeForm] = useState<{ open: boolean; resume: Resume | null }>({ open: false, resume: null });
  const [tab, setTab] = useState<'pipeline' | 'resumes' | 'map'>('pipeline');
  const [showClosed, setShowClosed] = useState(false);

  const today = useMemo(() => new Date(), []);
  const profile = profiles.data.find((p) => p.id === profileId) ?? null;
  const myApps = useMemo(() => apps.data.filter((a) => a.profile_id === profileId), [apps.data, profileId]);
  const myResumes = useMemo(() => resumes.data.filter((r) => r.profile_id === profileId), [resumes.data, profileId]);
  const stats = useMemo(() => (profile ? pipelineStats(myApps, profile, today) : null), [profile, myApps, today]);
  const nudges = useMemo(() => (profile ? followUps(myApps, profile.id, today) : []), [profile, myApps, today]);
  const salary = useMemo(() => (profile ? salaryFit(myApps, profile.id, profile.salary_target_cents) : null), [profile, myApps]);
  const map = useMemo(() => (profile ? careerMap(profile) : []), [profile]);
  const summary = useMemo(() => careerSummary(profiles.data, apps.data, today), [profiles.data, apps.data, today]);
  const nameOf = (id: string | null) => members.find((m) => m.id === id)?.display_name ?? 'Member';
  const [showArchived, setShowArchived] = useState(false);
  const visibleProfiles = profiles.data.filter((p) => p.is_active || showArchived || p.id === profileId);

  async function moveStage(a: Application, stage: JobStage) {
    const patch: Database['public']['Tables']['job_applications']['Update'] = { stage, last_activity_on: isoDate(new Date()) };
    if (stage === 'applied' && !a.applied_on) patch.applied_on = isoDate(new Date());
    const { error } = await createClient().from('job_applications').update(patch).eq('id', a.id);
    if (error) return toastError(describeDbError(error));
    success(`${a.company}: ${stageMeta(stage).label.toLowerCase()}`);
  }

  async function deleteApplication(a: Application) {
    if (!confirm(`Remove ${a.role_title} at ${a.company}?`)) return;
    const { error } = await createClient().from('job_applications').delete().eq('id', a.id);
    if (error) return toastError(describeDbError(error));
    success('Application removed');
  }

  async function setPrimary(r: Resume) {
    const supabase = createClient();
    const { error: clearError } = await supabase.from('resume_versions').update({ is_primary: false }).eq('profile_id', r.profile_id).neq('id', r.id);
    if (clearError) return toastError(describeDbError(clearError));
    const { error } = await supabase.from('resume_versions').update({ is_primary: true }).eq('id', r.id);
    if (error) return toastError(describeDbError(error));
    success(`${r.title} is now the primary resume`);
  }

  async function deleteResume(r: Resume) {
    if (!confirm(`Delete “${r.title}”?`)) return;
    const { error } = await createClient().from('resume_versions').delete().eq('id', r.id);
    if (error) return toastError(describeDbError(error));
    success('Resume deleted');
  }

  async function archiveProfile(p: Profile, active: boolean) {
    const { error } = await createClient().from('career_profiles').update({ is_active: active }).eq('id', p.id);
    if (error) return toastError(describeDbError(error));
    success(active ? 'Search reopened' : 'Search archived');
  }

  async function deleteProfile(p: Profile) {
    if (!confirm(`Delete “${p.title}” for ${nameOf(p.member_id)} with every application and resume?`)) return;
    const { error } = await createClient().from('career_profiles').delete().eq('id', p.id);
    if (error) return toastError(describeDbError(error));
    setProfileId('');
    success('Profile deleted');
  }

  const loading = profiles.loading || apps.loading || resumes.loading;
  const error = profiles.error || apps.error || resumes.error;
  const refresh = () => { void profiles.refresh(); void apps.refresh(); void resumes.refresh(); };
  if (loading) return <SkeletonList />;
  if (error) return <ErrorState message="Could not load the career hub. Refresh and try again." onRetry={refresh} />;

  const AppRow = ({ a }: { a: Application }) => {
    const nudge = nudges.find((n) => n.application.id === a.id);
    const next = JOB_STAGES.filter((s) => s.open && JOB_STAGES.findIndex((x) => x.value === s.value) === JOB_STAGES.findIndex((x) => x.value === a.stage) + 1)[0];
    return (
      <li className={cn('rounded-xl border px-3 py-2', nudge?.kind === 'next_step_overdue' ? 'border-rose-500/30 bg-rose-500/5' : nudge ? 'border-amber-500/20 bg-amber-500/5' : 'border-border bg-surface/60')}>
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{a.role_title} <span className="text-muted">· {a.company}</span>{a.excitement ? <span className="ml-1 text-xs text-amber-300">{'★'.repeat(a.excitement)}</span> : null}</p>
            <p className="text-[11px] text-muted">
              <span className={cn('rounded-full border px-1.5 py-0.5', STAGE_STYLE[a.stage])}>{stageMeta(a.stage).label}</span>
              {a.applied_on ? ` · applied ${fmtDate(a.applied_on)}` : ''}{a.location ? ` · ${a.location}` : ''}{a.work_mode ? ` · ${a.work_mode}` : ''}
              {a.salary_min_cents || a.salary_max_cents ? ` · ${money(a.salary_min_cents ?? a.salary_max_cents)}${a.salary_max_cents && a.salary_min_cents ? `–${money(a.salary_max_cents)}` : ''}` : ''}
            </p>
            {nudge ? <p className={cn('mt-1 text-xs', nudge.kind === 'next_step_overdue' ? 'text-rose-300' : 'text-amber-200')}><Bell className="mr-1 inline h-3 w-3" />{nudge.text}</p>
              : a.next_step ? <p className="mt-1 text-xs text-muted">Next: {a.next_step}{a.next_step_on ? ` · ${fmtDate(a.next_step_on)}` : ''}</p> : null}
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            {next && OPEN_STAGES.includes(a.stage) && <Button size="sm" variant="secondary" onClick={() => moveStage(a, next.value)}><ArrowRight className="h-3.5 w-3.5" /> {next.label}</Button>}
            {a.url && <a href={a.url} target="_blank" rel="noreferrer" aria-label="Open posting" className="rounded-lg p-1.5 text-muted hover:text-fg"><ExternalLink className="h-4 w-4" /></a>}
            <button onClick={() => setAppForm({ open: true, application: a })} aria-label={`Edit ${a.company}`} className="rounded-lg p-1.5 text-muted hover:text-fg"><Pencil className="h-4 w-4" /></button>
            <button onClick={() => deleteApplication(a)} aria-label={`Delete ${a.company}`} className="rounded-lg p-1.5 text-muted hover:text-rose-400"><Trash2 className="h-4 w-4" /></button>
          </div>
        </div>
      </li>
    );
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Career Hub"
        description="The household’s income depends on its careers: a parent’s next role, a teen’s first job. One place for the target, the pipeline with follow-up nudges, resume versions scored against the role’s keywords, and a map from the skills you have to the roles you want."
        action={
          <div className="flex flex-wrap items-center gap-2">
            <AiInsight kind="career" iconOnly />
            {profile && <Button variant="secondary" onClick={() => setResumeForm({ open: true, resume: null })}><FileText className="h-4 w-4" /> Resume</Button>}
            {profile && <Button onClick={() => setAppForm({ open: true, application: null })}><Plus className="h-4 w-4" /> Application</Button>}
            <Button variant={profile ? 'ghost' : 'primary'} onClick={() => setProfileForm({ open: true, profile: null })}><Briefcase className="h-4 w-4" /> {profile ? 'New search' : 'Start a search'}</Button>
          </div>
        }
      />

      {profiles.data.length === 0 || !profile || !stats || !salary ? (
        <EmptyState icon={Briefcase} title="No career profiles yet" description="Start with who is looking and what for. Applications, resume scoring and the skills map hang off that." action={<Button onClick={() => setProfileForm({ open: true, profile: null })}><Briefcase className="h-4 w-4" /> Start a profile</Button>} />
      ) : (
        <>
          {(profiles.data.length > 1) && (
            <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Job search">
              {visibleProfiles.map((p) => (
                <button key={p.id} role="tab" aria-selected={p.id === profileId} onClick={() => setProfileId(p.id)} className={cn('rounded-full border px-3 py-1.5 text-sm transition coarse:min-h-11', p.id === profileId ? 'border-brand bg-brand/15 text-brand-text' : 'border-border bg-surface/40 text-muted hover:text-fg', !p.is_active && 'opacity-60')}>
                  {nameOf(p.member_id)} <span className="text-xs opacity-70">· {p.title}</span>
                </button>
              ))}
              {profiles.data.some((p) => !p.is_active) && <button onClick={() => setShowArchived((v) => !v)} className="text-xs text-muted hover:text-fg">{showArchived ? 'Hide' : 'Show'} past searches</button>}
            </div>
          )}

          <div className="rounded-2xl border border-border bg-surface/40 p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-lg font-semibold">{nameOf(profile.member_id)} · {profile.title}{!profile.is_active ? <span className="ml-2 rounded-full border border-border px-2 py-0.5 text-xs font-normal text-muted">past search</span> : null}</h2>
                {profile.headline && <p className="text-sm text-muted">{profile.headline}</p>}
                <p className="mt-1 text-sm text-muted">{CAREER_STATUSES.find((s) => s.value === profile.status)?.label} · {EMPLOYMENT_TYPES.find((e) => e.value === profile.employment_type)?.label} · {WORK_MODES.find((w) => w.value === profile.work_mode)?.label}{profile.location ? ` · ${profile.location}` : ''}{profile.salary_target_cents ? ` · target ${money(profile.salary_target_cents)}` : ''}</p>
                {profile.target_roles.length > 0 && <p className="mt-1 text-xs text-muted"><Target className="mr-1 inline h-3 w-3" />{profile.target_roles.join(' · ')}</p>}
                {profile.skills.length > 0 && <div className="mt-2 flex flex-wrap gap-1">{profile.skills.slice(0, 14).map((s) => <span key={s} className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted">{s}</span>)}{profile.skills.length > 14 ? <span className="text-[11px] text-muted">+{profile.skills.length - 14}</span> : null}</div>}
              </div>
              <div className="flex items-center gap-1">
                <button onClick={() => archiveProfile(profile, !profile.is_active)} className="rounded-lg px-2 py-1 text-xs text-muted hover:text-fg">{profile.is_active ? 'Archive search' : 'Reopen'}</button>
                <button onClick={() => setProfileForm({ open: true, profile })} aria-label="Edit profile" className="rounded-lg p-1.5 text-muted hover:text-fg"><Pencil className="h-4 w-4" /></button>
                <button onClick={() => deleteProfile(profile)} aria-label="Delete profile" className="rounded-lg p-1.5 text-muted hover:text-rose-400"><Trash2 className="h-4 w-4" /></button>
              </div>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-4">
            <div className={cn('rounded-2xl border p-5', summary.overdue ? 'border-rose-500/30 bg-rose-500/10' : stats.byStage.offer ? 'border-emerald-500/30 bg-emerald-500/10' : 'border-border bg-surface/40')}>
              <div className="flex items-center gap-2 text-sm font-semibold"><Briefcase className="h-4 w-4 text-brand-text" /> Pipeline</div>
              <p className="mt-2 text-2xl font-bold">{stats.open}<span className="text-sm font-normal text-muted"> open</span></p>
              <p className="mt-1 text-xs text-muted">{stats.byStage.interview} interviewing · {stats.byStage.offer} offer{stats.byStage.offer === 1 ? '' : 's'} · {nudges.length} nudge{nudges.length === 1 ? '' : 's'}</p>
            </div>
            <div className={cn('rounded-2xl border p-5', stats.goalPct >= 100 ? 'border-emerald-500/30 bg-emerald-500/10' : 'border-border bg-surface/40')}>
              <div className="flex items-center gap-2 text-sm font-semibold"><Target className="h-4 w-4 text-brand-text" /> This week</div>
              <p className="mt-2 text-2xl font-bold">{stats.appliedThisWeek}<span className="text-sm font-normal text-muted"> / {stats.weeklyGoal} applications</span></p>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-border"><div className="h-full rounded-full bg-brand" style={{ width: `${stats.goalPct}%` }} /></div>
            </div>
            <div className="rounded-2xl border border-border bg-surface/40 p-5">
              <div className="flex items-center gap-2 text-sm font-semibold"><TrendingUp className="h-4 w-4 text-brand-text" /> Conversion</div>
              <p className="mt-2 text-2xl font-bold">{stats.responseRate !== null ? `${stats.responseRate}%` : '—'}<span className="text-sm font-normal text-muted"> get a reply</span></p>
              <p className="mt-1 text-xs text-muted">{stats.interviewRate !== null ? `${stats.interviewRate}% reach interview` : 'Apply to see rates'}{stats.avgDaysToResponse !== null ? ` · ~${stats.avgDaysToResponse}d to hear back` : ''}</p>
            </div>
            <div className="rounded-2xl border border-border bg-surface/40 p-5">
              <div className="flex items-center gap-2 text-sm font-semibold"><Sparkles className="h-4 w-4 text-brand-text" /> Money</div>
              <p className="mt-2 text-2xl font-bold">{salary.medianMidCents !== null ? money(salary.medianMidCents) : '—'}</p>
              <p className="mt-1 text-xs text-muted">{salary.withRange ? `median of ${salary.withRange} open role${salary.withRange === 1 ? '' : 's'} with a range${profile.salary_target_cents ? ` · ${salary.atOrAbove} at or above target` : ''}` : 'No salary ranges logged yet'}</p>
            </div>
          </div>

          <div className="flex items-center gap-2 border-b border-border" role="tablist">
            {([['pipeline', `Pipeline (${stats.total})`], ['resumes', `Resumes (${myResumes.length})`], ['map', 'Career map']] as const).map(([key, label]) => (
              <button key={key} role="tab" aria-selected={tab === key} onClick={() => setTab(key)} className={cn('-mb-px border-b-2 px-3 py-2 text-sm coarse:min-h-11', tab === key ? 'border-brand text-brand-text' : 'border-transparent text-muted hover:text-fg')}>{label}</button>
            ))}
            {tab === 'pipeline' && <label className="ml-auto flex items-center gap-1.5 pb-1 text-xs text-muted"><input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} className="accent-brand" /> Show closed</label>}
          </div>

          {tab === 'pipeline' && (
            myApps.length === 0 ? (
              <EmptyState icon={Briefcase} title="Nothing in the pipeline" description="Save the roles worth applying to, then move each one along: applied → screening → interview → offer. The hub nudges you when something goes quiet." action={<Button onClick={() => setAppForm({ open: true, application: null })}><Plus className="h-4 w-4" /> First application</Button>} />
            ) : (
              <div className="space-y-5">
                {nudges.length > 0 && (
                  <section>
                    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Needs you</h3>
                    <ul className="space-y-2">{nudges.map((n) => <AppRow key={n.application.id} a={n.application} />)}</ul>
                  </section>
                )}
                {JOB_STAGES.filter((s) => s.open).map((s) => {
                  const list = myApps.filter((a) => a.stage === s.value && !nudges.some((n) => n.application.id === a.id));
                  if (!list.length) return null;
                  return (
                    <section key={s.value}>
                      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{s.label} · {list.length}</h3>
                      <ul className="space-y-2">{list.map((a) => <AppRow key={a.id} a={a} />)}</ul>
                    </section>
                  );
                })}
                {showClosed && (() => { const closed = myApps.filter((a) => !OPEN_STAGES.includes(a.stage)); return closed.length ? <section><h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Closed · {closed.length}</h3><ul className="space-y-2">{closed.map((a) => <AppRow key={a.id} a={a} />)}</ul></section> : null; })()}
              </div>
            )
          )}

          {tab === 'resumes' && (
            myResumes.length === 0 ? (
              <EmptyState icon={FileText} title="No resume versions" description="Paste the resume text and the target role’s keywords. You get an ATS-style score, what is missing, and a version per role." action={<Button onClick={() => setResumeForm({ open: true, resume: null })}><FileText className="h-4 w-4" /> Add a resume</Button>} />
            ) : (
              <ul className="grid gap-3 md:grid-cols-2">
                {myResumes.map((r) => {
                  const ats = atsScore(r.body, r.keywords);
                  return (
                    <li key={r.id} className={cn('rounded-2xl border p-4', r.is_primary ? 'border-brand/40 bg-brand/5' : 'border-border bg-surface/40')}>
                      <div className="flex items-start gap-3">
                        <div className={cn('grid h-12 w-12 shrink-0 place-items-center rounded-xl text-sm font-bold', ats.score >= 75 ? 'bg-emerald-500/15 text-emerald-200' : ats.score >= 50 ? 'bg-amber-500/15 text-amber-200' : 'bg-rose-500/15 text-rose-200')}>{ats.score}</div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-medium">{r.title}{r.is_primary ? <Star className="ml-1 inline h-3.5 w-3.5 text-brand-text" /> : null}</p>
                          <p className="text-xs text-muted">{r.target_role ?? 'General'} · {ats.wordCount} words · {ats.matched.length}/{r.keywords.length} keywords</p>
                          {ats.hints.length > 0 && <ul className="mt-2 space-y-0.5 text-xs text-muted">{ats.hints.slice(0, 3).map((h) => <li key={h}>· {h}</li>)}</ul>}
                        </div>
                        <div className="flex shrink-0 items-center gap-0.5">
                          {!r.is_primary && <button onClick={() => setPrimary(r)} aria-label="Make primary" title="Make primary" className="rounded-lg p-1.5 text-muted hover:text-fg"><Star className="h-4 w-4" /></button>}
                          <button onClick={() => setResumeForm({ open: true, resume: r })} aria-label={`Edit ${r.title}`} className="rounded-lg p-1.5 text-muted hover:text-fg"><Pencil className="h-4 w-4" /></button>
                          <button onClick={() => deleteResume(r)} aria-label={`Delete ${r.title}`} className="rounded-lg p-1.5 text-muted hover:text-rose-400"><Trash2 className="h-4 w-4" /></button>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )
          )}

          {tab === 'map' && (
            <div className="space-y-3">
              <p className="text-sm text-muted"><Map className="mr-1 inline h-4 w-4" />How {nameOf(profile.member_id)}’s skills cover each target role. Add target roles and skills on the profile to sharpen it; the AI coach turns the gaps into a plan.</p>
              {map.length === 0 ? <p className="text-sm text-muted">Add target roles to the profile.</p> : (
                <ul className="grid gap-3 md:grid-cols-2">
                  {map.map((r) => (
                    <li key={r.role} className="rounded-2xl border border-border bg-surface/40 p-4">
                      <div className="flex items-center justify-between"><p className="font-medium capitalize">{r.role}</p><span className={cn('text-sm font-bold', r.fitPct >= 70 ? 'text-emerald-300' : r.fitPct >= 40 ? 'text-amber-300' : 'text-rose-300')}>{r.fitPct}% fit</span></div>
                      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-border"><div className="h-full rounded-full bg-brand" style={{ width: `${r.fitPct}%` }} /></div>
                      {r.have.length > 0 && <p className="mt-2 text-xs text-muted">Have: {r.have.join(', ')}</p>}
                      {r.gap.length > 0 && <p className="mt-1 text-xs text-amber-200">Gap: {r.gap.join(', ')}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}

      {profileForm.open && (
        <ProfileForm familyId={familyId} userId={userId} members={members} profile={profileForm.profile} defaultMember={selfMember?.id ?? null} onClose={() => setProfileForm({ open: false, profile: null })} onSaved={(id) => { setProfileForm({ open: false, profile: null }); setProfileId(id); success('Profile saved'); }} />
      )}
      {appForm.open && profile && (
        <ApplicationForm familyId={familyId} userId={userId} profile={profile} resumes={myResumes} application={appForm.application} onClose={() => setAppForm({ open: false, application: null })} onSaved={() => { setAppForm({ open: false, application: null }); success('Application saved'); }} />
      )}
      {resumeForm.open && profile && (
        <ResumeForm familyId={familyId} userId={userId} profile={profile} resume={resumeForm.resume} isFirst={myResumes.length === 0} onClose={() => setResumeForm({ open: false, resume: null })} onSaved={() => { setResumeForm({ open: false, resume: null }); success('Resume saved'); }} />
      )}
    </div>
  );
}

function ProfileForm({ familyId, userId, members, profile, defaultMember, onClose, onSaved }: { familyId: string; userId: string; members: { id: string; display_name: string }[]; profile: Profile | null; defaultMember: string | null; onClose: () => void; onSaved: (id: string) => void }) {
  const { error: toastError } = useToast();
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const memberId = String(f.get('member_id') ?? '');
    if (!memberId) return toastError('Whose profile is this?');
    setLoading(true);
    const payload = {
      title: String(f.get('title') ?? '').trim() || 'Job search',
      headline: String(f.get('headline') ?? '').trim() || null, summary: String(f.get('summary') ?? '').trim() || null,
      skills: parseKeywords(String(f.get('skills') ?? '')), target_roles: parseKeywords(String(f.get('target_roles') ?? '')), target_keywords: parseKeywords(String(f.get('target_keywords') ?? '')),
      work_mode: String(f.get('work_mode') ?? 'any') as CareerWorkMode, employment_type: String(f.get('employment_type') ?? 'full_time') as CareerEmploymentType,
      salary_target_cents: dollarsToCents(f.get('salary_target')), location: String(f.get('location') ?? '').trim() || null,
      status: String(f.get('status') ?? 'exploring') as CareerStatus, weekly_goal: Math.max(0, Math.min(100, Number(f.get('weekly_goal') ?? 5))), notes: String(f.get('notes') ?? '').trim() || null,
    };
    const supabase = createClient();
    const { data, error } = profile
      ? await supabase.from('career_profiles').update(payload).eq('id', profile.id).select('id').single()
      : await supabase.from('career_profiles').insert({ family_id: familyId, member_id: memberId, created_by: userId, ...payload }).select('id').single();
    setLoading(false);
    if (error) return toastError(describeDbError(error));
    onSaved(data.id);
  }

  return (
    <Modal open title={profile ? 'Edit job search' : 'Start a job search'} description="One search per goal — a parent’s next role, a teen’s summer job. Target roles and keywords drive the resume score and the career map." onClose={onClose}>
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Who" required>{(id) => <Select id={id} name="member_id" defaultValue={profile?.member_id ?? defaultMember ?? ''} disabled={!!profile}>{!profile && <option value="">Choose…</option>}{members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</Select>}</Field>
          <Field label="Search name" required>{(id) => <Input id={id} name="title" defaultValue={profile?.title ?? ''} placeholder="Next ops role · Summer job 2026" />}</Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Status">{(id) => <Select id={id} name="status" defaultValue={profile?.status ?? 'exploring'}>{CAREER_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</Select>}</Field>
          <Field label="Headline">{(id) => <Input id={id} name="headline" defaultValue={profile?.headline ?? ''} placeholder="Operations manager · 8 yrs logistics" />}</Field>
        </div>
        <Field label="Target roles (comma separated)" hint="e.g. Data Analyst, Project Manager — or Lifeguard, Barista for a first job">{(id) => <Input id={id} name="target_roles" defaultValue={profile?.target_roles.join(', ') ?? ''} />}</Field>
        <Field label="Skills you have (comma separated)">{(id) => <Textarea id={id} name="skills" rows={2} defaultValue={profile?.skills.join(', ') ?? ''} placeholder="SQL, Excel, team leadership, CPR…" />}</Field>
        <Field label="Keywords the target roles ask for" hint="Copy from real postings; resumes are scored against these">{(id) => <Textarea id={id} name="target_keywords" rows={2} defaultValue={profile?.target_keywords.join(', ') ?? ''} />}</Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Type">{(id) => <Select id={id} name="employment_type" defaultValue={profile?.employment_type ?? 'full_time'}>{EMPLOYMENT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</Select>}</Field>
          <Field label="Work mode">{(id) => <Select id={id} name="work_mode" defaultValue={profile?.work_mode ?? 'any'}>{WORK_MODES.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}</Select>}</Field>
          <Field label="Target pay ($/yr or /hr)">{(id) => <Input id={id} name="salary_target" type="number" min={0} step={100} defaultValue={centsToDollars(profile?.salary_target_cents)} />}</Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Location">{(id) => <Input id={id} name="location" defaultValue={profile?.location ?? ''} placeholder="Austin, TX" />}</Field>
          <Field label="Applications per week goal">{(id) => <Input id={id} name="weekly_goal" type="number" min={0} max={100} defaultValue={profile?.weekly_goal ?? 5} />}</Field>
        </div>
        <Field label="Summary / notes">{(id) => <Textarea id={id} name="summary" rows={2} defaultValue={profile?.summary ?? ''} />}</Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={loading}><Check className="h-4 w-4" /> Save profile</Button>
        </div>
      </form>
    </Modal>
  );
}

function ApplicationForm({ familyId, userId, profile, resumes, application, onClose, onSaved }: { familyId: string; userId: string; profile: Profile; resumes: Resume[]; application: Application | null; onClose: () => void; onSaved: () => void }) {
  const { error: toastError } = useToast();
  const [loading, setLoading] = useState(false);
  const [excitement, setExcitement] = useState(application?.excitement ?? 0);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const company = String(f.get('company') ?? '').trim();
    const roleTitle = String(f.get('role_title') ?? '').trim();
    if (!company || !roleTitle) return toastError('Company and role are required');
    const stage = String(f.get('stage') ?? 'saved') as JobStage;
    setLoading(true);
    const appliedOn = String(f.get('applied_on') ?? '') || (stage !== 'saved' ? isoDate(new Date()) : null);
    const payload = {
      company, role_title: roleTitle, stage, source: String(f.get('source') ?? '').trim() || null, url: String(f.get('url') ?? '').trim() || null,
      location: String(f.get('location') ?? '').trim() || null, work_mode: (String(f.get('work_mode') ?? '') || null) as Application['work_mode'],
      salary_min_cents: dollarsToCents(f.get('salary_min')), salary_max_cents: dollarsToCents(f.get('salary_max')),
      applied_on: appliedOn, last_activity_on: isoDate(new Date()), next_step: String(f.get('next_step') ?? '').trim() || null, next_step_on: String(f.get('next_step_on') ?? '') || null,
      contact_name: String(f.get('contact_name') ?? '').trim() || null, contact_email: String(f.get('contact_email') ?? '').trim() || null,
      resume_id: String(f.get('resume_id') ?? '') || null, excitement: excitement || null, notes: String(f.get('notes') ?? '').trim() || null,
    };
    const supabase = createClient();
    const { error } = application
      ? await supabase.from('job_applications').update(payload).eq('id', application.id)
      : await supabase.from('job_applications').insert({ family_id: familyId, profile_id: profile.id, created_by: userId, ...payload });
    setLoading(false);
    if (error) return toastError(describeDbError(error));
    onSaved();
  }

  return (
    <Modal open title={application ? 'Edit application' : 'Add an application'} onClose={onClose}>
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Company" required>{(id) => <Input id={id} name="company" defaultValue={application?.company ?? ''} autoFocus />}</Field>
          <Field label="Role" required>{(id) => <Input id={id} name="role_title" defaultValue={application?.role_title ?? profile.target_roles[0] ?? ''} />}</Field>
        </div>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Stage">{(id) => <Select id={id} name="stage" defaultValue={application?.stage ?? 'saved'}>{JOB_STAGES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</Select>}</Field>
          <Field label="Applied on">{(id) => <Input id={id} name="applied_on" type="date" defaultValue={application?.applied_on ?? ''} />}</Field>
          <Field label="Source">{(id) => <Input id={id} name="source" defaultValue={application?.source ?? ''} placeholder="LinkedIn, referral…" />}</Field>
        </div>
        <Field label="Posting link">{(id) => <Input id={id} name="url" type="url" defaultValue={application?.url ?? ''} placeholder="https://" />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Location">{(id) => <Input id={id} name="location" defaultValue={application?.location ?? ''} />}</Field>
          <Field label="Work mode">{(id) => <Select id={id} name="work_mode" defaultValue={application?.work_mode ?? ''}><option value="">Unknown</option><option value="remote">Remote</option><option value="hybrid">Hybrid</option><option value="onsite">On-site</option></Select>}</Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Salary from ($)">{(id) => <Input id={id} name="salary_min" type="number" min={0} step={100} defaultValue={centsToDollars(application?.salary_min_cents)} />}</Field>
          <Field label="Salary to ($)">{(id) => <Input id={id} name="salary_max" type="number" min={0} step={100} defaultValue={centsToDollars(application?.salary_max_cents)} />}</Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Next step">{(id) => <Input id={id} name="next_step" defaultValue={application?.next_step ?? ''} placeholder="Follow up, phone screen, send portfolio…" />}</Field>
          <Field label="Due">{(id) => <Input id={id} name="next_step_on" type="date" defaultValue={application?.next_step_on ?? ''} />}</Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Contact">{(id) => <Input id={id} name="contact_name" defaultValue={application?.contact_name ?? ''} />}</Field>
          <Field label="Contact email">{(id) => <Input id={id} name="contact_email" type="email" defaultValue={application?.contact_email ?? ''} />}</Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Resume used">{(id) => <Select id={id} name="resume_id" defaultValue={application?.resume_id ?? resumes.find((r) => r.is_primary)?.id ?? ''}><option value="">—</option>{resumes.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}</Select>}</Field>
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted">Excitement</p>
            <div className="flex gap-1" role="radiogroup" aria-label="Excitement">{[1, 2, 3, 4, 5].map((n) => <button type="button" key={n} role="radio" aria-checked={excitement === n} onClick={() => setExcitement(excitement === n ? 0 : n)} className={cn('h-10 w-10 rounded-xl border text-sm coarse:min-h-11', excitement >= n ? 'border-amber-400 bg-amber-500/15 text-amber-200' : 'border-border text-muted')}>★</button>)}</div>
          </div>
        </div>
        <Field label="Notes">{(id) => <Textarea id={id} name="notes" rows={2} defaultValue={application?.notes ?? ''} />}</Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={loading}><Check className="h-4 w-4" /> Save application</Button>
        </div>
      </form>
    </Modal>
  );
}

function ResumeForm({ familyId, userId, profile, resume, isFirst, onClose, onSaved }: { familyId: string; userId: string; profile: Profile; resume: Resume | null; isFirst: boolean; onClose: () => void; onSaved: () => void }) {
  const { error: toastError } = useToast();
  const [loading, setLoading] = useState(false);
  const [body, setBody] = useState(resume?.body ?? '');
  const [keywordsText, setKeywordsText] = useState(resume?.keywords.join(', ') ?? profile.target_keywords.join(', '));
  const live = useMemo(() => atsScore(body, parseKeywords(keywordsText)), [body, keywordsText]);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const title = String(f.get('title') ?? '').trim();
    if (!title) return toastError('Name this version');
    if (!body.trim()) return toastError('Paste the resume text');
    const keywords = parseKeywords(keywordsText);
    const ats = atsScore(body, keywords);
    setLoading(true);
    const payload = {
      title, target_role: String(f.get('target_role') ?? '').trim() || null, body, keywords, ats_score: ats.score, matched_keywords: ats.matched, missing_keywords: ats.missing,
      is_primary: resume ? resume.is_primary : isFirst, notes: String(f.get('notes') ?? '').trim() || null,
    };
    const supabase = createClient();
    const { error } = resume
      ? await supabase.from('resume_versions').update(payload).eq('id', resume.id)
      : await supabase.from('resume_versions').insert({ family_id: familyId, profile_id: profile.id, created_by: userId, ...payload });
    setLoading(false);
    if (error) return toastError(describeDbError(error));
    onSaved();
  }

  return (
    <Modal open title={resume ? 'Edit resume version' : 'New resume version'} description="One version per target role. The score updates as you type." onClose={onClose} className="max-w-3xl">
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Version name" required>{(id) => <Input id={id} name="title" defaultValue={resume?.title ?? ''} placeholder="Ops manager — logistics" autoFocus />}</Field>
          <Field label="Target role">{(id) => <Input id={id} name="target_role" defaultValue={resume?.target_role ?? profile.target_roles[0] ?? ''} />}</Field>
        </div>
        <Field label="Keywords from the posting (comma separated)">{(id) => <Textarea id={id} name="keywords" rows={2} value={keywordsText} onChange={(e) => setKeywordsText(e.target.value)} />}</Field>
        <Field label="Resume text" required>{(id) => <Textarea id={id} name="body" rows={12} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Paste the whole resume as plain text…" className="font-mono text-xs" />}</Field>
        <div className={cn('rounded-xl border p-3 text-sm', live.score >= 75 ? 'border-emerald-500/30 bg-emerald-500/10' : live.score >= 50 ? 'border-amber-500/30 bg-amber-500/10' : 'border-border bg-surface/60')}>
          <p className="font-semibold">ATS score {live.score}/100 <span className="font-normal text-muted">· {live.matched.length}/{parseKeywords(keywordsText).length} keywords · {live.wordCount} words</span></p>
          {live.hints.length > 0 && <ul className="mt-1 space-y-0.5 text-xs text-muted">{live.hints.map((h) => <li key={h}>· {h}</li>)}</ul>}
        </div>
        <Field label="Notes">{(id) => <Textarea id={id} name="notes" rows={2} defaultValue={resume?.notes ?? ''} />}</Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={loading}><Check className="h-4 w-4" /> Save resume</Button>
        </div>
      </form>
    </Modal>
  );
}
