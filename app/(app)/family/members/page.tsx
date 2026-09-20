import type { Metadata } from 'next';
import Link from 'next/link';
import { UsersRound, Settings, Cake } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { isManager, ROLE_LABELS, type MemberRole } from '@/lib/constants/roles';
import { PageHeader } from '@/components/app/page-header';
import { SectionCard, MiniEmpty } from '@/components/family/shell';
import { Avatar } from '@/components/ui/avatar';
import { fmtDate } from '@/lib/utils/format';
import { getTranslations } from '@/lib/i18n/server';
import { PartialReadBanner } from '@/components/ui/partial-read-banner';
import { describeReadError } from '@/lib/supabase/settle';

export const metadata: Metadata = { title: 'Family Members' };
export const dynamic = 'force-dynamic';

export default async function FamilyMembersPage() {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const manager = isManager(ctx.active.role);

  // "No members yet" for a household of five is the most alarming false empty
  // in the set — it is the whole content of this page, under a heading that
  // still names the family. Nothing destructive is reachable from here (the one
  // interactive element is a link gated on `ctx.active.role`, not on this read),
  // so the page still renders and simply says what is missing. Audit C1-S9-27.
  const { data: members, error: membersError } = await supabase
    .from('family_members')
    .select('*')
    .eq('family_id', ctx.active.familyId)
    .eq('is_active', true)
    .order('created_at');
  const readFailures = membersError ? [`family_members: ${describeReadError(membersError)}`] : [];

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('familyMembers.familyMembers')}
        description={`Everyone in ${ctx.active.family.name}.`}
        action={manager ? (
          <Link href="/dashboard/settings#members" className="inline-flex items-center gap-1.5 rounded-xl bg-brand px-3.5 py-2 text-sm font-semibold text-white">
            <Settings className="h-4 w-4" /> {t('familyMembers.manageInvite')}
          </Link>
        ) : undefined}
      />

      <PartialReadBanner title={t('shared.someInformationCouldNotBeLoaded')} failures={readFailures} />

      <SectionCard title={t('familyMembers.members')}>
        {members && members.length > 0 ? (
          <ul className="grid max-h-[40rem] gap-3 overflow-y-auto sm:grid-cols-2">
            {members.map((m) => (
              <li key={m.id} className="flex items-center gap-3 rounded-xl border border-border bg-surface/40 p-3">
                <Avatar name={m.display_name} color={m.color} size={44} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{m.display_name}{m.user_id === ctx.user.id && <span className="ml-1 text-xs text-muted">(you)</span>}</p>
                  <p className="text-xs text-muted">{ROLE_LABELS[m.role as MemberRole] ?? m.role}</p>
                  {m.birthday && <p className="mt-0.5 inline-flex items-center gap-1 text-xs text-muted"><Cake className="h-3 w-3" /> {fmtDate(m.birthday, 'MMM d')}</p>}
                </div>
              </li>
            ))}
          </ul>
        ) : <MiniEmpty icon={UsersRound} text={t('members.noMembersYet')} />}
      </SectionCard>
    </div>
  );
}
