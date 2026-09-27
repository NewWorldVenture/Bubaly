import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { settleAll } from '@/lib/supabase/settle';
import { RulesEditor } from '@/components/guardian/rules-editor';
import { ErrorState } from '@/components/ui/states';
import { Zap, ArrowLeft } from 'lucide-react';
import { getTranslations } from '@/lib/i18n/server';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: `${t('guardianRules.routingRules')} · ${t('navLabel.aiCallGuardian')}` };
}
export const dynamic = 'force-dynamic';

export default async function RulesPage() {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();

  // A failed read rendered "no routing rules" — and these rules are the
  // deterministic overrides a family wrote to keep specific callers out. Telling
  // them they have none is the opposite of the truth.
  const [{ data: rules, error }] = await settleAll([supabase.from('guardian_routing_rules')
    .select('id, name, description, priority, is_active, ai_suggested, condition_trust_levels, condition_time_start, condition_time_end, condition_days_of_week, condition_contexts, condition_caller_pattern, action_routing_mode')
    .eq('family_id', familyId)
    .order('priority', { ascending: true })]);

  return (
    <div className="mx-auto max-w-2xl space-y-6 px-4 py-6">
      <div className="flex items-center gap-3">
        <a href="/guardian" aria-label={t('guardian.aiCallGuardian')} className="rounded-lg p-1.5 text-muted hover:bg-surface transition">
          <ArrowLeft className="h-5 w-5" />
        </a>
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-amber-500/15">
          <Zap className="h-5 w-5 text-amber-400" />
        </div>
        <div>
          <h1 className="text-xl font-bold leading-tight">{t('guardianRules.routingRules')}</h1>
          <p className="text-sm text-muted">{t('guardianRules.deterministicRulesThatOverrideAiDecisions')}</p>
        </div>
      </div>

      {error ? <ErrorState message={t('guardianRules.couldnTLoadYourRoutingRules')} /> : (
      <RulesEditor
        rules={(rules ?? []) as unknown as Parameters<typeof RulesEditor>[0]['rules']}
      />
      )}
    </div>
  );
}
