import type { Metadata } from 'next';
import Link from 'next/link';
import { Sparkles, Eye, EyeOff } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { ErrorState } from '@/components/ui/states';
import { Badge } from '@/components/ui/badge';
import type { Tables } from '@/lib/database.types';
import type { AudienceMatch, PersonalizationVariant } from '@/lib/marketing/personalization';
import { createRuleAction, toggleRuleStatusAction, deleteRuleAction } from './actions';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Personalization', robots: { index: false } };
export const dynamic = 'force-dynamic';

type Rule = Tables<'marketing_personalization_rules'>;

const inputCls = 'h-9 w-full rounded-lg border border-border bg-bg px-3 text-sm';
const btnCls = 'h-9 rounded-lg bg-brand px-4 text-sm font-semibold text-white hover:bg-brand/90';

async function ReadFailure() {
  const t = await getTranslations();
  return (
    <div className="space-y-5">
      <h1 className="text-xl font-black sm:text-2xl">{t('personalization.personalization')}</h1>
      <ErrorState message={t('personalization.couldNotLoadPersonalizationRules')} />
      <Link href="/admin/marketing/personalization" className="text-sm font-medium text-brand-text underline">{t('personalization.refreshPersonalization')}</Link>
    </div>
  );
}

function matchSummary(m: AudienceMatch): string {
  const parts: string[] = [];
  if (m.source?.length) parts.push(`source: ${m.source.join('/')}`);
  if (m.medium?.length) parts.push(`medium: ${m.medium.join('/')}`);
  if (m.campaign?.length) parts.push(`campaign: ${m.campaign.join('/')}`);
  if (m.segments?.length) parts.push(`segments: ${m.segments.join('/')}`);
  if (m.paths?.length) parts.push(`path: ${m.paths.join('/')}`);
  if (m.countries?.length) parts.push(`country: ${m.countries.join('/')}`);
  if (typeof m.returning === 'boolean') parts.push(m.returning ? 'returning' : 'new visitor');
  if (m.minSessions) parts.push(`≥${m.minSessions} sessions`);
  return parts.length ? parts.join(' · ') : 'Everyone (default)';
}

