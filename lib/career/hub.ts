// lib/career/hub.ts — pure, deterministic career engine.
//
// Three problems from the table (resume not good enough, job search is
// exhausting, don't know what career to pursue) share one data model: a
// profile with target roles and keywords, a pipeline of applications, and
// resume versions. Everything here is arithmetic on that data — ATS keyword
// coverage, pipeline stats, follow-up nudges, weekly goal progress, and a
// skills-gap map from the profile's own targets. The AI adds the rewriting.

import type { CareerEmploymentType, CareerStatus, CareerWorkMode, JobStage } from '@/lib/database.types';

export const JOB_STAGES: { value: JobStage; label: string; open: boolean }[] = [
  { value: 'saved', label: 'Saved', open: true }, { value: 'applied', label: 'Applied', open: true }, { value: 'screening', label: 'Screening', open: true },
  { value: 'interview', label: 'Interviewing', open: true }, { value: 'offer', label: 'Offer', open: true },
  { value: 'accepted', label: 'Accepted', open: false }, { value: 'rejected', label: 'Rejected', open: false }, { value: 'withdrawn', label: 'Withdrawn', open: false },
];
export const CAREER_STATUSES: { value: CareerStatus; label: string }[] = [
  { value: 'exploring', label: 'Exploring options' }, { value: 'active_search', label: 'Actively searching' }, { value: 'interviewing', label: 'Interviewing' },
  { value: 'offer', label: 'Weighing an offer' }, { value: 'employed', label: 'Employed, open to better' }, { value: 'paused', label: 'Paused' },
];
export const WORK_MODES: { value: CareerWorkMode; label: string }[] = [
  { value: 'any', label: 'Any' }, { value: 'remote', label: 'Remote' }, { value: 'hybrid', label: 'Hybrid' }, { value: 'onsite', label: 'On-site' },
];
export const EMPLOYMENT_TYPES: { value: CareerEmploymentType; label: string }[] = [
  { value: 'full_time', label: 'Full-time' }, { value: 'part_time', label: 'Part-time' }, { value: 'contract', label: 'Contract' },
  { value: 'internship', label: 'Internship' }, { value: 'first_job', label: 'First job' }, { value: 'any', label: 'Any' },
];
export const stageMeta = (s: JobStage) => JOB_STAGES.find((x) => x.value === s) ?? JOB_STAGES[0];
export const OPEN_STAGES: JobStage[] = JOB_STAGES.filter((s) => s.open).map((s) => s.value);

export type ProfileLike = { id: string; member_id: string; skills: string[]; target_roles: string[]; target_keywords: string[]; status: CareerStatus; weekly_goal: number; salary_target_cents: number | null };
export type ApplicationLike = { id: string; profile_id: string; company: string; role_title: string; stage: JobStage; applied_on: string | null; last_activity_on: string | null; next_step: string | null; next_step_on: string | null; salary_min_cents: number | null; salary_max_cents: number | null; excitement: number | null; created_at: string };
export type ResumeLike = { id: string; profile_id: string; title: string; body: string; keywords: string[]; is_primary: boolean; target_role: string | null };

const DAY_MS = 86_400_000;
const dateOnly = (v: string | Date) => (typeof v === 'string' ? new Date(`${v.slice(0, 10)}T00:00:00`) : new Date(v.getFullYear(), v.getMonth(), v.getDate()));
export const dayDiff = (from: string | Date, to: string | Date) => Math.round((dateOnly(to).getTime() - dateOnly(from).getTime()) / DAY_MS);
export const isoDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Split a keyword line ("react, node.js; SQL") into unique lower-case terms. */
export function parseKeywords(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[,;\n]/)) {
    const k = raw.trim().toLowerCase().replace(/\s+/g, ' ');
    if (k && !out.includes(k)) out.push(k);
  }
  return out;
}

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9+#./ -]/g, ' ').replace(/\s+/g, ' ');

