import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { withGuardianTables } from '@/lib/supabase/guardian-tables';
import { RoutingSettings } from '@/components/guardian/routing-settings';
import { GuardianNumberForm } from '@/components/guardian/guardian-number-form';
import { Settings, ArrowLeft } from 'lucide-react';
import { isTwilioConfigured } from '@/lib/guardian/twilio';

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
  const guardianPhone = (profile as { guardian_phone?: string } | null)?.guardian_phone ?? null;

  return (
    <div className="mx-auto max-w-2xl space-y-6 px-4 py-6">
      <div className="flex items-center gap-3">
        <a href="/guardian" className="rounded-lg p-1.5 text-muted hover:bg-surface transition">
          <ArrowLeft className="h-5 w-5" />
        </a>
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand/15">
          <Settings className="h-5 w-5 text-brand-text" />
        </div>
        <div>
          <h1 className="text-xl font-bold leading-tight">Guardian Settings</h1>
          <p className="text-sm text-muted">For {(member as { display_name?: string } | null)?.display_name ?? 'you'}</p>
        </div>
      </div>

      {/* Guardian number — self-serve assignment */}
      <GuardianNumberForm
        memberId={memberId}
        initialPhone={guardianPhone}
        twilioEnabled={twilioEnabled}
      />

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
