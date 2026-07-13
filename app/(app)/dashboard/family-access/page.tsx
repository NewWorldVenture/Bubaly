import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { KeyRound } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { isManager } from '@/lib/constants/roles';
import { ChildAccessManager, type AccessMember } from '@/components/family/child-access-manager';

export const metadata: Metadata = { title: 'Kid Logins' };
export const dynamic = 'force-dynamic';

export default async function FamilyAccessPage() {
  const ctx = await requireUserContext();
  // Managing logins is a parent/guardian task.
  if (!isManager(ctx.active.role)) redirect('/home');

  const supabase = await createServer();
  const familyId = ctx.active.familyId;

  const [{ data: members }, { data: logins }] = await Promise.all([
    supabase.from('family_members').select('id, display_name, role, color, user_id')
      .eq('family_id', familyId).eq('is_active', true).order('created_at'),
    supabase.from('child_logins').select('member_id, username').eq('family_id', familyId),
  ]);

  const usernameByMember = new Map((logins ?? []).map((l) => [l.member_id, l.username]));

  // Show: members who already have a kid login (→ reset PIN), and managed members
  // with no login yet (user_id null → can be given one). Members who signed up
  // with their own email (user_id set, no child login) manage their own password.
  const list: AccessMember[] = (members ?? [])
    .filter((m) => usernameByMember.has(m.id) || m.user_id === null)
    .map((m) => ({
      id: m.id, display_name: m.display_name, role: m.role, color: m.color,
      username: usernameByMember.get(m.id) ?? null,
    }));

  const configured = !!process.env.CHILD_LOGIN_SECRET;

  return (
    <div className="mx-auto max-w-2xl space-y-6 pb-28">
      <div className="flex items-center gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-brand/15 text-brand-text"><KeyRound className="h-6 w-6" /></span>
        <div>
          <h1 className="text-2xl font-black tracking-tight">Kid Logins</h1>
          <p className="mt-0.5 text-sm text-muted">Give a child their own sign-in — a username and 4-digit PIN, no email required.</p>
        </div>
      </div>

      <ChildAccessManager members={list} configured={configured} />

      <div className="rounded-2xl border border-border bg-surface/40 p-4 text-sm text-muted">
        <p className="font-semibold text-fg">How it works</p>
        <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs">
          <li>Create a username + PIN for your child above.</li>
          <li>They go to <span className="font-semibold text-fg">bubaly.com/kid-login</span> and enter it — no email needed.</li>
          <li>They land in their own Bubaly with their chores, rewards and family.</li>
          <li>Forgot the PIN? Reset it here anytime.</li>
        </ol>
      </div>
    </div>
  );
}
