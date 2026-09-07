import type { Metadata } from 'next';
import Link from 'next/link';
import { Zap, Bell, Plus, CheckCircle2, Clock, ToggleRight, ToggleLeft } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { isManager } from '@/lib/constants/roles';
import { PageHeader } from '@/components/app/page-header';
import { SectionCard, MiniEmpty, StatTile } from '@/components/family/shell';
import { DeleteButton, AutomationApproval } from '@/components/family/record-actions';
import { fmtRelative } from '@/lib/utils/format';
import { ErrorState } from '@/components/ui/states';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Family Automation' };
export const dynamic = 'force-dynamic';

async function ReadFailure() {
  const t = await getTranslations();
  return (
    <div className="mx-auto max-w-2xl space-y-4 px-4 py-6">
      <h1 className="text-2xl font-bold tracking-tight">{t('familyAutomation.familyLifeAutomation')}</h1>
      <ErrorState message="Could not load family automation data from Supabase. Refresh and try again." />
      <Link href="/dashboard/family-automation" className="text-sm font-medium text-brand-text underline">{t('familyAutomation.refreshFamilyAutomation')}</Link>
    </div>
  );
}

const TRIGGERS = [
  { value: 'task_overdue', label: 'Task overdue' },
  { value: 'chore_missed', label: 'Chore missed' },
  { value: 'appointment_tomorrow', label: 'Appointment tomorrow' },
  { value: 'school_project_due', label: 'School project due' },
  { value: 'practice_scheduled', label: 'Practice scheduled' },
  { value: 'bill_due', label: 'Bill due' },
  { value: 'stress_high', label: 'Stress score high' },
  { value: 'emergency_plan_updated', label: 'Emergency plan updated' },
];
const ACTIONS = [
  { value: 'send_reminder', label: 'Send reminder' },
  { value: 'create_task', label: 'Create task' },
  { value: 'notify_parent', label: 'Notify parent' },
  { value: 'add_calendar_event', label: 'Add calendar event' },
  { value: 'create_ai_summary', label: 'Create AI summary' },
  { value: 'suggest_reschedule', label: 'Suggest reschedule' },
];
const label = (list: { value: string; label: string }[], v: string) => list.find((x) => x.value === v)?.label ?? v;

