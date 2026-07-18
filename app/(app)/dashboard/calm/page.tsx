import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { CalmModule } from '@/components/modules/calm-module';
import { buildCalmInbox, type CalmItem, type ItemSeverity } from '@/lib/calm/inbox';
import { loadFamilyContext } from '@/lib/reasoning/context';
import { reasoningInsights } from '@/lib/reasoning/insights';
import { ErrorState } from '@/components/ui/states';

export const metadata: Metadata = { title: 'Calm | Bubaly' };
export const dynamic = 'force-dynamic';

type FoiSuggestion = { id?: string; title?: string; detail?: string; href?: string; impact?: number };

type ReadResult<T> = { data: T[]; error: unknown | null };

function safe<T>(p: PromiseLike<{ data: T[] | null; error: unknown }>): Promise<ReadResult<T>> {
  return Promise.resolve(p).then(({ data, error }) => ({ data: data ?? [], error: error ?? null }));
}

export default async function CalmPage() {
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

  const readError = [agentResult.error, autopilotResult.error, foiResult.error, approvalResult.error, reminderResult.error].find(Boolean);
  if (readError) {
    console.error('[dashboard-calm] inbox read failed', readError);
    return <ErrorState message="Could not load your Calm inbox from Supabase. Refresh and try again." />;
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
  let reasoning;
  try {
    reasoning = await loadFamilyContext(supabase, familyId);
  } catch (error) {
    console.error('[dashboard-calm] reasoning context read failed', error);
    return <ErrorState message="Could not load your Calm inbox from Supabase. Refresh and try again." />;
  }
  for (const ins of reasoningInsights(reasoning)) {
    items.push({ id: `graph:${ins.id}`, source: 'graph', title: ins.title, detail: ins.detail, href: ins.href, severity: ins.severity });
  }

  const inbox = buildCalmInbox(items);
  return <CalmModule inbox={inbox} />;
}