/** Whole-word keyword presence (so "sql" does not match "sqlite" but "node.js" and "c++" work). */
export function containsKeyword(body: string, keyword: string): boolean {
  const b = ` ${normalize(body)} `;
  const k = normalize(keyword).trim();
  if (!k) return false;
  let idx = b.indexOf(k);
  while (idx !== -1) {
    const before = b[idx - 1] ?? ' ';
    const after = b[idx + k.length] ?? ' ';
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true;
    idx = b.indexOf(k, idx + 1);
  }
  return false;
}

export type AtsResult = { score: number; matched: string[]; missing: string[]; wordCount: number; hints: string[] };

/**
 * ATS keyword score: coverage of the target keywords (80 %) plus structure
 * hints (20 %): a summary, quantified results, a skills line, sane length.
 */
export function atsScore(body: string, keywords: string[]): AtsResult {
  const kws = keywords.map((k) => k.trim()).filter(Boolean);
  const matched = kws.filter((k) => containsKeyword(body, k));
  const missing = kws.filter((k) => !matched.includes(k));
  const coverage = kws.length ? matched.length / kws.length : 0;
  const words = body.trim() ? body.trim().split(/\s+/).length : 0;
  const hints: string[] = [];
  let structure = 0;
  if (/\b(summary|profile|about)\b/i.test(body)) structure += 1; else hints.push('Add a 2–3 line summary at the top');
  if (/\d+\s?(%|percent|x\b|\$|k\b|users|customers|clients|team|people|hours|days)/i.test(body)) structure += 1; else hints.push('Quantify at least one result (%, $, time saved, team size)');
  if (/\b(skills|technologies|tools|certifications)\b/i.test(body)) structure += 1; else hints.push('Add a Skills section so keyword scanners find them');
  if (words >= 250 && words <= 900) structure += 1; else hints.push(words < 250 ? 'Too short for a scanner — aim for 350–700 words' : 'Long for one role — trim to under 900 words');
  if (missing.length) hints.unshift(`Missing ${missing.length} of ${kws.length} target keywords: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}`);
  const score = Math.round(coverage * 80 + (structure / 4) * 20);
  return { score: kws.length ? score : Math.round((structure / 4) * 100), matched, missing, wordCount: words, hints };
}

export type PipelineStats = { total: number; open: number; byStage: Record<JobStage, number>; responseRate: number | null; interviewRate: number | null; offers: number; appliedThisWeek: number; weeklyGoal: number; goalPct: number; avgDaysToResponse: number | null };

export function pipelineStats(apps: ApplicationLike[], profile: Pick<ProfileLike, 'id' | 'weekly_goal'>, today: Date): PipelineStats {
  const mine = apps.filter((a) => a.profile_id === profile.id);
  const byStage = Object.fromEntries(JOB_STAGES.map((s) => [s.value, 0])) as Record<JobStage, number>;
  for (const a of mine) byStage[a.stage] += 1;
  const applied = mine.filter((a) => a.stage !== 'saved');
  const responded = applied.filter((a) => ['screening', 'interview', 'offer', 'accepted'].includes(a.stage));
  const interviewed = applied.filter((a) => ['interview', 'offer', 'accepted'].includes(a.stage));
  const weekAgo = isoDate(new Date(today.getTime() - 7 * DAY_MS));
  const appliedThisWeek = applied.filter((a) => a.applied_on && a.applied_on > weekAgo && a.applied_on <= isoDate(today)).length;
  const responseDays = responded.map((a) => (a.applied_on && a.last_activity_on ? dayDiff(a.applied_on, a.last_activity_on) : null)).filter((d): d is number => d !== null && d >= 0);
  return {
    total: mine.length, open: mine.filter((a) => OPEN_STAGES.includes(a.stage)).length, byStage,
    responseRate: applied.length ? Math.round((responded.length / applied.length) * 100) : null,
    interviewRate: applied.length ? Math.round((interviewed.length / applied.length) * 100) : null,
    offers: byStage.offer + byStage.accepted,
    appliedThisWeek, weeklyGoal: profile.weekly_goal, goalPct: profile.weekly_goal ? Math.min(100, Math.round((appliedThisWeek / profile.weekly_goal) * 100)) : 0,
    avgDaysToResponse: responseDays.length ? Math.round(responseDays.reduce((a, b) => a + b, 0) / responseDays.length) : null,
  };
}