export default async function FamilyAutomationPage() {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();
  const manager = isManager(ctx.active.role);

  const [rulesResult, pendingResult, recentResult] = await Promise.all([
    supabase.from('family_automation_rules').select('*').eq('family_id', familyId).order('created_at', { ascending: false }),
    supabase.from('family_automation_runs').select('*').eq('family_id', familyId).eq('status', 'pending').order('created_at', { ascending: false }).limit(10),
    supabase.from('family_automation_runs').select('*').eq('family_id', familyId).in('status', ['approved', 'executed', 'skipped']).order('created_at', { ascending: false }).limit(8),
  ]);

  const readError = rulesResult.error ?? pendingResult.error ?? recentResult.error;
  if (readError) {
    console.error('[dashboard-family-automation] required read failed', readError);
    return <ReadFailure />;
  }

  // Two different things live in this table. A ROUTINE (0259) is something a
  // family said in words — "every Sunday, plan our meals" — that the routine
  // worker fires on a schedule. Everything else is a legacy rule whose trigger
  // no code evaluates. Rendering them identically is how a routine came to be
  // described as "When schedule → ai_request", with no next-run time and no
  // sign of the sentence the family actually typed.
  const allRules = rulesResult.data ?? [];
  const routines = allRules.filter((r) => r.schedule_kind);
  const rules = allRules.filter((r) => !r.schedule_kind);
  const pending = pendingResult.data;
  const recent = recentResult.data;

  const enabled = allRules.filter((r) => r.is_enabled).length;

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('dashboardFamilyAutomation.familyLifeAutomation')}
        description="Set rules that watch your real data and act — with parent approval for anything sensitive."
        action={manager ? (
          <Link
            href="/dashboard/concierge"
            className="focus-ring inline-flex items-center gap-1.5 rounded-lg bg-brand px-3 py-2 text-sm font-semibold text-white transition hover:opacity-90"
          >
            <Plus className="h-4 w-4" aria-hidden /> {t('dashboardFamilyAutomation.askBubalyForARoutine')}
          </Link>
        ) : undefined}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label={t('dashboardFamilyAutomation.activeRules')} value={enabled} icon={Zap} accent="bg-violet-600" />
        <StatTile label={t('dashboardFamilyAutomation.totalRules')} value={rules?.length ?? 0} icon={ToggleRight} accent="bg-blue-600" />
        <StatTile label={t('dashboardFamilyAutomation.pendingApproval')} value={pending?.length ?? 0} icon={Clock} accent="bg-orange-500" />
        <StatTile label={t('dashboardFamilyAutomation.recentlyRun')} value={recent?.length ?? 0} icon={CheckCircle2} accent="bg-emerald-600" />
      </div>

      {pending && pending.length > 0 && (
        <SectionCard title={t('dashboardFamilyAutomation.pendingApprovals')} description="The AI proposed these — approve to let them run">
          <ul className="space-y-2.5">
            {pending.map((run) => (
              <li key={run.id} className="flex items-center gap-3 rounded-xl border border-orange-400/20 bg-orange-500/5 p-3">
                <Bell className="h-4 w-4 shrink-0 text-orange-300" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{run.summary ?? 'Proposed automation'}</p>
                  <p className="text-xs text-muted">{run.trigger_type ? label(TRIGGERS, run.trigger_type) : 'Automation'} · {fmtRelative(run.created_at)}</p>
                </div>
                {manager && <AutomationApproval id={run.id} />}
              </li>
            ))}
          </ul>
        </SectionCard>
      )}

      <SectionCard
        title={t('dashboardFamilyAutomation.bubalyRoutines')}
        description="Things you asked Bubaly to do on a schedule. Each one files a request when it is due — it is planned and gated like anything else you ask for."
      >
        {routines.length > 0 ? (
          <ul className="divide-y divide-border">
            {routines.map((r) => (
              <li key={r.id} className="flex items-center gap-3 py-3">
                {r.is_enabled ? <ToggleRight className="h-5 w-5 shrink-0 text-emerald-400" /> : <ToggleLeft className="h-5 w-5 shrink-0 text-muted" />}
                <div className="min-w-0 flex-1">
                  {/* The family's own sentence, not a pair of column values. */}
                  <p className="truncate text-sm font-medium">{r.said || r.name}</p>
                  <p className="text-xs text-muted">
                    {r.is_enabled
                      ? (r.next_run_at ? `Next: ${fmtRelative(r.next_run_at)}` : 'Waiting for something to count back from')
                      : 'Paused'}
                    {r.last_run_at && ` · last ran ${fmtRelative(r.last_run_at)}`}
                  </p>
                </div>
                {manager && <DeleteButton table="family_automation_rules" id={r.id} />}
              </li>
            ))}
          </ul>
        ) : (
          <MiniEmpty icon={Clock} text={manager ? 'No routines yet — ask Bubaly for one, like "every Sunday, plan our meals".' : 'No routines set up.'} />
        )}
      </SectionCard>

      <SectionCard
        title={t('dashboardFamilyAutomation.automationRules')}
        description="Older rules. Their triggers are not evaluated by anything — a routine above is what actually runs."
      >
        {rules && rules.length > 0 ? (
          <ul className="divide-y divide-border">
            {rules.map((r) => (
              <li key={r.id} className="flex items-center gap-3 py-3">
                {r.is_enabled ? <ToggleRight className="h-5 w-5 shrink-0 text-emerald-400" /> : <ToggleLeft className="h-5 w-5 shrink-0 text-muted" />}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{r.name}</p>
                  <p className="text-xs text-muted">
                    When <span className="text-fg/80">{label(TRIGGERS, r.trigger_type)}</span> → <span className="text-fg/80">{label(ACTIONS, r.action_type)}</span>
                    {r.requires_approval && ' · needs approval'}
                  </p>
                </div>
                {manager && <DeleteButton table="family_automation_rules" id={r.id} />}
              </li>
            ))}
          </ul>
        ) : (
          <MiniEmpty icon={Plus} text="No older rules." />
        )}
      </SectionCard>

      {recent && recent.length > 0 && (
        <SectionCard title={t('dashboardFamilyAutomation.recentRuns')}>
          <ul className="divide-y divide-border">
            {recent.map((run) => (
              <li key={run.id} className="flex items-center gap-3 py-2.5 text-sm">
                <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
                <span className="min-w-0 flex-1 truncate">{run.summary ?? 'Automation run'}</span>
                <span className="text-xs capitalize text-muted">{run.status}</span>
                <span className="text-xs text-muted">{fmtRelative(run.created_at)}</span>
              </li>
            ))}
          </ul>
        </SectionCard>
      )}
    </div>
  );
}
