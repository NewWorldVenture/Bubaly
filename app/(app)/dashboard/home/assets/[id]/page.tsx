// One asset, whole: coverage, paperwork, what has been done to it, what is
// still owed on it, and what is happening in its room. Every panel is composed
// from persisted rows by `lib/home/asset-detail.ts`; nothing here infers.
//
// Fail-closed: if any of those reads errors, the page renders the unavailable
// state with a retry link rather than a page full of confident empty panels. A
// family that reads "no open maintenance" believes the furnace is fine.
//
// Reached by link from the asset card on /dashboard/home — deliberately not
// added to the sidebar.
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ArrowLeft, CalendarClock, FileText, Hammer, Home, Package, Shield, Wrench,
} from 'lucide-react';
import { requirePlanLevel } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { getTranslations } from '@/lib/i18n/server';
import { loadAssetDetail, type CoverageState, type CoverageView } from '@/lib/home/asset-detail';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { fmtDate } from '@/lib/utils/format';

export const dynamic = 'force-dynamic';

const HOME_PATH = '/dashboard/home';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations();
  return { title: t('homeAsset.assetDetails') };
}

/** Badge tone per coverage state. `unknown` is neutral, never a green tick. */
const COVERAGE_TONE: Record<CoverageState, 'success' | 'warning' | 'danger' | 'neutral'> = {
  active: 'success',
  expiring: 'warning',
  expired: 'danger',
  unknown: 'neutral',
};

const COVERAGE_LABEL_KEY: Record<CoverageState, string> = {
  active: 'homeAsset.covered',
  expiring: 'homeAsset.endingSoon',
  expired: 'homeAsset.expired',
  unknown: 'homeAsset.noEndDateRecorded',
};

function day(value: string | null): string {
  return value ? fmtDate(value, 'MMM d, yyyy') : '';
}

function Row({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 text-sm">
      <span className="text-muted">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  );
}

function SectionHeading({ icon: Icon, title, count }: {
  icon: React.ComponentType<{ className?: string }>; title: string; count?: number;
}) {
  return (
    <div className="mb-4 flex items-center justify-between">
      <h2 className="flex items-center gap-2 text-base font-semibold">
        <Icon className="h-4 w-4 text-brand-text" /> {title}
      </h2>
      {typeof count === 'number' && <Badge tone="neutral">{count}</Badge>}
    </div>
  );
}

