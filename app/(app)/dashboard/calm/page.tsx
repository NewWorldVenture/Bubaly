import type { Metadata } from 'next';
import { PartialReadBanner } from '@/components/ui/partial-read-banner';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { describeReadError } from '@/lib/supabase/settle';
import { CalmModule } from '@/components/modules/calm-module';
import { buildCalmInbox, type CalmItem, type ItemSeverity } from '@/lib/calm/inbox';
import { loadFamilyContext } from '@/lib/reasoning/context';
import { reasoningInsights } from '@/lib/reasoning/insights';

export const metadata: Metadata = { title: 'Calm | Bubaly' };
export const dynamic = 'force-dynamic';

type FoiSuggestion = { id?: string; title?: string; detail?: string; href?: string; impact?: number };

type ReadResult<T> = { data: T[]; error: unknown | null };

function safe<T>(p: PromiseLike<{ data: T[] | null; error: unknown }>): Promise<ReadResult<T>> {
  return Promise.resolve(p).then(({ data, error }) => ({ data: data ?? [], error: error ?? null }));
}

export default async function CalmPage() {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();
  const now = new Date();
  const in24 = new Date(now.getTime() + 24 * 3_600_000).toISOString();

  const [agentResult, autopilotResult, foiResult, approvalResult, reminderResult] = await Promise.all([
    safe(supabase.from('agent_activity').select('id, agent, title, detail, href, severity')
      .eq('family_id', familyId).eq('status', 'active').in('severity', ['action', 'attention']).order('created_at', { ascending: false }).limit(100)),
    safe(supabase.from('autopilot_suggestions').select('id, title, detail, urgency')
      .eq('family_id', familyId).eq('status', 'open').limit(100)),
    safe(supabase.from('family_operating_index').select('suggestions')
      .eq('family_id', familyId).order('as_of_date', { ascending: false }).limit(1)),
    safe(supabase.from('approval_requests').select('id, title')
      .eq('family_id', familyId).eq('status', 'pending').limit(50)),
    safe(supabase.from('reminders').select('id, title, remind_at')
      .eq('family_id', familyId).eq('is_done', false).gte('remind_at', now.toISOString()).lte('remind_at', in24).limit(50)),
  ]);

  const readFailures = ([
    ['agent', agentResult],
    ['autopilot', autopilotResult],
    ['foi', foiResult],
    ['approval', approvalResult],
    ['reminder', reminderResult],
  ] as const)
    .filter(([, res]) => res.error)
    .map(([label, res]) => `${label}: ${describeReadError(res.error)}`);
  const readError = readFailures.length > 0;
  if (readError) {
    // Degraded, not fatal: every consumer below defaults an absent read to an
    // empty list or zero, so one unavailable table costs its own tile rather
    // than the page. Production's migration ledger stops at 0001-0003, so a
    // later table being absent is the normal case there, not an anomaly.
    console.warn('[dashboard-calm] inbox read failed — rendering degraded', readError);
  }

  const agentRows = agentResult.data;
  const autopilotRows = autopilotResult.data;
  const foiRows = foiResult.data;
  const approvalRows = approvalResult.data;
  const reminderRows = reminderResult.data;

  const items: CalmItem[] = [];

  for (const a of agentRows as { id: string; agent: string; title: string; detail: string | null; href: string | null; severity: string }[]) {
    items.push({ id: `agent:${a.id}`, source: 'agent', title: a.title, detail: a.detail, href: a.href, severity: (a.severity as ItemSeverity) });
  }
  for (const s of autopilotRows as { id: string; title: string; detail: string | null; urgency: number }[]) {
    const severity: ItemSeverity = s.urgency >= 3 ? 'action' : s.urgency >= 2 ? 'attention' : 'info';
    items.push({ id: `autopilot:${s.id}`, source: 'autopilot', title: s.title, detail: s.detail, href: '/dashboard/autopilot', severity });
  }
  const foiSuggestions = ((foiRows[0]?.suggestions as FoiSuggestion[] | undefined) ?? []);
  for (const g of foiSuggestions) {
    const impact = g.impact ?? 5;
    const severity: ItemSeverity = impact >= 8 ? 'action' : impact >= 5 ? 'attention' : 'info';
    items.push({ id: `foi:${g.id ?? g.title}`, source: 'operating_index', title: g.title ?? 'Suggestion', detail: g.detail ?? null, href: g.href ?? '/dashboard/family-operating-index', severity });
  }
  for (const r of approvalRows as { id: string; title: string }[]) {
    items.push({ id: `approval:${r.id}`, source: 'approval', title: r.title, detail: 'Someone needs a yes/no.', href: '/dashboard/inbox', severity: 'action' });
  }
  for (const r of reminderRows as { id: string; title: string; remind_at: string }[]) {
    items.push({ id: `reminder:${r.id}`, source: 'reminder', title: r.title, detail: 'Coming up soon.', href: '/dashboard/reminders', severity: 'attention', at: r.remind_at });
  }

  // R2: relationship-level reasoning over the Knowledge Graph (hub risk, ripple,
  // coverage) folded into the same calm inbox — best-effort, so a missing graph
  // never breaks the page.
  // Best-effort, as the comment above says — which the previous `return
  // <ErrorState />` here did not honour: it turned a missing graph into a blank
  // page, the exact outcome the comment ruled out. The graph ADDS insights to an
  // inbox that is already built from five other reads; without it the reader
  // loses those rows and keeps everything else.
  let reasoning;
  try {
    reasoning = await loadFamilyContext(supabase, familyId);
  } catch (error) {
    console.warn('[dashboard-calm] reasoning context read failed — inbox without graph insights', error);
    reasoning = null;
  }
  if (reasoning) {
    for (const ins of reasoningInsights(reasoning)) {
      items.push({ id: `graph:${ins.id}`, source: 'graph', title: ins.title, detail: ins.detail, href: ins.href, severity: ins.severity });
    }
  }

  const inbox = buildCalmInbox(items);
  return (
    <div className="space-y-5">
      <PartialReadBanner title="Some of your inbox could not be loaded:" failures={readFailures} />
      <CalmModule inbox={inbox} />
    </div>
  );
}
