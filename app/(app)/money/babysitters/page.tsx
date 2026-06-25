import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { isManager } from '@/lib/constants/roles';
import { MoneyNav } from '@/components/money/money-nav';
import { BabysitterView } from '@/components/money/babysitter-view';

export const metadata: Metadata = { title: 'Babysitters — Bubaly Money' };

export default async function BabysittersPage() {
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const manager = isManager(ctx.active.role);
  const supabase = await createServer();

  const [{ data: members }, { data: logs }] = await Promise.all([
    supabase.from('family_members').select('id, display_name, role, color').eq('family_id', familyId).eq('is_active', true),
    supabase.from('wallet_audit_logs')
      .select('id, actor_user_id, entity_id, detail, created_at')
      .eq('family_id', familyId)
      .eq('action', 'babysitter_paid')
      .order('created_at', { ascending: false })
      .limit(50),
  ]);

  const caregivers = (members ?? []).filter((m) => m.role === 'caregiver' || m.role === 'adult');

  return (
    <div className="space-y-6">
      <MoneyNav />
      <BabysitterView
        manager={manager}
        caregivers={caregivers.map((m) => ({ id: m.id, name: m.display_name, role: m.role, color: m.color }))}
        paymentLogs={(logs ?? []).map((l) => {
          let detail: Record<string, unknown> = {};
          try { detail = JSON.parse(l.detail ?? '{}'); } catch {}
          return {
            id: l.id,
            memberId: l.entity_id ?? '',
            amountCents: (detail.amount_cents as number) ?? 0,
            hours: (detail.hours as number) ?? null,
            note: (detail.note as string) ?? null,
            recipient: (detail.recipient as string) ?? '',
            createdAt: l.created_at,
          };
        })}
      />
    </div>
  );
}
