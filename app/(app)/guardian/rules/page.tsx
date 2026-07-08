import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { withGuardianTables } from '@/lib/supabase/guardian-tables';
import { RulesEditor } from '@/components/guardian/rules-editor';
import { Zap, ArrowLeft } from 'lucide-react';

export const metadata: Metadata = { title: 'Routing Rules · AI Call Guardian · Bubaly' };
export const dynamic = 'force-dynamic';

export default async function RulesPage() {
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();
  const db = withGuardianTables(supabase);

  const { data: rules } = await (db.from('guardian_routing_rules') as ReturnType<typeof supabase.from>)
    .select('id, name, description, priority, is_active, ai_suggested, condition_trust_levels, condition_time_start, condition_time_end, condition_days_of_week, condition_contexts, condition_caller_pattern, action_routing_mode')
    .eq('family_id', familyId)
    .order('priority', { ascending: true });

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
          <h1 className="text-xl font-bold leading-tight">Routing Rules</h1>
          <p className="text-sm text-muted">Deterministic rules that override AI decisions</p>
        </div>
      </div>

      <RulesEditor
        rules={(rules ?? []) as unknown as Parameters<typeof RulesEditor>[0]['rules']}
      />
    </div>
  );
}