export default async function PersonalizationPage() {
  const t = await getTranslations();
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from('marketing_personalization_rules')
    .select('*')
    .is('deleted_at', null)
    .order('slot')
    .order('priority', { ascending: false })
    .limit(300);
  if (error) {
    console.error('[admin-marketing-personalization] rule read failed', error);
    return <ReadFailure />;
  }
  const rules = (data ?? []) as Rule[];

  const bySlot = new Map<string, Rule[]>();
  for (const r of rules) { const a = bySlot.get(r.slot) ?? []; a.push(r); bySlot.set(r.slot, a); }

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted">
        Show different content per audience. The server picks the highest-priority matching rule for a slot and renders its variant; ties break toward the more specific rule. Record exposures via <code>/api/ab/track</code>.
      </p>

      <Card>
        <h2 className="mb-3 flex items-center gap-2 text-base font-semibold"><Sparkles className="h-4 w-4 text-brand-text" /> {t('adminMarketingPersonalization.newRule')}</h2>
        <form action={createRuleAction} className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <input name="name" required placeholder={t('adminMarketingPersonalization.ruleName')} className={`${inputCls} lg:col-span-2`} />
            <input name="slot" required placeholder={t('adminMarketingPersonalization.slotEGHomeHero')} className={inputCls} />
            <input name="priority" type="number" defaultValue={0} placeholder={t('adminMarketingPersonalization.priority')} className={inputCls} />
          </div>
          <p className="text-xs font-medium text-muted">{t('adminMarketingPersonalization.audienceMatchLeaveBlankForEveryone')}</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <input name="source" placeholder={t('adminMarketingPersonalization.utmSourceSCommaSep')} className={inputCls} />
            <input name="medium" placeholder={t('adminMarketingPersonalization.utmMediumS')} className={inputCls} />
            <input name="campaign" placeholder={t('adminMarketingPersonalization.utmCampaignS')} className={inputCls} />
            <input name="segments" placeholder="Segment(s)" className={inputCls} />
            <input name="paths" placeholder={t('adminMarketingPersonalization.pathPrefixEs')} className={inputCls} />
            <input name="countries" placeholder={t('adminMarketingPersonalization.countryCodeS')} className={inputCls} />
            <select name="returning" defaultValue="" className={inputCls} aria-label={t('adminMarketingPersonalization.returning')}>
              <option value="">{t('adminMarketingPersonalization.newOrReturning')}</option>
              <option value="true">{t('adminMarketingPersonalization.returningOnly')}</option>
              <option value="false">{t('adminMarketingPersonalization.newVisitorsOnly')}</option>
            </select>
            <input name="minSessions" type="number" min="0" placeholder={t('adminMarketingPersonalization.minSessions')} className={inputCls} />
          </div>
          <p className="text-xs font-medium text-muted">{t('adminMarketingPersonalization.variantContentOnlyTheFieldsThe')}</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <input name="headline" placeholder={t('adminMarketingPersonalization.headline')} className={inputCls} />
            <input name="subhead" placeholder={t('adminMarketingPersonalization.subhead')} className={inputCls} />
            <input name="cta_label" placeholder={t('adminMarketingPersonalization.ctaLabel')} className={inputCls} />
            <input name="cta_href" placeholder={t('adminMarketingPersonalization.ctaHref')} className={inputCls} />
            <textarea name="body" rows={2} placeholder={t('adminMarketingPersonalization.bodyOptional')} className={`${inputCls} h-auto py-2 sm:col-span-2`} />
          </div>
          <div className="flex items-center gap-3">
            <select name="status" defaultValue="active" className={`${inputCls} w-40`}>
              <option value="active">{t('adminMarketingPersonalization.active')}</option>
              <option value="paused">{t('adminMarketingPersonalization.paused')}</option>
            </select>
            <button type="submit" className={btnCls}>{t('adminMarketingPersonalization.createRule')}</button>
          </div>
        </form>
      </Card>

      {rules.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted">{t('adminMarketingPersonalization.noPersonalizationRulesYet')}</p>
      ) : (
        [...bySlot.entries()].map(([slot, slotRules]) => (
          <Card key={slot}>
            <h2 className="mb-3 text-base font-semibold"><code className="rounded bg-elevated px-1.5 py-0.5 text-sm">{slot}</code> <span className="text-xs font-normal text-muted">({slotRules.length})</span></h2>
            <div className="space-y-2">
              {slotRules.map((r) => {
                const m = (r.match ?? {}) as AudienceMatch;
                const v = (r.variant ?? {}) as PersonalizationVariant;
                return (
                  <div key={r.id} className="flex items-start gap-3 rounded-xl border border-border bg-surface/40 p-3">
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-2 text-sm font-medium">
                        {r.name}
                        <Badge tone="neutral">P{r.priority}</Badge>
                        <Badge tone={r.status === 'active' ? 'success' : 'neutral'}>{r.status === 'active' ? 'Active' : 'Paused'}</Badge>
                      </p>
                      <p className="mt-1 text-xs text-muted">{matchSummary(m)}</p>
                      {(v.headline || v.cta_label) && (
                        <p className="mt-1 truncate text-xs text-fg/80">→ {v.headline ?? ''}{v.cta_label ? ` [${v.cta_label}]` : ''}</p>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <form action={toggleRuleStatusAction.bind(null, r.id, r.status !== 'active')}>
                        <button type="submit" className="text-muted hover:text-fg" title={r.status === 'active' ? 'Pause' : 'Activate'}>
                          {r.status === 'active' ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </button>
                      </form>
                      <form action={deleteRuleAction.bind(null, r.id)}>
                        <button type="submit" className="text-xs text-muted hover:text-rose-400">✕</button>
                      </form>
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        ))
      )}
    </div>
  );
}