export default async function AssetDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const t = await getTranslations();
  const { id } = await params;
  const ctx = await requirePlanLevel(1);
  const supabase = await createServer();

  const result = await loadAssetDetail(supabase, { familyId: ctx.active.familyId, assetId: id });

  if (result.status === 'not_found') notFound();

  if (result.status === 'error') {
    // The reason is already in the server log (`[home/asset-detail] … read
    // failed`); the family gets the honest sentence and a way to retry.
    return (
      <div className="space-y-4">
        <Link href={HOME_PATH} className="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-muted hover:text-fg focus-ring">
          <ArrowLeft className="h-4 w-4" aria-hidden /> {t('homeAsset.backToHomeMaintenance')}
        </Link>
        <ErrorState message={t('homeAsset.couldNotLoadThisAsset')} />
        <Link href={`${HOME_PATH}/assets/${id}`} className="inline-flex min-h-11 items-center text-sm font-medium text-brand-text underline focus-ring">
          {t('states.tryAgain')}
        </Link>
      </div>
    );
  }

  const {
    asset, coverage, manuals, warrantyDocuments, otherDocuments,
    serviceHistory, openMaintenance, relatedProjects, roomLabel,
  } = result.detail;
  const documents = [
    ...manuals.map((d) => ({ doc: d, kindKey: 'homeAsset.manual' })),
    ...warrantyDocuments.map((d) => ({ doc: d, kindKey: 'homeAsset.warranty' })),
    ...otherDocuments.map((d) => ({ doc: d, kindKey: 'homeAsset.file' })),
  ];
  const filesHref = `${HOME_PATH}?asset=${asset.id}`;

  return (
    <div className="space-y-4">
      <Link href={HOME_PATH} className="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-muted hover:text-fg focus-ring">
        <ArrowLeft className="h-4 w-4" aria-hidden /> {t('homeAsset.backToHomeMaintenance')}
      </Link>

      <div className="flex items-start gap-3">
        <div className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand-text">
          <Home className="h-5 w-5" aria-hidden />
        </div>
        <div className="min-w-0">
          <h1 className="text-xl font-bold tracking-tight sm:text-2xl">{asset.name}</h1>
          <p className="text-sm text-muted">
            {[asset.brand, asset.model, asset.location].filter(Boolean).join(' · ')}
          </p>
        </div>
      </div>

      {/* Warranty coverage */}
      <Card>
        <SectionHeading icon={Shield} title={t('homeAsset.warrantyCoverage')} />
        {!coverage ? (
          <EmptyState icon={Shield} title={t('homeAsset.noWarrantyRecorded')} />
        ) : (
          <CoveragePanel coverage={coverage} label={t(COVERAGE_LABEL_KEY[coverage.state])}
            endsLabel={coverage.expiresOn ? t('homeAsset.endsOn', { date: day(coverage.expiresOn) }) : null}
            claimLabel={t('homeAsset.claimLine')}
            fromAssetNote={coverage.source === 'home_assets' ? t('homeAsset.fromTheAssetsOwnWarrantyDate') : null}
          />
        )}
        <div className="mt-3 space-y-0.5 border-t border-border pt-3">
          <Row label={t('home.category')} value={asset.category} />
          <Row label={t('home.location')} value={asset.location} />
          <Row label={t('homeAsset.serialNumber')} value={asset.serial_number} />
          <Row label={t('homeAsset.installed')} value={day(asset.installed_on)} />
          <Row label={t('homeAsset.purchased')} value={day(asset.purchased_on)} />
          <Row label={t('homeAsset.lastServiced')} value={day(asset.last_serviced_on)} />
        </div>
      </Card>

      {/* Manuals and paperwork */}
      <Card>
        <SectionHeading icon={FileText} title={t('homeAsset.manualsAndPaperwork')} count={documents.length} />
        {documents.length === 0 ? (
          <EmptyState icon={FileText} title={t('homeAsset.noDocumentsAttachedYet')} />
        ) : (
          <ul className="space-y-2">
            {documents.map(({ doc, kindKey }) => (
              <li key={doc.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-surface/40 px-3 py-2.5">
                <FileText className="h-4 w-4 shrink-0 text-brand-text" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{doc.title}</p>
                  <p className="text-xs text-muted">
                    {t('homeAsset.added', { date: day(doc.createdAt) })}
                    {doc.expiresAt ? ` · ${t('homeAsset.expiresOn', { date: day(doc.expiresAt) })}` : ''}
                  </p>
                </div>
                <Badge tone="neutral">{t(kindKey)}</Badge>
              </li>
            ))}
          </ul>
        )}
        <Link href={filesHref} className="mt-3 inline-flex min-h-11 items-center text-sm font-medium text-brand-text underline focus-ring">
          {t('homeAsset.openFilesOnTheAssetCard')}
        </Link>
      </Card>

      {/* Service history */}
      <Card>
        <SectionHeading icon={Wrench} title={t('homeAsset.serviceHistory')} count={serviceHistory.length} />
        {serviceHistory.length === 0 ? (
          <EmptyState icon={Wrench} title={t('homeAsset.noServiceRecordedYet')} />
        ) : (
          <ul className="space-y-2">
            {serviceHistory.map((record) => (
              <li key={record.id} className="rounded-xl border border-border bg-surface/40 px-3 py-2.5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-sm font-medium">{record.title}</p>
                  <span className="text-xs text-muted">{day(record.serviceDate)}</span>
                </div>
                {record.provider && <p className="text-xs text-muted">{record.provider}</p>}
                {record.description && <p className="mt-1 text-sm text-muted">{record.description}</p>}
                {record.nextDueOn && (
                  <p className="mt-1 text-xs text-muted">{t('homeAsset.nextDue', { date: day(record.nextDueOn) })}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Open maintenance */}
      <Card>
        <SectionHeading icon={CalendarClock} title={t('homeAsset.openMaintenance')} count={openMaintenance.length} />
        {openMaintenance.length === 0 ? (
          <EmptyState icon={CalendarClock} title={t('homeAsset.noOpenMaintenance')} />
        ) : (
          <ul className="space-y-2">
            {openMaintenance.map((task) => (
              <li key={task.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-surface/40 px-3 py-2.5">
                <Package className="h-4 w-4 shrink-0 text-warning" aria-hidden />
                <p className="min-w-0 flex-1 truncate text-sm font-medium">{task.title}</p>
                <span className="text-xs text-muted">
                  {task.dueAt ? t('homeAsset.due', { date: day(task.dueAt) }) : t('homeAsset.noDueDate')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Projects in the same room */}
      <Card>
        <SectionHeading
          icon={Hammer}
          title={roomLabel ? t('homeAsset.projectsIn', { room: roomLabel }) : t('homeAsset.projectsInThisRoom')}
          count={relatedProjects.length}
        />
        {!roomLabel ? (
          <EmptyState icon={Hammer} title={t('homeAsset.addALocationToSeeProjects')} />
        ) : relatedProjects.length === 0 ? (
          <EmptyState icon={Hammer} title={t('homeAsset.noProjectsInThisRoom')} />
        ) : (
          <ul className="space-y-2">
            {relatedProjects.map((project) => (
              <li key={project.id}>
                <Link
                  href="/dashboard/projects"
                  className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-surface/40 px-3 py-2.5 hover:bg-elevated focus-ring"
                >
                  <Hammer className="h-4 w-4 shrink-0 text-brand-text" aria-hidden />
                  <p className="min-w-0 flex-1 truncate text-sm font-medium">{project.title}</p>
                  {project.targetStart && <span className="text-xs text-muted">{day(project.targetStart)}</span>}
                </Link>
              </li>
            ))}
          </ul>
        )}
        {roomLabel && <p className="mt-3 text-xs text-muted">{t('homeAsset.matchedByRoomNotByALink')}</p>}
      </Card>
    </div>
  );
}

function CoveragePanel({ coverage, label, endsLabel, claimLabel, fromAssetNote }: {
  coverage: CoverageView;
  label: string;
  endsLabel: string | null;
  claimLabel: string;
  fromAssetNote: string | null;
}) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={COVERAGE_TONE[coverage.state]}>{label}</Badge>
        {endsLabel && <span className="text-sm text-muted">{endsLabel}</span>}
      </div>
      {coverage.name && <p className="text-sm font-medium">{coverage.name}</p>}
      {coverage.provider && <p className="text-sm text-muted">{coverage.provider}</p>}
      {coverage.claimPhone && (
        <p className="text-sm text-muted">
          {claimLabel}: <a href={`tel:${coverage.claimPhone}`} className="font-medium text-brand-text underline">{coverage.claimPhone}</a>
        </p>
      )}
      {fromAssetNote && <p className="text-xs text-muted">{fromAssetNote}</p>}
    </div>
  );
}
