import type { Metadata } from 'next';
import { Trophy, CalendarClock, Users, MapPin, Flag } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { isMissingTableError } from '@/lib/supabase/errors';
import { PageHeader } from '@/components/app/page-header';
import { StatTile, SectionCard, MiniEmpty } from '@/components/family/shell';
import { ErrorState } from '@/components/ui/states';
import { fmtDate, fmtDateTime } from '@/lib/utils/format';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Family Sports' };
export const dynamic = 'force-dynamic';

const RESULT_STYLE: Record<string, string> = { win: 'text-emerald-300', loss: 'text-rose-300', tie: 'text-amber-300' };

export default async function FamilySportsPage() {
  const tr = await getTranslations();
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();
  const now = new Date().toISOString();
  const in14 = new Date(Date.now() + 14 * 86400000).toISOString();

  const [membersRes, teamsRes, gamesRes, eventsRes] = await Promise.all([
    supabase.from('family_members').select('id, display_name').eq('family_id', familyId).eq('is_active', true),
    supabase.from('teams').select('*').eq('family_id', familyId).eq('is_active', true).order('created_at'),
    supabase.from('game_results').select('*').eq('family_id', familyId).order('date', { ascending: false }).limit(6),
    supabase.from('sports_events').select('*').eq('family_id', familyId).gte('starts_at', now).lte('starts_at', in14).order('starts_at').limit(8),
  ]);

  // Teams, game results, and sports events are source-of-truth: a dropped error
  // would render "No teams added yet" / "No game results logged" / "No practices
  // or games scheduled" and a 0-0-0 record for a family that actually has them —
  // a reassuring-but-wrong picture (a parent misses tomorrow's game). Fail closed
  // on a real read error; a genuinely missing table (unapplied migration) is
  // still tolerated as empty.
  const sportsError = [membersRes.error, teamsRes.error, gamesRes.error, eventsRes.error]
    .find((e) => e && !isMissingTableError(e));
  if (sportsError) {
    console.error('[dashboard/family-sports] sports read failed', sportsError);
    return <ErrorState message="Could not load your family sports hub from Supabase. Refresh and try again." />;
  }

  const members = membersRes.data;
  const teams = teamsRes.data;
  const games = gamesRes.data;
  const events = eventsRes.data;

  const nameById = new Map((members ?? []).map((m) => [m.id, m.display_name]));
  const teamById = new Map((teams ?? []).map((t) => [t.id, t.team_name]));
  const record = (games ?? []).reduce((acc, g) => { acc[g.result] = (acc[g.result] ?? 0) + 1; return acc; }, {} as Record<string, number>);

  return (
    <div className="space-y-5">
      <PageHeader title={tr('dashboardFamilySports.familySportsHub')} description="Practices, games, teams and logistics for every athlete in the house." />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile href="/dashboard/sports" label={tr('dashboardFamilySports.activeTeams')} value={teams?.length ?? 0} icon={Users} accent="bg-teal-600" sublabel="Teams" />
        <StatTile href="/dashboard/sports" label={tr('dashboardFamilySports.upcoming14d')} value={events?.length ?? 0} icon={CalendarClock} accent="bg-violet-600" sublabel="Schedule" />
        <StatTile label={tr('dashboardFamilySports.record')} value={`${record.win ?? 0}-${record.loss ?? 0}-${record.tie ?? 0}`} icon={Trophy} accent="bg-amber-500" />
        <StatTile href="/dashboard/sports" label={tr('dashboardFamilySports.recentGames')} value={games?.length ?? 0} icon={Flag} accent="bg-rose-500" sublabel="Results" />
      </div>

      <div className="grid gap-5 md:grid-cols-2">
        <SectionCard title={tr('dashboardFamilySports.practicesGames')} description="Next 14 days" viewAllHref="/dashboard/sports">
          {events && events.length > 0 ? (
            <ul className="divide-y divide-border">
              {events.map((e) => (
                <li key={e.id} className="flex items-center gap-3 py-2.5">
                  <CalendarClock className="h-4 w-4 shrink-0 text-violet-400" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{e.title}</p>
                    <p className="flex items-center gap-1 text-xs text-muted">
                      {[e.member_id ? nameById.get(e.member_id) : null, e.sport, e.team].filter(Boolean).join(' · ')}
                      {e.location && <><MapPin className="h-3 w-3" />{e.location}</>}
                    </p>
                  </div>
                  <span className="text-xs text-muted">{fmtDateTime(e.starts_at)}</span>
                </li>
              ))}
            </ul>
          ) : <MiniEmpty icon={CalendarClock} text="No practices or games scheduled." />}
        </SectionCard>

        <SectionCard title={tr('dashboardFamilySports.recentResults')} viewAllHref="/dashboard/sports">
          {games && games.length > 0 ? (
            <ul className="divide-y divide-border">
              {games.map((g) => (
                <li key={g.id} className="flex items-center gap-3 py-2.5">
                  <Trophy className="h-4 w-4 shrink-0 text-amber-400" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">vs {g.opponent}</p>
                    <p className="text-xs text-muted">{[teamById.get(g.team_id), fmtDate(g.date)].filter(Boolean).join(' · ')}</p>
                  </div>
                  <span className={`text-sm font-bold uppercase ${RESULT_STYLE[g.result]}`}>{g.result} {g.our_score}-{g.their_score}</span>
                </li>
              ))}
            </ul>
          ) : <MiniEmpty icon={Flag} text="No game results logged yet." />}
        </SectionCard>
      </div>

      <SectionCard title={tr('dashboardFamilySports.teams')} viewAllHref="/dashboard/sports">
        {teams && teams.length > 0 ? (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {teams.map((t) => (
              <li key={t.id} className="rounded-xl border border-border bg-surface/40 p-3">
                <p className="text-sm font-semibold">{t.team_name}</p>
                <p className="mt-0.5 text-xs text-muted">{[t.sport, t.season, t.coach && `Coach ${t.coach}`].filter(Boolean).join(' · ')}</p>
                {t.member_id && <p className="mt-1 text-xs text-brand-text">{nameById.get(t.member_id)}</p>}
              </li>
            ))}
          </ul>
        ) : <MiniEmpty icon={Users} text="No teams added yet." />}
      </SectionCard>
    </div>
  );
}
