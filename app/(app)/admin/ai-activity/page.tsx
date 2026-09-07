import type { Metadata } from 'next';
import { getTranslations } from '@/lib/i18n/server';
import { Bot, AlertTriangle } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { FilterForm, FilterSelect, FilterSearchInput } from '@/components/admin/filter-bar';
import { fmtDate } from '@/lib/utils/format';
import {
  AI_ACTIVITY_PAGE_SIZE, AI_IN_FLIGHT_STATES, AI_REQUEST_STATES,
  listAiActivity, recentAiFeatures, summarizeAiActivity, type AiActivityRow,
} from '@/lib/ai/activity';

// The answer to "Bubaly stopped doing my Sunday meal plan".
//
// Every AI surface that has adopted `withAiRequest` leaves a row saying which
// model answered, how long it took, what it cost and what broke. Nothing read
// those rows until this page, so §33's complaint — "nobody can answer them" —
// was still true with the ledger full.
//
// Guarded by app/(app)/admin/layout.tsx, which redirects anyone who is not a
// super admin BEFORE this renders. That is also why `request_text` is shown:
// support answering a ticket needs the message that failed, and the same text
// already lives in `ai_messages`. It is not shown anywhere a family's own
// members could read another family's.
export const metadata: Metadata = { title: 'Admin · AI Activity', robots: { index: false } };
export const dynamic = 'force-dynamic';

const SUMMARY_WINDOW_HOURS = 24;

const STATUS_TONE: Record<string, 'success' | 'danger' | 'warning' | 'neutral' | 'brand'> = {
  completed: 'success',
  failed: 'danger',
  blocked: 'danger',
  partially_completed: 'warning',
  cancelled: 'neutral',
};

function toneFor(status: string) {
  if (STATUS_TONE[status]) return STATUS_TONE[status];
  return (AI_IN_FLIGHT_STATES as readonly string[]).includes(status) ? 'brand' : 'neutral';
}

function tokensOf(row: AiActivityRow): string {
  const p = row.prompt_tokens ?? 0;
  const c = row.completion_tokens ?? 0;
  // A genuine zero and "the provider told us nothing" are different facts. The
  // streaming assistant reports no usage at all, and a 0 there would read as a
  // free turn.
  if (row.prompt_tokens == null && row.completion_tokens == null) return '—';
  return `${(p + c).toLocaleString()}`;
}

type Params = { searchParams: Promise<{ q?: string; status?: string; feature?: string; family?: string; page?: string }> };

