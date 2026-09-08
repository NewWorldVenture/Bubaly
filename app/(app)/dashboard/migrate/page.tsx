import type { Metadata } from 'next';
import { Import, ShieldCheck, Zap, History } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { PageHeader } from '@/components/app/page-header';
import { MigrateWizard } from '@/components/migrate/migrate-wizard';
import { competitorByKey } from '@/lib/migrate/competitors';
import { fmtRelative } from '@/lib/utils/format';
import { ErrorState } from '@/components/ui/states';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Switch to Bubaly' };
export const dynamic = 'force-dynamic';

export default async function MigratePage() {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const { data: imports, error: importsError } = await supabase
    .from('audit_logs')
    .select('id, action, resource, metadata, created_at')
    .eq('family_id', ctx.active.familyId)
    .eq('resource', 'migration')
    .order('created_at', { ascending: false })
    .limit(5);
  // Fail closed: "no recent imports" and "we could not read your imports" look
  // identical to a person, and the first is a claim about their data.
  if (importsError) console.error('[dashboard/migrate] recent imports read failed', importsError);

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('dashboardMigrate.switchToBubaly')}
        description={t('migrate.bringYourCalendarListsAnd')}
      />

      <div className="grid gap-3 sm:grid-cols-3">
        {[
          { icon: Zap, key: 'noRetyping', title: t('dashboardMigrate.noRetypingTitle'), body: t('dashboardMigrate.noRetypingBody') },
          { icon: ShieldCheck, key: 'private', title: t('dashboardMigrate.privateAndSafeTitle'), body: t('dashboardMigrate.privateAndSafeBody') },
          // Was "Nothing left behind", which claimed more than the importer does:
          // files, photos, recipes and app settings do not come across, and saying
          // so here is cheaper than a family discovering it after switching.
          { icon: Import, key: 'whatComes', title: t('dashboardMigrate.whatComesAcrossTitle'), body: t('dashboardMigrate.whatComesAcrossBody') },
        ].map((c) => (
          <div key={c.key} className="rounded-2xl border border-border bg-surface/40 p-4">
            <div className="flex items-center gap-2"><c.icon className="h-5 w-5 text-brand-text" /><p className="font-semibold">{c.title}</p></div>
            <p className="mt-1 text-sm text-muted">{c.body}</p>
          </div>
        ))}
      </div>

      <MigrateWizard />

      {importsError && <ErrorState message={t('dashboardMigrate.couldNotLoadYourRecentImports')} />}

      {!importsError && imports && imports.length > 0 && (
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
                  <span className="font-medium">{comp?.name ?? meta.source ?? t('dashboardMigrate.anImport')}</span>
                  <span className="text-muted">{t('dashboardMigrate.itemsImported', { count: total })}</span>
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