export type Nudge<T extends ApplicationLike = ApplicationLike> = { application: T; kind: 'next_step_due' | 'next_step_overdue' | 'stale' | 'no_follow_up'; text: string; days: number };

/** What needs a human today: due next steps, overdue ones, applications going quiet. Generic so full DB rows keep their fields. */
export function followUps<T extends ApplicationLike>(apps: T[], profileId: string, today: Date, staleAfterDays = 10): Nudge<T>[] {
  const todayIso = isoDate(today);
  const out: Nudge<T>[] = [];
  for (const a of apps.filter((x) => x.profile_id === profileId && OPEN_STAGES.includes(x.stage) && x.stage !== 'saved')) {
    if (a.next_step_on) {
      const d = dayDiff(todayIso, a.next_step_on);
      if (d < 0) { out.push({ application: a, kind: 'next_step_overdue', text: `${a.next_step ?? 'Next step'} was due ${-d} day${d === -1 ? '' : 's'} ago`, days: -d }); continue; }
      if (d <= 2) { out.push({ application: a, kind: 'next_step_due', text: d === 0 ? `${a.next_step ?? 'Next step'} today` : `${a.next_step ?? 'Next step'} in ${d} day${d === 1 ? '' : 's'}`, days: d }); continue; }
    }
    const last = a.last_activity_on ?? a.applied_on;
    if (last) {
      const quiet = dayDiff(last, todayIso);
      if (quiet >= staleAfterDays) out.push({ application: a, kind: a.stage === 'applied' ? 'no_follow_up' : 'stale', text: a.stage === 'applied' ? `No reply in ${quiet} days — send a polite follow-up` : `Quiet for ${quiet} days — check in`, days: quiet });
    }
  }
  return out.sort((a, b) => (a.kind === 'next_step_overdue' ? 0 : a.kind === 'next_step_due' ? 1 : 2) - (b.kind === 'next_step_overdue' ? 0 : b.kind === 'next_step_due' ? 1 : 2) || b.days - a.days);
}

/** Salary sanity: how open roles compare with the target. */
export function salaryFit(apps: ApplicationLike[], profileId: string, targetCents: number | null): { withRange: number; atOrAbove: number; below: number; medianMidCents: number | null } {
  const ranged = apps.filter((a) => a.profile_id === profileId && OPEN_STAGES.includes(a.stage) && (a.salary_min_cents !== null || a.salary_max_cents !== null));
  const mids = ranged.map((a) => ((a.salary_min_cents ?? a.salary_max_cents ?? 0) + (a.salary_max_cents ?? a.salary_min_cents ?? 0)) / 2).sort((x, y) => x - y);
  const medianMidCents = mids.length ? Math.round(mids[Math.floor(mids.length / 2)]) : null;
  const atOrAbove = targetCents ? ranged.filter((a) => (a.salary_max_cents ?? a.salary_min_cents ?? 0) >= targetCents).length : 0;
  return { withRange: ranged.length, atOrAbove, below: targetCents ? ranged.length - atOrAbove : 0, medianMidCents };
}

/** Career map: which target roles the profile's skills already cover, and the biggest gaps. */
export type RoleFit = { role: string; keywords: string[]; have: string[]; gap: string[]; fitPct: number };

