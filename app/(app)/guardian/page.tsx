import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { withGuardianTables } from '@/lib/supabase/guardian-tables';
import { isTwilioConfigured } from '@/lib/guardian/twilio';
import { GuardianDashboard } from '@/components/guardian/guardian-dashboard';
import { Shield } from 'lucide-react';

export const metadata: Metadata = { title: 'AI Call Guardian · Bubaly' };
export const dynamic = 'force-dynamic';

export default async function GuardianPage() {
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();
  const db = withGuardianTables(supabase);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const gFrom = (table: Parameters<typeof db.from>[0]) => (db.from(table) as ReturnType<typeof supabase.from>);

  const [
    { data: recentComms },
    { data: suggestions },
    { data: escalations },
    { data: memberProfiles },
    { count: totalCalls },
    { count: blockedToday },
    { count: scamsBlocked },
    { count: screened },
  ] = await Promise.all([
    gFrom('guardian_communications')
      .select('id, comm_type, from_number, from_name, summary, body, trust_level_at_time, routing_mode_used, scam_detected, scam_type, status, started_at, ai_decision_reason')
      .eq('family_id', familyId)
      .order('started_at', { ascending: false })
      .limit(20),

    gFrom('guardian_suggestions')
      .select('id, suggestion_type, title, reasoning, proposed_trust_level')
      .eq('family_id', familyId)
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(5),

    gFrom('guardian_escalations')
      .select('id, escalation_type, severity, description, caller_number, acknowledged_at, escalated_at')
      .eq('family_id', familyId)
      .order('escalated_at', { ascending: false })
      .limit(10),

    gFrom('guardian_member_profiles')
      .select('id, member_id, current_context, ai_persona_name, guardian_phone')
      .eq('family_id', familyId)
      .eq('is_active', true),

    gFrom('guardian_communications')
      .select('*', { count: 'exact', head: true })
      .eq('family_id', familyId)
      .gte('started_at', today.toISOString()),

    gFrom('guardian_communications')
      .select('*', { count: 'exact', head: true })
      .eq('family_id', familyId)
      .eq('status', 'blocked')
      .gte('started_at', today.toISOString()),

    gFrom('guardian_communications')
      .select('*', { count: 'exact', head: true })
      .eq('family_id', familyId)
      .eq('scam_detected', true)
      .gte('started_at', today.toISOString()),

    gFrom('guardian_communications')
      .select('*', { count: 'exact', head: true })
      .eq('family_id', familyId)
      .eq('status', 'screening')
      .gte('started_at', today.toISOString()),
  ]);

  return (
    <div className="mx-auto max-w-2xl space-y-6 px-4 py-6">
      <div className="flex items-start gap-3">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand/15">
          <Shield className="h-5 w-5 text-brand-text" />
        </div>
        <div>
          <h1 className="text-xl font-bold leading-tight">AI Call Guardian™</h1>
          <p className="text-sm text-muted">Smart protection for every call, text, and message</p>
        </div>
        <div className="ml-auto flex gap-2">
          <a href="/guardian/contacts" className="rounded-xl border border-border px-3 py-1.5 text-xs font-medium hover:bg-surface transition">Contacts</a>
          <a href="/guardian/rules" className="rounded-xl border border-border px-3 py-1.5 text-xs font-medium hover:bg-surface transition">Rules</a>
          <a href="/guardian/settings" className="rounded-xl border border-border px-3 py-1.5 text-xs font-medium hover:bg-surface transition">Settings</a>
        </div>
      </div>

      <GuardianDashboard
        recentComms={(recentComms ?? []) as unknown as Parameters<typeof GuardianDashboard>[0]['recentComms']}
        suggestions={(suggestions ?? []) as unknown as Parameters<typeof GuardianDashboard>[0]['suggestions']}
        escalations={(escalations ?? []) as unknown as Parameters<typeof GuardianDashboard>[0]['escalations']}
        memberProfiles={(memberProfiles ?? []) as unknown as Parameters<typeof GuardianDashboard>[0]['memberProfiles']}
        stats={{
          totalCalls: totalCalls ?? 0,
          blockedToday: blockedToday ?? 0,
          scamsBlocked: scamsBlocked ?? 0,
          screened: screened ?? 0,
        }}
        isTwilioConfigured={isTwilioConfigured()}
      />
    </div>
  );
}
