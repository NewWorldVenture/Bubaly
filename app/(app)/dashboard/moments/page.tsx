import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { MomentsView } from '@/components/moments/moments-view';
export const metadata: Metadata = { title: 'Moments' };
export default async function Page() { await requireUserContext(); return <MomentsView />; }
