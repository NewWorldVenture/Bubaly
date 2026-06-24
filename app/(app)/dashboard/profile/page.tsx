import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { ProfileModule } from '@/components/modules/profile-module';

export const metadata: Metadata = { title: 'Profile' };

export default async function ProfilePage() {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const { data: member } = await supabase
    .from('family_members')
    .select('*')
    .eq('id', ctx.active.member.id)
    .maybeSingle();
  return <ProfileModule member={member ?? ctx.active.member} userId={ctx.user.id} userEmail={ctx.user.email ?? ''} />;
}
