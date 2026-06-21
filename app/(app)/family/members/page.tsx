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

export const metadata: Metadata = { title: 'Family Members' };
export const dynamic = 'force-dynamic';

export default async function FamilyMembersPage() {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const manager = isManager(ctx.active.role);

  const { data: members } = await supabase
    .from('family_members')
    .select('*')
    .eq('family_id', ctx.active.familyId)
    .eq('is_active', true)
    .order('created_at');

  return (
    <div className="space-y-5">
      <PageHeader
        title="Family Members"
        description={`Everyone in ${ctx.active.family.name}.`}
        action={manager ? (
          <Link href="/dashboard/settings#members" className="inline-flex items-center gap-1.5 rounded-xl bg-brand px-3.5 py-2 text-sm font-semibold text-white">
            <Settings className="h-4 w-4" /> Manage & invite
          </Link>
        ) : undefined}
      />

      <SectionCard title="Members">
        {members && members.length > 0 ? (
          <ul className="grid gap-3 sm:grid-cols-2">
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
        ) : <MiniEmpty icon={UsersRound} text="No members yet." />}
      </SectionCard>
    </div>
  );
}
