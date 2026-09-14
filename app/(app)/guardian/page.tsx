import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { describeReadError, settleAll } from '@/lib/supabase/settle';
import { PartialReadBanner } from '@/components/ui/partial-read-banner';
import { withGuardianTables } from '@/lib/supabase/guardian-tables';
import { isTwilioConfigured } from '@/lib/guardian/twilio';
import { GuardianDashboard } from '@/components/guardian/guardian-dashboard';
import { Shield } from 'lucide-react';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'AI Call Guardian · Bubaly' };
export const dynamic = 'force-dynamic';

export default async function GuardianPage() {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();
  const db = withGuardianTables(supabase);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const gFrom = (table: Parameters<typeof db.from>[0]) => (db.from(table) as ReturnType<typeof supabase.from>);

  // Every one of these eight is read for its error as well as its data. This is
  // the safety dashboard: it renders "0 scams stopped" and "0 blocked" from
  // `count ?? 0`, and a failed read produced exactly those numbers over a log
  // that may be full of blocked scam calls. `lib/ui/partial-read-banner.tsx` puts
  // it best — a zero that means "we could not check" must never be mistaken for
  // an all-clear. settleAll rather than Promise.all so a transport rejection
  // arrives as { data: null, error } instead of taking the page to
  // app/(app)/guardian/error.tsx.
  const [
    { data: recentComms, error: commsError },
    { data: suggestions, error: suggestionsError },
    { data: escalations, error: escalationsError },
    { data: memberProfiles, error: profilesError },
    { count: totalCalls, error: totalCallsError },
    { count: blockedToday, error: blockedTodayError },
    { count: scamsBlocked, error: scamsBlockedError },
    { count: screened, error: screenedError },
  ] = await settleAll([
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

  // Named individually, because on production the answer is usually one table
  // the migration ledger has not reached — "something failed" would not say which.
  const readFailures = ([
    ['recent calls and messages', commsError],
    ['suggestions', suggestionsError],
    ['escalations', escalationsError],
    ['member profiles', profilesError],
    ['calls today', totalCallsError],
    ['blocked today', blockedTodayError],
    ['scams stopped', scamsBlockedError],
    ['AI screened', screenedError],
  ] as const)
    .filter(([, error]) => error)
    .map(([label, error]) => `${label}: ${describeReadError(error)}`);

  // A count whose read failed is `null`, never 0 — the tile renders an em dash.
  const countOf = (count: number | null, error: unknown) => (error ? null : count ?? 0);

  return (
    <div className="mx-auto max-w-2xl space-y-6 px-4 py-6">
      <div className="flex items-start gap-3">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand/15">
          <Shield className="h-5 w-5 text-brand-text" />
        </div>
        <div>
          <h1 className="text-xl font-bold leading-tight">{t('guardian.aiCallGuardian')}</h1>
          <p className="text-sm text-muted">{t('guardian.smartProtectionForEveryCallText')}</p>
        </div>
        <div className="ml-auto flex gap-2">
          <a href="/guardian/contacts" className="rounded-xl border border-border px-3 py-1.5 text-xs font-medium hover:bg-surface transition">{t('guardian.contacts')}</a>
          <a href="/guardian/rules" className="rounded-xl border border-border px-3 py-1.5 text-xs font-medium hover:bg-surface transition">{t('guardian.rules')}</a>
          <a href="/guardian/settings" className="rounded-xl border border-border px-3 py-1.5 text-xs font-medium hover:bg-surface transition">{t('guardian.settings')}</a>
        </div>
      </div>

      <PartialReadBanner
        title={t('guardian.someOfThisScreenCouldNotBeLoaded')}
        failures={readFailures}
      />

      <GuardianDashboard
        recentComms={(recentComms ?? []) as unknown as Parameters<typeof GuardianDashboard>[0]['recentComms']}
        suggestions={(suggestions ?? []) as unknown as Parameters<typeof GuardianDashboard>[0]['suggestions']}
        escalations={(escalations ?? []) as unknown as Parameters<typeof GuardianDashboard>[0]['escalations']}
        memberProfiles={(memberProfiles ?? []) as unknown as Parameters<typeof GuardianDashboard>[0]['memberProfiles']}
        stats={{
          totalCalls: countOf(totalCalls, totalCallsError),
          blockedToday: countOf(blockedToday, blockedTodayError),
          scamsBlocked: countOf(scamsBlocked, scamsBlockedError),
          screened: countOf(screened, screenedError),
        }}
        isTwilioConfigured={isTwilioConfigured()}
      />
    </div>
  );
}
