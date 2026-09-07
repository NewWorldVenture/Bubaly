import type { Metadata } from 'next';
import { GraduationCap, BookOpen, CalendarClock, Award, NotebookPen } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { isMissingTableError } from '@/lib/supabase/errors';
import { PageHeader } from '@/components/app/page-header';
import { StatTile, SectionCard, MiniEmpty } from '@/components/family/shell';
import { ErrorState } from '@/components/ui/states';
import { fmtDate, fmtDateTime } from '@/lib/utils/format';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Family School' };
export const dynamic = 'force-dynamic';

export default async function FamilySchoolPage() {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();
  const now = new Date().toISOString();
  const in14 = new Date(Date.now() + 14 * 86400000).toISOString();

  const [membersRes, classesRes, gradesRes, eventsRes] = await Promise.all([
    supabase.from('family_members').select('id, display_name').eq('family_id', familyId).eq('is_active', true),
    supabase.from('school_classes').select('*').eq('family_id', familyId).order('day_of_week'),
    supabase.from('grades').select('*').eq('family_id', familyId).order('date', { ascending: false }).limit(8),
    supabase.from('school_events').select('*').eq('family_id', familyId).gte('starts_at', now).lte('starts_at', in14).order('starts_at').limit(8),
  ]);

  // Classes, grades, and school events are source-of-truth: a dropped error
  // would render "No classes added yet" / "No grades recorded yet" / "No school
  // events" for a family that actually has them — a reassuring-but-wrong picture
  // (a parent believes a kid has no grades). Fail closed on a real read error; a
  // genuinely missing table (unapplied migration) is still tolerated as empty.
  const schoolError = [membersRes.error, classesRes.error, gradesRes.error, eventsRes.error]
    .find((e) => e && !isMissingTableError(e));
  if (schoolError) {
    console.error('[dashboard/family-school] school read failed', schoolError);
    return <ErrorState message={t('familySchool.couldNotLoadYourFamily')} />;
  }

  const members = membersRes.data;
  const classes = classesRes.data;
  const grades = gradesRes.data;
  const events = eventsRes.data;

  const nameById = new Map((members ?? []).map((m) => [m.id, m.display_name]));
  const avgScore = (grades ?? []).filter((g) => g.score != null && g.max_score).length
    ? Math.round((grades ?? []).filter((g) => g.score != null && g.max_score).reduce((s, g) => s + (Number(g.score) / Number(g.max_score)) * 100, 0) / (grades ?? []).filter((g) => g.score != null && g.max_score).length)
    : null;

  return (
    <div className="space-y-5">
      <PageHeader title={t('dashboardFamilySchool.familySchoolHub')} description={t('familySchool.classesGradesProjectsAndParent')} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile href="/dashboard/school" label={t('dashboardFamilySchool.classes')} value={classes?.length ?? 0} icon={BookOpen} accent="bg-blue-600" sublabel="Schedule" />
        <StatTile href="/dashboard/school" label={t('dashboardFamilySchool.schoolEvents')} value={events?.length ?? 0} icon={CalendarClock} accent="bg-violet-600" sublabel="Upcoming" />
        <StatTile href="/dashboard/school" label={t('dashboardFamilySchool.recentGrades')} value={grades?.length ?? 0} icon={Award} accent="bg-emerald-600" sublabel="Gradebook" />
        <StatTile label={t('dashboardFamilySchool.avgScore')} value={avgScore != null ? `${avgScore}%` : '—'} icon={GraduationCap} accent="bg-amber-500" />
      </div>

      <div className="grid gap-5 md:grid-cols-2">
        <SectionCard title={t('dashboardFamilySchool.upcomingSchoolEvents')} viewAllHref="/dashboard/school">
          {events && events.length > 0 ? (
            <ul className="divide-y divide-border">
              {events.map((e) => (
                <li key={e.id} className="flex items-center gap-3 py-2.5">
                  <CalendarClock className="h-4 w-4 shrink-0 text-violet-400" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{e.title}</p>
                    <p className="text-xs text-muted">{[e.member_id ? nameById.get(e.member_id) : null, e.event_type].filter(Boolean).join(' · ')}</p>
                  </div>
                  <span className="text-xs text-muted">{fmtDateTime(e.starts_at)}</span>
                </li>
              ))}
            </ul>
          ) : <MiniEmpty icon={CalendarClock} text={t('familySchool.noSchoolEventsComingUp')} />}
        </SectionCard>

        <SectionCard title={t('dashboardFamilySchool.recentGrades')} viewAllHref="/dashboard/school">
          {grades && grades.length > 0 ? (
            <ul className="divide-y divide-border">
              {grades.map((g) => (
                <li key={g.id} className="flex items-center gap-3 py-2.5">
                  <Award className="h-4 w-4 shrink-0 text-emerald-400" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{g.title ?? g.subject}</p>
                    <p className="text-xs text-muted">{[g.member_id ? nameById.get(g.member_id) : null, g.subject, fmtDate(g.date)].filter(Boolean).join(' · ')}</p>
                  </div>
                  <span className="text-sm font-bold">{g.grade ?? (g.score != null ? `${g.score}/${g.max_score ?? 100}` : '—')}</span>
                </li>
              ))}
            </ul>
          ) : <MiniEmpty icon={NotebookPen} text={t('familySchool.noGradesRecordedYet')} />}
        </SectionCard>
      </div>

      <SectionCard title={t('dashboardFamilySchool.classSchedule')} viewAllHref="/dashboard/school">
        {classes && classes.length > 0 ? (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {classes.map((c) => (
              <li key={c.id} className="rounded-xl border border-border bg-surface/40 p-3">
                <p className="text-sm font-semibold">{c.subject}</p>
                <p className="mt-0.5 text-xs text-muted">{[c.teacher, c.time_slot, c.room].filter(Boolean).join(' · ')}</p>
                {c.member_id && <p className="mt-1 text-xs text-brand-text">{nameById.get(c.member_id)}</p>}
              </li>
            ))}
          </ul>
        ) : <MiniEmpty icon={BookOpen} text={t('familySchool.noClassesAddedYet')} />}
      </SectionCard>
    </div>
  );
}
