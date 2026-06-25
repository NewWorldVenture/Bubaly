import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { withGuardianTables } from '@/lib/supabase/guardian-tables';
import { RoutingSettings } from '@/components/guardian/routing-settings';
import { Settings, ArrowLeft } from 'lucide-react';
import { isTwilioConfigured, formatPhone } from '@/lib/guardian/twilio';

export const metadata: Metadata = { title: 'Settings · AI Call Guardian · Bubaly' };
export const dynamic = 'force-dynamic';

export default async function GuardianSettingsPage() {
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const memberId = ctx.active.member.id;
  const supabase = await createServer();
  const db = withGuardianTables(supabase);

  const [{ data: profile }, { data: member }] = await Promise.all([
    (db.from('guardian_member_profiles') as ReturnType<typeof supabase.from>)
      .select('*')
      .eq('family_id', familyId)
      .eq('member_id', memberId)
      .maybeSingle(),

    supabase
      .from('family_members')
      .select('id, display_name')
      .eq('id', memberId)
      .maybeSingle(),
  ]);

  const twilioEnabled = isTwilioConfigured();
  const guardianPhone = (profile as { guardian_phone?: string } | null)?.guardian_phone;

  return (
    <div className="mx-auto max-w-2xl space-y-6 px-4 py-6">
      <div className="flex items-center gap-3">
        <a href="/guardian" className="rounded-lg p-1.5 text-muted hover:bg-surface transition">
          <ArrowLeft className="h-5 w-5" />
        </a>
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand/15">
          <Settings className="h-5 w-5 text-brand" />
        </div>
        <div>
          <h1 className="text-xl font-bold leading-tight">Guardian Settings</h1>
          <p className="text-sm text-muted">For {(member as { display_name?: string } | null)?.display_name ?? 'you'}</p>
        </div>
      </div>

      {/* Phone number info */}
      <div className="rounded-2xl border border-border bg-surface/40 p-4 space-y-2">
        <h3 className="text-sm font-semibold">Your Guardian Number</h3>
        {twilioEnabled && guardianPhone ? (
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-emerald-500/10 text-lg">📞</div>
            <div>
              <p className="text-lg font-bold text-emerald-400">{formatPhone(guardianPhone)}</p>
              <p className="text-xs text-muted">Share this number — Bubaly answers for you</p>
            </div>
          </div>
        ) : !twilioEnabled ? (
          <p className="text-sm text-muted">
            Set up Twilio (<code className="rounded bg-elevated px-1 text-xs">TWILIO_ACCOUNT_SID</code>,{' '}
            <code className="rounded bg-elevated px-1 text-xs">TWILIO_AUTH_TOKEN</code>,{' '}
            <code className="rounded bg-elevated px-1 text-xs">TWILIO_PHONE_NUMBER</code>) to get a Guardian number.
          </p>
        ) : (
          <p className="text-sm text-muted">
            No Guardian number assigned yet. Contact support to assign a Twilio number to your profile.
          </p>
        )}
      </div>

      {/* ENV vars checklist */}
      <div className="rounded-2xl border border-border bg-surface/40 p-4 space-y-2">
        <h3 className="text-sm font-semibold">Configuration</h3>
        <div className="space-y-1.5">
          {[
            { key: 'TWILIO_ACCOUNT_SID', set: !!process.env.TWILIO_ACCOUNT_SID },
            { key: 'TWILIO_AUTH_TOKEN', set: !!process.env.TWILIO_AUTH_TOKEN },
            { key: 'TWILIO_PHONE_NUMBER', set: !!process.env.TWILIO_PHONE_NUMBER },
            { key: 'ANTHROPIC_API_KEY or OPENAI_API_KEY', set: !!(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY) },
          ].map((item) => (
            <div key={item.key} className="flex items-center gap-2 text-xs">
              <span className={item.set ? 'text-emerald-400' : 'text-red-400'}>{item.set ? '✓' : '✗'}</span>
              <code className="text-muted">{item.key}</code>
            </div>
          ))}
        </div>
        <p className="text-xs text-muted pt-1">
          Twilio routes calls to Bubaly. An AI key (Anthropic or OpenAI) powers the screening conversations.
        </p>
      </div>

      <RoutingSettings
        profile={profile as unknown as Parameters<typeof RoutingSettings>[0]['profile']}
        member={{ id: memberId, display_name: (member as { display_name?: string } | null)?.display_name ?? 'You' }}
      />
    </div>
  );
}
