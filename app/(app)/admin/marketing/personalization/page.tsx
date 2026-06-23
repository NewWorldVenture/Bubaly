import type { Metadata } from 'next';
import { Sparkles, Eye, EyeOff } from 'lucide-react';
import { createServiceClient } from '@/lib/supabase/server';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { Tables } from '@/lib/database.types';
import type { AudienceMatch, PersonalizationVariant } from '@/lib/marketing/personalization';
import { createRuleAction, toggleRuleStatusAction, deleteRuleAction } from './actions';

export const metadata: Metadata = { title: 'Personalization', robots: { index: false } };
export const dynamic = 'force-dynamic';

type Rule = Tables<'marketing_personalization_rules'>;

const inputCls = 'h-9 w-full rounded-lg border border-border bg-bg px-3 text-sm';
const btnCls = 'h-9 rounded-lg bg-brand px-4 text-sm font-semibold text-white hover:bg-brand/90';

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
  const supabase = createServiceClient();
  const { data } = await supabase
    .from('marketing_personalization_rules')
    .select('*')
    .is('deleted_at', null)
    .order('slot')
    .order('priority', { ascending: false })
    .limit(300);
  const rules = (data ?? []) as Rule[];

  const bySlot = new Map<string, Rule[]>();
  for (const r of rules) { const a = bySlot.get(r.slot) ?? []; a.push(r); bySlot.set(r.slot, a); }

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted">
        Show different content per audience. The server picks the highest-priority matching rule for a slot and renders its variant; ties break toward the more specific rule. Record exposures via <code>/api/ab/track</code>.
      </p>

      <Card>
        <h2 className="mb-3 flex items-center gap-2 text-base font-semibold"><Sparkles className="h-4 w-4 text-brand" /> New rule</h2>
        <form action={createRuleAction} className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <input name="name" required placeholder="Rule name" className={`${inputCls} lg:col-span-2`} />
            <input name="slot" required placeholder="Slot (e.g. home_hero)" className={inputCls} />
            <input name="priority" type="number" defaultValue={0} placeholder="Priority" className={inputCls} />
          </div>
          <p className="text-xs font-medium text-muted">Audience match (leave blank for everyone; all set conditions must hold)</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <input name="source" placeholder="UTM source(s), comma-sep" className={inputCls} />
            <input name="medium" placeholder="UTM medium(s)" className={inputCls} />
            <input name="campaign" placeholder="UTM campaign(s)" className={inputCls} />
            <input name="segments" placeholder="Segment(s)" className={inputCls} />
            <input name="paths" placeholder="Path prefix(es)" className={inputCls} />
            <input name="countries" placeholder="Country code(s)" className={inputCls} />
            <select name="returning" defaultValue="" className={inputCls} aria-label="Returning">
              <option value="">New or returning</option>
              <option value="true">Returning only</option>
              <option value="false">New visitors only</option>
            </select>
            <input name="minSessions" type="number" min="0" placeholder="Min sessions" className={inputCls} />
          </div>
          <p className="text-xs font-medium text-muted">Variant content (only the fields the slot uses)</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <input name="headline" placeholder="Headline" className={inputCls} />
            <input name="subhead" placeholder="Subhead" className={inputCls} />
            <input name="cta_label" placeholder="CTA label" className={inputCls} />
            <input name="cta_href" placeholder="CTA href" className={inputCls} />
            <textarea name="body" rows={2} placeholder="Body (optional)" className={`${inputCls} h-auto py-2 sm:col-span-2`} />
          </div>
          <div className="flex items-center gap-3">
            <select name="status" defaultValue="active" className={`${inputCls} w-40`}>
              <option value="active">Active</option>
              <option value="paused">Paused</option>
            </select>
            <button type="submit" className={btnCls}>Create rule</button>
          </div>
        </form>
      </Card>

      {rules.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted">No personalization rules yet.</p>
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
