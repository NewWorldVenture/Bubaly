import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { CalmModule } from '@/components/modules/calm-module';
import { buildCalmInbox, type CalmItem, type ItemSeverity } from '@/lib/calm/inbox';

export const metadata: Metadata = { title: 'Calm | Bubaly' };
export const dynamic = 'force-dynamic';

type FoiSuggestion = { id?: string; title?: string; detail?: string; href?: string; impact?: number };

function safe<T>(p: PromiseLike<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  return Promise.resolve(p).then(({ data, error }) => (error ? [] : (data ?? [])));
}

export default async function CalmPage() {
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();
  const now = new Date();
  const in24 = new Date(now.getTime() + 24 * 3_600_000).toISOString();

  const [agentRows, autopilotRows, foiRows, approvalRows, reminderRows] = await Promise.all([
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

  const inbox = buildCalmInbox(items);
  return <CalmModule inbox={inbox} />;
}
