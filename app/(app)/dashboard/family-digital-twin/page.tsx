import type { Metadata } from 'next';
import { Brain, Repeat, BookOpen, Trophy, Target, Sparkles } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { isManager } from '@/lib/constants/roles';
import { PageHeader } from '@/components/app/page-header';
import { SectionCard, MiniEmpty } from '@/components/family/shell';
import { QuickAdd } from '@/components/family/quick-add';
import { Avatar } from '@/components/ui/avatar';
import { DecisionSimulator } from '@/components/twin/decision-simulator';
import { ActivityProjection, type SavedSim } from '@/components/twin/activity-projection';
import { ErrorState } from '@/components/ui/states';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Family Digital Twin' };
export const dynamic = 'force-dynamic';

export default async function FamilyDigitalTwinPage() {
  const tr = await getTranslations();
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();
  const manager = isManager(ctx.active.role);

  const [membersRes, { data: profiles }, { data: routines }, { data: classes }, { data: teams }, { data: goals }, { data: budgets }] = await Promise.all([
    supabase.from('family_members').select('*').eq('family_id', familyId).eq('is_active', true).order('created_at'),
    supabase.from('family_digital_twin_profiles').select('*').eq('family_id', familyId),
    supabase.from('family_routines').select('member_id, title').eq('family_id', familyId).eq('status', 'active'),
    supabase.from('school_classes').select('member_id, subject').eq('family_id', familyId),
    supabase.from('teams').select('member_id, sport').eq('family_id', familyId).eq('is_active', true),
    supabase.from('goals').select('id, title').eq('family_id', familyId).eq('is_complete', false).limit(20),
    supabase.from('budgets').select('category').eq('family_id', familyId).order('category'),
  ]);

  // The member roster is the source-of-truth spine of this page — every card,
  // the decision simulator, and the activity projection hang off it. A dropped
  // error would collapse to "No family members yet" for a populated family (a
  // confidently-wrong empty state), so fail closed here. The per-member
  // enrichment reads below (profiles, routines, classes, teams, goals, budgets)
  // stay best-effort — each legitimately degrades to an empty section.
  if (membersRes.error) {
    console.error('[dashboard/family-digital-twin] member read failed', membersRes.error);
    return <ErrorState message="Could not load your family from Supabase. Refresh and try again." />;
  }
  const members = membersRes.data;
  const { data: savedSimRows } = await supabase
    .from('twin_simulations').select('id, activity_name, verdict, weekly_hours, created_at')
    .eq('family_id', familyId).order('created_at', { ascending: false }).limit(20);
  const savedSims: SavedSim[] = (savedSimRows ?? []).map((s) => ({
    id: s.id, activityName: s.activity_name, verdict: s.verdict, weeklyHours: Number(s.weekly_hours), createdAt: s.created_at,
  }));
  const budgetCategories = [...new Set((budgets ?? []).map((b) => b.category).filter(Boolean))];
  const memberList = (members ?? []).map((m) => ({ id: m.id, display_name: m.display_name }));

  const profileByMember = new Map((profiles ?? []).map((p) => [p.member_id, p]));
  const group = <T extends { member_id: string | null }>(rows: T[] | null) => {
    const m = new Map<string, T[]>();
    for (const r of rows ?? []) {
      if (!r.member_id) continue;
      const arr = m.get(r.member_id) ?? [];
      arr.push(r); m.set(r.member_id, arr);
    }
    return m;
  };
  const routinesByMember = group(routines);
  const classesByMember = group(classes);
  const teamsByMember = group(teams);

  return (
    <div className="space-y-5">
      <PageHeader
        title={tr('dashboardFamilyDigitalTwin.familyDigitalTwin')}
        description="A living model of each family member — preferences, responsibilities and AI insights that power the whole platform."
      />

      {memberList.length > 0 && <DecisionSimulator members={memberList} budgetCategories={budgetCategories} />}

      {memberList.length > 0 && <ActivityProjection members={memberList} budgetCategories={budgetCategories} saved={savedSims} />}

      <div className="grid gap-5 lg:grid-cols-2">
        {(members ?? []).map((m) => {
          const profile = profileByMember.get(m.id);
          const r = routinesByMember.get(m.id) ?? [];
          const c = classesByMember.get(m.id) ?? [];
          const t = teamsByMember.get(m.id) ?? [];
          return (
            <SectionCard key={m.id} title={m.display_name} description={m.role}>
              <div className="flex items-start gap-4">
                <Avatar name={m.display_name} color={m.color} size={48} />
                <div className="min-w-0 flex-1 space-y-3">
                  <div className="flex flex-wrap gap-2 text-xs">
                    <span className="inline-flex items-center gap-1 rounded-full bg-violet-500/15 px-2.5 py-1 text-brand-text"><Repeat className="h-3 w-3" /> {r.length} routines</span>
                    <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/15 px-2.5 py-1 text-blue-300"><BookOpen className="h-3 w-3" /> {c.length} classes</span>
                    <span className="inline-flex items-center gap-1 rounded-full bg-teal-500/15 px-2.5 py-1 text-teal-300"><Trophy className="h-3 w-3" /> {t.length} teams</span>
                  </div>
                  {profile?.strengths && <p className="text-sm"><span className="text-muted">Strengths: </span>{profile.strengths}</p>}
                  {profile?.ai_insights ? (
                    <p className="flex items-start gap-2 rounded-xl bg-surface/40 p-3 text-sm text-fg/90">
                      <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-brand-text" /> {profile.ai_insights}
                    </p>
                  ) : (
                    <p className="text-xs text-muted">{tr('familyDigitalTwin.noAiInsightsCapturedYet')}</p>
                  )}
                  {(r.length > 0 || c.length > 0 || t.length > 0) && (
                    <p className="text-xs text-muted">
                      {[...r.map((x) => x.title), ...c.map((x) => x.subject), ...t.map((x) => x.sport)].slice(0, 4).join(' · ')}
                    </p>
                  )}
                </div>
              </div>
            </SectionCard>
          );
        })}
        {(members ?? []).length === 0 && <MiniEmpty icon={Brain} text="No family members yet." />}
      </div>

      {manager && (
        <SectionCard
          title={tr('dashboardFamilyDigitalTwin.captureAnInsight')}
          description="Add what you know about a member — it sharpens recommendations everywhere."
        >
          <QuickAdd
            table="family_digital_twin_profiles"
            title={tr('dashboardFamilyDigitalTwin.addUpdateProfile')}
            members={(members ?? []).map((m) => ({ id: m.id, display_name: m.display_name }))}
            fields={[
              { name: 'member_id', label: 'Member', type: 'member', required: true },
              { name: 'strengths', label: 'Strengths', type: 'text', placeholder: 'Loves reading, great with little ones' },
              { name: 'ai_insights', label: 'Insight / note', type: 'textarea', placeholder: 'Best focus time is early morning…' },
              { name: 'stress_baseline', label: 'Stress baseline (0-100)', type: 'number' },
            ]}
          />
        </SectionCard>
      )}

      <SectionCard title={tr('dashboardFamilyDigitalTwin.openFamilyGoals')} viewAllHref="/dashboard/goals">
        {goals && goals.length > 0 ? (
          <ul className="grid gap-2 sm:grid-cols-2">
            {goals.map((g) => (
              <li key={g.id} className="flex items-center gap-2 rounded-xl bg-surface/40 p-3 text-sm"><Target className="h-4 w-4 text-violet-400" /> {g.title}</li>
            ))}
          </ul>
        ) : <MiniEmpty icon={Target} text="No active goals." />}
      </SectionCard>
    </div>
  );
}
