import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { settleAll } from '@/lib/supabase/settle';
import { createServer } from '@/lib/supabase/server';
import { withGuardianTables } from '@/lib/supabase/guardian-tables';
import { RoutingSettings } from '@/components/guardian/routing-settings';
import { GuardianNumberForm } from '@/components/guardian/guardian-number-form';
import { ErrorState } from '@/components/ui/states';
import type { RoutingProfile, RoutingProfileSource } from '@/lib/guardian/routing-form';
import { Settings, ArrowLeft } from 'lucide-react';
import { isTwilioConfigured } from '@/lib/guardian/twilio';
import { getTranslations } from '@/lib/i18n/server';

export const metadata: Metadata = { title: 'Settings · AI Call Guardian · Bubaly' };
export const dynamic = 'force-dynamic';

export default async function GuardianSettingsPage() {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const memberId = ctx.active.member.id;
  const supabase = await createServer();
  const db = withGuardianTables(supabase);

  // settleAll, not Promise.all: a transport failure REJECTS rather than
  // resolving with { error }, so one unreachable table used to take the whole
  // page to the error boundary instead of to the branch below.
  const [{ data: profile, error: profileError }, { data: member }] = await settleAll([
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
  const memberName = (member as { display_name?: string } | null)?.display_name ?? null;

  const Header = () => (
    <div className="flex items-center gap-3">
      <a href="/guardian" className="rounded-lg p-1.5 text-muted hover:bg-surface transition">
        <ArrowLeft className="h-5 w-5" />
      </a>
      <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand/15">
        <Settings className="h-5 w-5 text-brand-text" />
      </div>
      <div>
        <h1 className="text-xl font-bold leading-tight">{t('guardianSettings.guardianSettings')}</h1>
        <p className="text-sm text-muted">For {memberName ?? 'you'}</p>
      </div>
    </div>
  );

  // A failed profile read is not a member without a profile, and the difference
  // is the whole page. Dropping the error rendered every form below seeded from
  // the factory defaults — an unassigned guardian number and the default routing
  // — and Save then upserted those defaults over the family's real settings. So
  // say the read failed and render nothing that can be saved.
  if (profileError) {
    console.error('[guardian/settings] guardian_member_profiles read failed', { familyId, memberId, error: profileError });
    return (
      <div className="mx-auto max-w-2xl space-y-6 px-4 py-6">
        <Header />
        <ErrorState message={t('guardianSettings.couldnTLoadYourGuardianSettings')} />
      </div>
    );
  }

  const profileSource: RoutingProfileSource = profile
    ? { status: 'ok', profile: profile as unknown as RoutingProfile }
    : { status: 'absent' };

  return (
    <div className="mx-auto max-w-2xl space-y-6 px-4 py-6">
      <Header />

      {/* Guardian number — self-serve assignment */}
      <GuardianNumberForm
        memberId={memberId}
        initialPhone={guardianPhone}
        twilioEnabled={twilioEnabled}
      />

      {/* ENV vars checklist */}
      <div className="rounded-2xl border border-border bg-surface/40 p-4 space-y-2">
        <h3 className="text-sm font-semibold">{t('guardianSettings.configuration')}</h3>
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
          {t('guardianSettings.twilioRoutesCallsToBubalyAn')}
        </p>
      </div>

      <RoutingSettings
        profile={profileSource}
        member={{ id: memberId, display_name: memberName ?? 'You' }}
      />
    </div>
  );
}
