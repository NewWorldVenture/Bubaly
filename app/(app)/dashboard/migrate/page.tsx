import type { Metadata } from 'next';
import { Import, ShieldCheck, Zap, History } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { PageHeader } from '@/components/app/page-header';
import { MigrateWizard } from '@/components/migrate/migrate-wizard';
import { competitorByKey } from '@/lib/migrate/competitors';
import { fmtRelative } from '@/lib/utils/format';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Switch to Bubaly' };
export const dynamic = 'force-dynamic';

export default async function MigratePage() {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const { data: imports } = await supabase
    .from('audit_logs')
    .select('id, action, resource, metadata, created_at')
    .eq('family_id', ctx.active.familyId)
    .eq('resource', 'migration')
    .order('created_at', { ascending: false })
    .limit(5);

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('dashboardMigrate.switchToBubaly')}
        description={t('migrate.bringYourCalendarListsAnd')}
      />

      <div className="grid gap-3 sm:grid-cols-3">
        {[
          { icon: Zap, title: 'No retyping', body: 'Upload your export and we map everything into the right place.' },
          { icon: ShieldCheck, title: 'Private & safe', body: 'Files are parsed in your browser; only the results are saved to your family.' },
          { icon: Import, title: 'Nothing left behind', body: 'Events, tasks, grocery lists and notes all come across.' },
        ].map((c) => (
          <div key={c.title} className="rounded-2xl border border-border bg-surface/40 p-4">
            <div className="flex items-center gap-2"><c.icon className="h-5 w-5 text-brand-text" /><p className="font-semibold">{c.title}</p></div>
            <p className="mt-1 text-sm text-muted">{c.body}</p>
          </div>
        ))}
      </div>

      <MigrateWizard />

      {imports && imports.length > 0 && (
        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <h2 className="mb-3 flex items-center gap-2 font-semibold"><History className="h-4 w-4 text-muted" /> {t('dashboardMigrate.recentImports')}</h2>
          <ul className="divide-y divide-border">
            {imports.map((row) => {
              const meta = (row.metadata ?? {}) as { source?: string; counts?: Record<string, number>; skipped?: number };
              const comp = meta.source ? competitorByKey(meta.source) : null;
              const counts = meta.counts ?? {};
              const total = Object.values(counts).reduce((a, b) => a + (b as number), 0);
              return (
                <li key={row.id} className="flex items-center gap-3 py-2.5 text-sm">
                  <span className="font-medium">{comp?.name ?? meta.source ?? 'Import'}</span>
                  <span className="text-muted">{total} item{total === 1 ? '' : 's'} imported</span>
                  <span className="ml-auto text-xs text-muted">{fmtRelative(row.created_at)}</span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