export default async function AdminAIActivityPage({ searchParams }: Params) {
  const t = await getTranslations();
  const sp = await searchParams;
  const supabase = createServiceClient();
  const since = new Date(Date.now() - SUMMARY_WINDOW_HOURS * 3600_000).toISOString();

  const [result, summary, features] = await Promise.all([
    listAiActivity(supabase, {
      status: sp.status,
      feature: sp.feature,
      familyId: sp.family,
      q: sp.q,
      page: Number(sp.page ?? '1'),
    }),
    summarizeAiActivity(supabase, since),
    recentAiFeatures(supabase),
  ]);

  if (!result.ok) return <AIActivityReadError message={result.error} />;
  const { rows, total, page, pageCount, ignoredStatus } = result.data;

  // A bookmarked filter for a feature that has been quiet is still a valid
  // filter, so keep whatever the URL carries even when the recent window has
  // not seen it.
  const featureOptions = [...new Set([...features, ...(sp.feature ? [sp.feature] : [])])].sort();

  const hidden = Object.fromEntries(
    Object.entries({ q: sp.q, status: sp.status, feature: sp.feature, family: sp.family })
      .filter(([, v]) => v !== undefined),
  ) as Record<string, string>;
  const pageHref = (p: number) => `/admin/ai-activity?${new URLSearchParams({ ...hidden, page: String(p) })}`;

  return (
    <div className="module-page">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight sm:text-3xl">
          <Bot className="h-6 w-6 text-brand-text" />{' '}{t('aiActivity.aiActivity')}</h1>
        <p className="mt-1 text-sm text-muted">{t('aiActivity.everyAiRequestAcrossAll')}</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <SummaryTile label={`Failed · last ${SUMMARY_WINDOW_HOURS}h`} value={summary.failed} tone={summary.failed > 0 ? 'danger' : 'neutral'} />
        <SummaryTile label={`In flight · last ${SUMMARY_WINDOW_HOURS}h`} value={summary.inFlight} tone="brand" />
        <SummaryTile label={`Total · last ${SUMMARY_WINDOW_HOURS}h`} value={summary.total} tone="neutral" />
      </div>

      <Card>
        <FilterForm action="/admin/ai-activity" hidden={{ family: sp.family }}>
          <FilterSearchInput name="q" defaultValue={sp.q} placeholder={t('aiActivity.searchByFeatureOrError')} />
          <FilterSelect name="status" defaultValue={sp.status} options={[
            { value: '', label: 'All statuses' },
            ...AI_REQUEST_STATES.map((s) => ({ value: s, label: s.replace(/_/g, ' ') })),
          ]} />
          <FilterSelect name="feature" defaultValue={sp.feature} options={[
            { value: '', label: 'All features' },
            ...featureOptions.map((f) => ({ value: f, label: f })),
          ]} />
        </FilterForm>

        {ignoredStatus && (
          <p className="mt-3 flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-fg">
            <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
            <span>
              <span className="font-mono">{ignoredStatus}</span>{' '}{t('aiActivity.isNotARequestStatus')}</span>
          </p>
        )}

        {sp.family && (
          <p className="mt-3 text-xs text-muted">{t('aiActivity.scopedToFamily')}{' '}<span className="font-mono">{sp.family}</span>.{' '}
            <a href={`/admin/ai-activity?${new URLSearchParams({ ...hidden, family: '' })}`} className="text-brand-text underline">{t('aiActivity.showAllFamilies')}</a>
          </p>
        )}

        {rows.length === 0 ? (
          <div className="mt-6"><EmptyState icon={Bot} title={t('aiActivity.noAiRequestsMatchThese')} /></div>
        ) : (
          <div className="table-responsive mt-4">
            <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted">
                  <th className="px-3 py-2 font-medium">{t('aiActivity.surface')}</th>
                  <th className="px-3 py-2 font-medium">{t('aiActivity.status')}</th>
                  <th className="px-3 py-2 font-medium">{t('aiActivity.model')}</th>
                  <th className="px-3 py-2 font-medium text-right">{t('aiActivity.tokens')}</th>
                  <th className="px-3 py-2 font-medium text-right">{t('aiActivity.latency')}</th>
                  <th className="px-3 py-2 font-medium">{t('aiActivity.family')}</th>
                  <th className="px-3 py-2 font-medium">{t('aiActivity.when')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {rows.map((row) => (
                  <tr key={row.id} className="align-top transition-colors hover:bg-elevated/40">
                    <td className="max-w-[280px] px-3 py-2.5">
                      <p className="font-medium">{row.feature ?? row.kind}</p>
                      <p className="truncate text-xs text-muted" title={row.request_text}>{row.request_text}</p>
                      {row.error && (
                        <p className="mt-1 text-xs text-danger" title={row.error}>{row.error}</p>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <Badge tone={toneFor(row.status)}>{row.status.replace(/_/g, ' ')}</Badge>
                    </td>
                    <td className="px-3 py-2.5 font-mono text-xs text-muted">{row.model ?? '—'}</td>
                    <td className="px-3 py-2.5 text-right font-mono text-xs text-muted">{tokensOf(row)}</td>
                    <td className="px-3 py-2.5 text-right font-mono text-xs text-muted">
                      {row.latency_ms == null ? '—' : `${row.latency_ms.toLocaleString()} ms`}
                    </td>
                    <td className="px-3 py-2.5">
                      <a
                        href={`/admin/ai-activity?${new URLSearchParams({ family: row.family_id })}`}
                        className="block max-w-[120px] truncate font-mono text-xs text-brand-text underline"
                        title={row.family_id}
                      >
                        {row.family_id}
                      </a>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-xs text-muted">
                      <p>{fmtDate(row.created_at, 'MMM d, yyyy')}</p>
                      <p>{fmtDate(row.created_at, 'hh:mm:ss a')}</p>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-muted">
          <span>
            Showing {total === 0 ? 0 : (page - 1) * AI_ACTIVITY_PAGE_SIZE + 1} to{' '}
            {(page - 1) * AI_ACTIVITY_PAGE_SIZE + rows.length} of {total.toLocaleString()} requests
          </span>
          <div className="flex gap-1">
            {page > 1 && (
              <a href={pageHref(page - 1)} className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-elevated">‹</a>
            )}
            {Array.from({ length: Math.min(pageCount, 7) }, (_, i) => i + 1).map((p) => (
              <a key={p} href={pageHref(p)}
                className={`flex h-8 w-8 items-center justify-center rounded-lg text-xs font-medium ${p === page ? 'bg-brand text-brand-fg' : 'hover:bg-elevated'}`}>
                {p}
              </a>
            ))}
            {page < pageCount && (
              <a href={pageHref(page + 1)} className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-elevated">›</a>
            )}
          </div>
        </div>
      </Card>

      <p className="text-xs text-muted">{t('aiActivity.surfacesThatHaveNotAdopted')}{' '}<span className="font-mono">withAiRequest</span>{' '}{t('aiActivity.leaveNoRowHereAt')}{' '}<span className="font-mono">tests/ai-observability-coverage.test.ts</span>.
      </p>
    </div>
  );
}

function SummaryTile({ label, value, tone }: { label: string; value: number; tone: 'danger' | 'brand' | 'neutral' }) {
  const colour = tone === 'danger' ? 'text-danger' : tone === 'brand' ? 'text-brand-text' : 'text-fg';
  return (
    <Card className="p-4">
      <p className="text-xs text-muted">{label}</p>
      <p className={`mt-1 text-2xl font-bold tabular-nums ${colour}`}>{value.toLocaleString()}</p>
    </Card>
  );
}

async function AIActivityReadError({ message }: { message: string }) {
  const t = await getTranslations();
  return (
    <div className="module-page">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight sm:text-3xl">
          <Bot className="h-6 w-6 text-brand-text" />{' '}{t('aiActivity.aiActivity')}</h1>
      </div>
      {/* An empty table and a broken query look the same to a reader, and one of
          them means "Bubaly is fine". */}
      <ErrorState message={message} />
      <a href="/admin/ai-activity" className="text-sm font-medium text-brand-text underline">{t('aiActivity.tryAgain')}</a>
    </div>
  );
}