export const ROLE_KEYWORDS: Record<string, string[]> = {
  'software engineer': ['javascript', 'typescript', 'react', 'node.js', 'sql', 'git', 'testing', 'apis', 'cloud'],
  'data analyst': ['sql', 'excel', 'python', 'tableau', 'statistics', 'dashboards', 'reporting', 'data cleaning'],
  'project manager': ['agile', 'scrum', 'stakeholders', 'roadmap', 'budget', 'risk management', 'jira', 'communication'],
  'product manager': ['roadmap', 'user research', 'metrics', 'prioritization', 'stakeholders', 'a/b testing', 'analytics'],
  'nurse': ['patient care', 'bls', 'medication administration', 'charting', 'epic', 'triage', 'acls'],
  'teacher': ['lesson planning', 'classroom management', 'assessment', 'differentiation', 'iep', 'parent communication'],
  'marketing manager': ['seo', 'content', 'campaigns', 'analytics', 'email marketing', 'brand', 'paid media', 'crm'],
  'accountant': ['gaap', 'reconciliation', 'excel', 'quickbooks', 'financial statements', 'audit', 'tax'],
  'sales representative': ['prospecting', 'crm', 'salesforce', 'pipeline', 'negotiation', 'quota', 'demos'],
  'customer support': ['zendesk', 'ticketing', 'empathy', 'troubleshooting', 'sla', 'knowledge base'],
  'graphic designer': ['figma', 'adobe', 'typography', 'branding', 'layout', 'illustration', 'portfolio'],
  'electrician': ['nec code', 'wiring', 'troubleshooting', 'blueprints', 'safety', 'conduit', 'licensed'],
  'barista': ['customer service', 'pos', 'espresso', 'cash handling', 'food safety', 'teamwork'],
  'lifeguard': ['cpr', 'first aid', 'lifeguard certification', 'swimming', 'safety', 'communication'],
  'retail associate': ['customer service', 'pos', 'inventory', 'merchandising', 'cash handling', 'teamwork'],
  'babysitter': ['cpr', 'first aid', 'childcare', 'reliability', 'communication', 'references'],
};

export function careerMap(profile: Pick<ProfileLike, 'skills' | 'target_roles' | 'target_keywords'>): RoleFit[] {
  const have = new Set(profile.skills.map((s) => s.toLowerCase().trim()));
  const roles = profile.target_roles.length ? profile.target_roles : Object.keys(ROLE_KEYWORDS).slice(0, 5);
  return roles.map((role) => {
    const key = role.toLowerCase().trim();
    const base = ROLE_KEYWORDS[key] ?? Object.entries(ROLE_KEYWORDS).find(([k]) => key.includes(k) || k.includes(key))?.[1] ?? [];
    const keywords = [...new Set([...base, ...profile.target_keywords.map((k) => k.toLowerCase().trim())])];
    const got = keywords.filter((k) => have.has(k) || [...have].some((h) => h.includes(k) || k.includes(h)));
    const gap = keywords.filter((k) => !got.includes(k));
    return { role, keywords, have: got, gap, fitPct: keywords.length ? Math.round((got.length / keywords.length) * 100) : 0 };
  }).sort((a, b) => b.fitPct - a.fitPct);
}

export type CareerSummary = { profiles: number; open: number; interviews: number; offers: number; dueToday: number; overdue: number; text: string };

export function careerSummary(profiles: ProfileLike[], apps: ApplicationLike[], today: Date): CareerSummary {
  let open = 0, interviews = 0, offers = 0, dueToday = 0, overdue = 0;
  for (const p of profiles) {
    const st = pipelineStats(apps, p, today);
    open += st.open; interviews += st.byStage.interview; offers += st.byStage.offer;
    for (const n of followUps(apps, p.id, today)) { if (n.kind === 'next_step_overdue') overdue += 1; else if (n.kind === 'next_step_due' && n.days === 0) dueToday += 1; }
  }
  const text = profiles.length === 0 ? 'No career profiles yet' : offers ? `${offers} offer${offers === 1 ? '' : 's'} on the table` : overdue ? `${overdue} follow-up${overdue === 1 ? '' : 's'} overdue` : interviews ? `${interviews} interview${interviews === 1 ? '' : 's'} in progress` : open ? `${open} open application${open === 1 ? '' : 's'}` : 'Pipeline is empty — add a role';
  return { profiles: profiles.length, open, interviews, offers, dueToday, overdue, text };
}

export const money = (cents: number | null | undefined) => cents === null || cents === undefined ? '—' : `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
