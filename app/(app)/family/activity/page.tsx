import type { Metadata } from 'next';
import { Activity, FileEdit } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { PageHeader } from '@/components/app/page-header';
import { SectionCard, MiniEmpty } from '@/components/family/shell';
import { fmtRelative } from '@/lib/utils/format';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Family Activity' };
export const dynamic = 'force-dynamic';

const VERB: Record<string, string> = { create: 'created', update: 'updated', delete: 'removed', approve: 'approved', skip: 'skipped' };

export default async function FamilyActivityPage() {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const supabase = await createServer();

  const { data: logs } = await supabase
    .from('audit_logs')
    .select('id, action, resource, resource_id, created_at, actor_id')
    .eq('family_id', ctx.active.familyId)
    .order('created_at', { ascending: false })
    .limit(60);

  return (
    <div className="space-y-5">
      <PageHeader title={t('familyActivity.familyActivity')} description="A running log of changes across your household." />
      <SectionCard title={t('familyActivity.recentActivity')}>
        {logs && logs.length > 0 ? (
          <ul className="space-y-1">
            {logs.map((l) => (
              <li key={l.id} className="flex items-center gap-3 rounded-lg px-2 py-2 text-sm hover:bg-surface/40">
                <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-violet-500/15"><FileEdit className="h-4 w-4 text-brand-text" /></div>
                <span className="min-w-0 flex-1">
                  <span className="font-medium capitalize">{VERB[l.action] ?? l.action}</span>{' '}
                  <span className="text-muted">{l.resource.replace(/_/g, ' ')}</span>
                </span>
                <span className="text-xs text-muted">{fmtRelative(l.created_at)}</span>
              </li>
            ))}
          </ul>
        ) : <MiniEmpty icon={Activity} text="No activity recorded yet." />}
      </SectionCard>
    </div>
  );
}
