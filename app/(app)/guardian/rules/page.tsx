import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { withGuardianTables } from '@/lib/supabase/guardian-tables';
import { RulesEditor } from '@/components/guardian/rules-editor';
import { Zap, ArrowLeft } from 'lucide-react';
import { getTranslations } from '@/lib/i18n/server';
import { PartialReadBanner } from '@/components/ui/partial-read-banner';
import { describeReadError } from '@/lib/supabase/settle';

export const metadata: Metadata = { title: 'Routing Rules · AI Call Guardian · Bubaly' };
export const dynamic = 'force-dynamic';

export default async function RulesPage() {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();
  const db = withGuardianTables(supabase);

  // The error was discarded here, and `rules ?? []` below turned a REFUSED read
  // into "you have no routing rules". On a call-screening page that is the
  // dangerous direction: a parent checking how their child's calls are handled
  // saw an empty list and had no way to tell it apart from a family that has
  // configured nothing. The banner's own header states the rule this breaks —
  // a zero that means "we could not check" must never read as an all-clear.
  //
  // The page still renders rather than bailing: the editor's actions are
  // per-rule (`createRuleAction`, `toggleRuleAction`, `deleteRuleAction(id)`),
  // never a whole-set save, so a failed read cannot cost the family their
  // existing rules — it could only mislead them, which the banner now prevents.
  // Audit C1-S9-19.
  const { data: rules, error: rulesError } = await (db.from('guardian_routing_rules') as ReturnType<typeof supabase.from>)
    .select('id, name, description, priority, is_active, ai_suggested, condition_trust_levels, condition_time_start, condition_time_end, condition_days_of_week, condition_contexts, condition_caller_pattern, action_routing_mode')
    .eq('family_id', familyId)
    .order('priority', { ascending: true });
  const readFailures = rulesError ? [`guardian_routing_rules: ${describeReadError(rulesError)}`] : [];

  return (
    <div className="mx-auto max-w-2xl space-y-6 px-4 py-6">
      <div className="flex items-center gap-3">
        <a href="/guardian" className="rounded-lg p-1.5 text-muted hover:bg-surface transition">
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

      <PartialReadBanner title={t('shared.someInformationCouldNotBeLoaded')} failures={readFailures} />

      <RulesEditor
        rules={(rules ?? []) as unknown as Parameters<typeof RulesEditor>[0]['rules']}
      />
    </div>
  );
}
